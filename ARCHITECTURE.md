# Byte Budget — architecture and invariants

The reference document. Facts here stay true across sessions: what the browser will
and will not tell an extension, where each thing lives, and the rules that are not
enforced by the compiler.

What is *currently* true — baselines, what was last verified, what is still open —
lives in `STATE.md`. What changed and when lives in `CHANGELOG.md`. What the product
does for a user lives in `README.md`. If two of these answer the same question, one of
them is wrong; this one is authoritative for design, `STATE.md` for status.

Source comments cite this file by section anchor (`ARCHITECTURE.md#measurement`).
Those citations are load-bearing — the reasoning is here rather than repeated at
fifteen call sites. If you move a section, fix the references.

---

## Measurement

**Chrome does not tell an extension how big a response was.** `webRequest` reports
that a request finished, its type, its tab and its headers. There is no byte count in
any of it. Everything the product claims rests on how that gap is filled, so it is
filled from three sources in a fixed order of preference, and the UI says how much
came from the last one.

| # | Source | Covers | Fails on |
| --- | --- | --- | --- |
| 1 | `Content-Length` on the response | Anything that declares a length. Exact, and post-compression, which is what crossed the wire. Unaffected by CORS. | Chunked and streamed bodies — most HTML and a lot of video — declare none. |
| 2 | `PerformanceResourceTiming.transferSize`, reported by a content script | The streamed responses source 1 cannot see. | Returns 0 for a cross-origin response without `Timing-Allow-Origin`, which is a large fraction of third-party traffic. |
| 3 | A learned mean per `host\|type` | Everything left, and every request a rule *refused*, which never had a size at all. | It is a model. This is the part the UI discloses. |

`estimatedDown` carries the source-3 portion of every total, end to end, and
`measuredShare` in `core/types.ts` is `1 - estimatedDown / down`. The percentage on
screen is computed from the ledger, never asserted.

### Reconciliation

A response with no `Content-Length` is *parked* rather than guessed at: source 2
arrives later, from the page, in batches. `track/reconcile.ts` holds it for
`PENDING_TTL_MS` (8 s) against a worker Chrome tears down after thirty idle seconds,
capped at `MAX_PENDING` (600) live entries. If a timing arrives, the entry is settled
with the real size and the model is trained on it. If the TTL expires first, it is
committed with the model's estimate and marked estimated.

**`transferSize` is header-inclusive by definition, and the model is trained on
header-inclusive sizes, so an estimate replaces the header bytes rather than adding to
them.** `commitEstimate` once added, and every estimated request in the product was
inflated by one halved header block. The measured header block is kept as a floor.

### The size model

`track/estimate.ts`. A running arithmetic mean per `host|type` with a per-type default
in front of it, capped at `MAX_WEIGHT` samples so a well-observed key tracks rather
than settles.

Two clamps, and they are different on purpose:

- **A cold key's first sample** is held within `FIRST_SAMPLE_RATIO` (32×) of the
  per-type prior. Without it one unrepresentative response — a `HEAD` probe against a
  60 MB file, a redirect, an error page — defined the key permanently, and that number
  then priced every refused request and every cache hit on the host.
- **Every sample after that** is winsorised against the running mean at
  `OUTLIER_RATIO` (8×). The *sample* is pulled back, not the mean's weight. The first
  attempt did it the other way round, and one 40 MB video segment moved an 8 kB API
  host's mean to 3.6 MB — a 450× jump from a single request.

The band is wide because the default is an order-of-magnitude prior rather than a
measurement. A host that genuinely serves 1 MB images against a 45 kB `image` default
has to be believed.

### What the number does not cover, and cannot

- **One Chrome profile.** A second profile, another browser, native apps, OS and app
  updates, and every other device on the same hotspot are invisible to an extension.
  There is no API that would show them. The total can sit well below a carrier's.
- **`Cookie` and `Set-Cookie` headers count as zero.** `extraHeaders` would fix it and
  moves every request onto a slower path through Chrome's network stack. The trade
  stands; what matters is that the documents say the input set is incomplete *before*
  the halving, rather than implying halving is the only source of error.
- **Header bytes are counted from names and values and then halved**, as an
  approximation of compression. Header-inclusive is the convention throughout; nothing
  may add a header block to a figure that already contains one.

## Attribution

**Bytes belong to the page load, not to the tab, and not to the request host.**

A CDN is not a website you visited, so a subresource is attributed to the site the tab
is showing. Hosts are kept separately for the drill-down. `track/tabs.ts` owns the
mapping; a top-level document is attributed from its own URL, a tabless request from
the origin that asked for it.

`CommitEntry.visitId` is captured **when the request is priced** and must stay that
way. Resolving the tab's *current* visit at commit time is wrong by up to the parked
TTL, and it moves bytes onto the next page's row while leaving the period totals —
keyed by site — looking correct. That is the worst available failure mode: `visits` is
the only input to the optimizer's on-versus-off comparison, so the error correlates
with the variable being measured.

## Enforcement

MV3 cannot pace a request. `declarativeNetRequest` blocks, redirects and rewrites
headers, and has no rate control. What it *can* do is refuse a request before it is
dispatched, which costs exactly zero bytes rather than "bytes we noticed afterwards" —
and that is what makes a byte budget enforceable rather than advisory.

So the lever is *which kinds* of request are allowed. `limit/tiers.ts` defines a single
shed order, heaviest first, and each tier is a prefix of it — which is what makes the
tiers a slope rather than four unrelated settings.

`main_frame` is in **no** tier. Blocking the document gives Chrome's error page, which
reads as a broken site; letting the shell load means the page can still say what
happened.

The governor (`limit/governor.ts`) keeps a live byte count per budgeted site in memory,
primed from the database once and incremented synchronously afterwards. It is
deliberately not re-read from rows: rows lag the traffic by the flush debounce, so a
check against them would let a site sail past its cap for two seconds.

### What enforcement cannot do, stated in the UI

- **A cap is not a rate.** `trim` and `lean` are step changes; a player's own bitrate
  logic is what turns them into something that behaves like a rate. The UI must not
  imply a dial.
- **Overshoot is bounded but not zero.** Requests already in flight when a threshold is
  crossed cannot be recalled, and rules take a moment to install. On video that is one
  or two segments — single-digit MB at 1080p. The guard band arms early to shrink it.
- **A single large non-range response cannot be stopped once dispatched.** No extension
  API cancels a response mid-body. A 60 MB download with no range requests will
  overshoot by up to 60 MB. Most large transfers are range-based, but this is a real
  hole and is said out loud rather than discovered.
- **Blocking is visible.** A refused media request makes a player error rather than
  degrade. Tier order and the in-page notice are what keep that from reading as a bug.

### Alerts

`limit/alerts.ts` fires at 75%, 90% and 100% of an allowance — before it is spent, which
is the point. Three thresholds and no stream: one alert per threshold per window, only
the highest when several are crossed at once, per-site alerts off by default, and a
record of what has been said that outlives the worker.

What it sends is a **measurement**. `core/forecast.ts` is not imported there and must
not be. A modelled number arriving with an interruption's urgency is the hardest kind
for a reader to question, and the dashboard is where a projection can stand beside its
basis.

## Optimizing, and what a saving means

Three sources of saving, and they are never handed over merged:

1. **A visit delta** — the same site measured with optimizers on and off. Measured.
2. **A rewrite** — the original variant's size on file, minus the smaller one. Measured.
3. **A block** — the bytes a refused request would have cost. Modelled, from the size
   model, because there is no other source for the weight of something that never
   happened.

`savedMeasured` and `savedModelled` are two named fields on the report and stay two.
A surface given one number renders one number, and no amount of prose beside it undoes
that.

The visit delta rests on a **holdout**: a fraction of loads run with optimizers off, on
purpose, so there is a control arm. It is on by default, disclosed, and switchable —
off is one of the options. A savings number with no control group is a marketing
number. The comparison is trimmed means with a 95% interval, and a site whose interval
covers zero is **not reported**. The cost of that is real: the first measured saving
for a site takes a day or two longer to appear, and some sites never produce one. Both
look like the feature working less well. They are the feature working.

### The preload scanner

**A content script cannot beat Chrome's preload scanner.** Media and images in the
initial HTML can be discovered by the parser before an async settings lookup resolves.
This has cost the project twice — once for the image features, once for `dropHints`,
whose smoke check asserted the *network* outcome and passed on the winning side of a
race for as long as it kept winning.

Assert what the script did to the document; report what the network did. Do not
promise that every initial media request is blocked.

## Why there are two build channels

`chrome.debugger` plus `Network.emulateNetworkConditions` is the one API that can
genuinely cap a tab's throughput — a real ceiling, which a page's adaptive-bitrate
logic responds to the way it would to a slow connection.

Chrome does not allow `debugger` as an optional permission, so it cannot be requested
at runtime from the people who want it; it would be an install warning for everyone.
And attaching shows Chrome's "an extension is debugging this browser" banner, which
cannot be suppressed and should not be.

Hence two channels. `dist/` is published and compiles the throttle code out entirely
via the `__THROTTLE_BUILD__` literal, rather than shipping a branch that can never be
taken. `dist-throttle/` declares the permission. `scripts/package.mjs` fails if the
wrong one carries it.

---

## Navigation map

One line per meaningful file: what it owns, and what will surprise you.

### Tracking — `src/track/`

```
requests.ts    The webRequest listeners. The only source that sees every request,
               including ones no page can observe. Prices from Content-Length here.
reconcile.ts   The parked-request queue. Owns its own sweep timer AND drains on
               onSuspend — the maintenance alarm cannot substitute, it wakes a
               fresh worker with an empty queue.
estimate.ts    The size model. Two different clamps (see Measurement); the cold-key
               one is wider than the outlier one on purpose.
ledger.ts      Buffers, swap-flush, IndexedDB writes. A rejected write folds its
               deltas back into the live buffer; the failure surfaces as
               lastFlushError on the dashboard rather than vanishing.
tabs.ts        Tab-to-site mapping and visit lifecycle. Mirrored to storage.session.
stats.ts       Every aggregation the UI reads, plus CSV/JSON export.
wire.ts        Where the listeners are attached.
```

### Limits — `src/limit/`

```
budgets.ts     Budget records. In chrome.storage.local, NOT sync — a budget names a
               site, and site names never leave the device. Migrates old sync rows.
governor.ts    Live counters, threshold crossing, rule installation. Counters are
               never re-read from rows; see Enforcement.
tiers.ts       The shed order. Each tier is a prefix of one list.
enforce.ts     Session-scoped DNR rules and the decision map. ensureEnforcementReady
               republishes the rules before it resolves — restoring the map is not
               bookkeeping, it is what the rules are rebuilt from.
rules.ts       Rule construction, scoped by tabIds and initiatorDomains.
alerts.ts      75/90/100% thresholds. Must not import core/forecast.ts.
notify.ts      The in-page notice.
throttle.ts    chrome.debugger throttling. Compiled out of the store build.
```

### Optimizing — `src/optimize/`

```
packs.ts       The image-service rewrite patterns. Five properties per pack, none of
               them visible from reading the regex — see tests/packs.test.mjs.
rules.ts       DNR rules for packs, Save-Data and beacons. Case sensitivity is set
               explicitly, because Chrome's default disagrees with JS RegExp.
features.ts    The page-side feature set and its levels.
holdout.ts     Control-arm selection and visit accounting.
savings.ts     Trimmed means, the interval, the baseline store (SHA-256 digests).
report.ts      Assembles the report. savedModelled is clamped, not trusted.
apply.ts       Installs and removes everything above.
```

### Paid tier — `src/plus/`

```
tier.ts        What free allows and Plus unlocks. Depends on no payment provider, so
               every surface can ASK a question without being able to ANSWER one.
gate.ts        The only module that talks to a payment provider. Service worker only.
provider.ts    A deliberately small ExtensionPay client — keeps an opaque key and a
               reduced status, never the account response.
plans.ts       Prices, trial length, refresh interval. Display strings only.
lock.ts        The lock affordance. A lock is the disabled attribute.
rules.ts       The permanent guard allow-rule at priority 4, above limits.
```

### Core and surfaces

```
core/types.ts     Shared shapes, measuredShare, RETENTION_OPTIONS.
core/db.ts        The hand-written IndexedDB wrapper. No runtime dependencies.
core/messages.ts  The worker/surface protocol.
core/forecast.ts  Pure and clockless. Refuses to answer below five finished days and
                  returns a plain-English basis the caller cannot render without.
core/period.ts    Period arithmetic and the messages that describe one.
core/i18n.ts      t(). Returns the KEY when chrome.i18n is absent — see invariant 12.
popup.ts          The toolbar surface.
dashboard.ts      Report only. No settings.
settings.ts       Every control.
welcome.ts        First run.
content/timing.ts The resource-timing reporter — source 2 of the measurement.
```

### Build and verification

```
vite.config.ts     Both channels, the locale merge, the manifest rewrite, and the
                   assert-classic-scripts check that keeps content scripts importless.
scripts/smoke.mjs  The real-Chromium suite. Refuses to run against a dist/ older
                   than src/ — a stale build invalidates every conclusion silently.
scripts/package.mjs Store archive. Fails on a placeholder or the wrong permission set.
tests/docs.test.mjs Asserts the documentation still describes the code.
i18n/*.json        The message source. _locales/ is generated; never edit it.
```

### Task-to-file index

```
Change what a byte figure means?    track/requests.ts → track/reconcile.ts →
                                    track/estimate.ts, then re-read Measurement above.
Add an enforcement behaviour?       limit/tiers.ts (shed order) → limit/rules.ts →
                                    limit/governor.ts. Check the priority gap holds.
Add an image pack?                  optimize/packs.ts AND tests/packs.test.mjs AND
                                    the host list in PRIVACY_POLICY.md — the policy
                                    says "no other host is ever rewritten", and
                                    tests/docs.test.mjs enforces that.
Add a permission?                   public/manifest.json AND PRIVACY_POLICY.md AND
                                    STORE_LISTING.md. tests/docs.test.mjs fails
                                    otherwise, which is the point.
Add a user-visible string?          i18n/<surface>.json. Never _locales/.
Gate something behind Plus?         plus/tier.ts only. Read invariants 8-11 first.
Change a price or the trial?        plus/plans.ts AND the ExtensionPay dashboard.
                                    The constants are display strings; they cannot
                                    set a price.
```

---

## Invariants

Rules not enforced by tooling, where breaking them produces something that looks
correct in a diff. Each has its reason attached, because a bare rule gets either
blindly obeyed or silently ignored.

1. **Bytes belong to a page load, not a tab.** `CommitEntry.visitId` is captured at
   pricing time. See Attribution for what breaks — it is the failure whose error
   correlates with the thing being measured.

2. **Nothing sits in the parked queue without a timer of its own.** It is module state
   in a worker that dies after thirty idle seconds. `scheduleSweep` and the `onSuspend`
   drain are both load-bearing; between them missing, the last streamed request on
   every page was lost.

3. **Anything `CLEAR_DATA` clears on disk must clear in memory too.** The worker holds
   long-lived copies — session totals, open visits, the size model — and every one has
   written deleted data straight back at least once. The size model is keyed by
   hostname, so this is a privacy property, not only an arithmetic one.

4. **A read in flight across a destructive action is the normal case.** `resetSession`'s
   epoch guard exists because of it. Any new cached read of user data needs the same.

5. **A limit's refusal outranks an optimizer's rewrite.** They publish to the same rule
   set and Chrome selects by priority before applying block-over-redirect. A test pins
   `min(limit) > max(optimize)`. The failure it prevents had already shipped: a hard cap
   that went on spending bytes through exactly the five CDNs the optimizer knows how to
   rewrite.

6. **A plan is not a budget, and a budget is not an alert.** `settings.planBytes` on its
   own produces neither, so every flow that captures a plan writes the matching
   `ALL_SITES` budget in the same breath.

7. **A notification carries a measurement, never a projection.** See Alerts.

8. **Do not gate a disclosure.** The accuracy figure, the measured-versus-modelled
   split, the projection's basis, the scope admission and the privacy statement are free
   forever. A figure a person cannot audit is not a teaser for a better figure; it is a
   worse figure, and this product's whole argument is that it does not ship those.

9. **A paid ceiling limits what can be added or changed, never what already exists.** A
   lapse leaves every configured limit running and editable. The failure it prevents is
   a billing event silently deleting something a person relied on.

10. **A lock is the `disabled` attribute.** CSS may *show* a lock; it may not *be* one.
    `pointer-events: none` leaves Tab and Space working, and in a segmented control
    arrow keys activate as well as move.

11. **Retention is a deletion control and stays free.** Gate the reporting window
    instead — `FREE_REPORT_DAYS` bounds what is drawn, never what is kept.

12. **Nothing outside the service worker imports `plus/gate.ts`.** It is the only module
    that can reach a network, and that is what makes the privacy claim checkable rather
    than promised.

13. **A test that runs without `chrome` asserts `t()`'s fallback unless you give it a
    catalogue.** `core/i18n.ts` returns the key by design, so an assertion against a
    translated string passes against `coreChartEverythingElse` just as happily as
    against "Everything else". `tests/chart.test.mjs` stubs the API over the real
    `i18n/core.json`. Any new test asserting user-facing text needs the same, or it
    pins nothing.

14. **Do not assert a network outcome for a DOM-level optimization.** See The preload
    scanner.

15. **Content scripts import nothing and are idempotent.** Both are enforced — the first
    by `assert-classic-scripts` in the Vite config, the second by a marker on `window`.

16. **Upload bytes come from request headers, never from `requestBody`.** The body is
    what the user typed.

17. **An empty state is a state, and it is the one every user sees first.** Four findings
    in one pass were on a surface reviewed a dozen times, invisible because every review
    had data behind it. Load `dist/` into a fresh profile and look at it with nothing
    recorded before shipping a surface change — and check the panels come *back*.

18. **Do not edit generated output.** `dist/`, `dist-throttle/`, the root
    `manifest.json` and `_locales/` are all built. Edit the source and rebuild.

## Traps

**Looks wrong, is correct:**

- **`measuredShare` returns 1 for an empty total.** An empty period is fully measured,
  not zero-confidence. Do not "fix" this in `measuredShare` — the callers that should
  not print a pill on a fresh install check `down > 0` themselves.
- **`websocket` has a default size of 0.** Frames after the handshake are invisible to
  extensions. Assuming a number would be inventing traffic rather than estimating it.
- **`media`'s default is not the size of a video.** Media arrives in range requests;
  pricing each chunk as a film would make a blocked video look like a saving of
  gigabytes.
- **`levelOf()` returns `null` for a non-matching feature set and nothing repairs it.**
  The page says "Custom". Do not round to the nearest preset.
- **The smoke test asserts refusals price at the per-type default *exactly*.** A range
  would let a real bug hide, and once did: the estimator was answering from an
  in-memory copy of a table that had been deleted from disk.
- **Playwright reads `aria-disabled` as "not enabled" and will not click.** The smoke
  suite passes `force: true`. That reproduces real user behaviour rather than working
  around the assertion.

**Looks fine, is not:**

- **An invalid pack regex is not rejected on its own.** `updateSessionRules` applies
  atomically, so one bad pattern takes down every other rule *including the limits*.
  Hence the `isRegexSupported` check before publishing.
- **`updateContentScripts` merges rather than replaces.** `excludeMatches` must always
  be passed, empty included, or a stale exclusion survives.
- **An invalid match pattern fails the whole `registerContentScripts` call**, silently
  unregistering the page optimizer everywhere.
- **`excludedInitiatorDomains` does not cover a document.** A top-level navigation has
  no initiator; `excludedRequestDomains` has to be set alongside it.
- **`periodKeyFor("session")` returns a constant**, so a grant carried forward on a
  session budget compounds forever. Disarmed, but the shape returns any time a new
  period type is added.
- **A value that crosses a module boundary escapes that module's tests.** The
  measured/modelled split is the live example: `report.ts` can be correct while a
  surface merges the two fields, and `report.ts`'s tests would pass throughout.

## Decisions, so they do not get relitigated

- **`webRequest` is the ledger; performance timings only enrich it.** The reverse
  silently loses every opaque cross-origin response, which is most of the third-party
  web.
- **Estimates are labelled, never laundered.**
- **DNR *session* rules for enforcement, not dynamic ones.** Enforcement is derived
  state and should not outlive the browser session that computed it. A dynamic rule
  survives a restart, so a crash at the wrong moment leaves a site blocked with nothing
  left to explain why.
- **`chrome.storage.session` for session totals**, not an in-memory map — the worker
  dies every thirty idle seconds, and "this session" should not mean "since the worker
  last woke".
- **No runtime dependencies.** The IndexedDB wrapper and the charts are hand-written.
- **Local only, and `default-src 'self'`.** It started at `connect-src 'self'`, which
  was wrong in a way worth keeping written down: `connect-src` governs `fetch` and
  `XMLHttpRequest` and does not see `new Image().src`, a stylesheet, a font, a frame or
  a form submission — every one of which can reach an arbitrary host with no script
  involved. A policy quoted as a guarantee has to actually be one.
- **A browser smoke test is part of the suite, not a nice-to-have.** Nine real defects
  once survived a clean typecheck and a green unit suite, four of them cosmetically
  fatal.
- **A capability with no surface is not shipped.** The largest single audit finding was
  fourteen implemented, in some cases tested, features no user could reach.
- **No kbps claim in the published build.** MV3 cannot pace requests; saying otherwise
  in a store listing would be false.

### Considered and deliberately not built

| Idea | Why not |
| --- | --- |
| A YouTube playback-quality cap | The lever is a MAIN-world hook into an internal API (`movie_player.setPlaybackQualityRange`). It would be the single biggest saving here and it cannot be verified without driving the real site. An internal API that breaks silently is the worst kind of feature in a tool whose whole claim is that its numbers are honest. |
| A `preview.redd.it` pack | Designed, then dropped: the width parameter is covered by a signature, so changing it returns 403. A pack that trades a smaller image for no image is worse than nothing. |
| An ad and tracker blocklist | Out of scope, and uBlock Origin exists. The beacon refusal here is by resource type against a fixed list, not a general blocklist. |
| A `TARGET_WIDTH` ladder | The right answer is 800/1200/1600 chosen from `devicePixelRatio` and screen width, and neither value exists in a service worker — an extension page has to measure and store them. Until that ships, the honesty sits in the pack floors. **Do not lower a floor toward 1000 before shipping the ladder.** |
| Cross-profile totals | Synced budgets are checked against measurements that never leave the profile, so a synced 5 GB budget is really two independent 5 GB budgets. A per-day per-device total would fix it inside Chrome's own sync and keep the no-account promise, but a 400-day window does not fit the 8 kB per-item ceiling. |
| `extraHeaders` for cookie bytes | Moves every request onto a slower path through Chrome's network stack. |

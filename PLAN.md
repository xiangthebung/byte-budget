# Byte Budget — plan and context

A Chrome extension (Manifest V3) that answers three questions about the web you
actually load:

1. **Track** — how many bytes did each site cost me, this session / today / this
   week / this month?
2. **Limit** — hold a site to a byte budget, and shed weight before it gets there.
3. **Optimize** — make popular sites load lighter, and report what that saved
   without inventing the number.

Built in that order. Nothing in a later phase is a prerequisite for an earlier
one shipping.

> The product name is provisional. It appears in `public/manifest.json`,
> `README.md` and nowhere in the code, so changing it is a two-file edit.

---

## 0. Context: how the other extensions here are built

Read from `pagepack-extension` and `grt-bus-time` before starting, and followed:

| Convention | Source |
| --- | --- |
| MV3, service worker as `type: "module"` | both |
| `dist/` is what you load in Chrome; the repo root is never loaded | `pagepack-extension/scripts/build.mjs` header |
| `npm run build` / `zip` / `test` / `verify` | both `package.json` |
| Store zip written by a hand-rolled deterministic writer, then read back and CRC-verified | `scripts/zip.mjs` + `crc32.mjs`, copied here verbatim |
| `node --test "tests/*.test.mjs"`, pure modules tested, no browser needed | both |
| A second build channel via `vite build --mode X`, never a shell env prefix (cmd.exe and PowerShell do not understand `FOO=bar cmd`) | `grt-bus-time/vite.config.ts` |
| Design tokens in `:root`, dark theme via `:root[data-theme="dark"]`, 420px popup | `grt-bus-time/src/popup.css` |
| Typed request/response contract between popup and worker, `Envelope<T>` with `ok` | `grt-bus-time/src/messages.ts` |
| Comments explain *why*, and record decisions that would otherwise get relitigated | both |
| `manifest.version` must equal `package.json` version; the packaging script fails if not | both |

Stack: **TypeScript + Vite**, like `grt-bus-time` (the more recent of the two, and
this project has enough moving parts to want a typechecker). **No runtime
dependencies** — IndexedDB gets a ~60-line promise wrapper rather than `idb`, and
charts are hand-written SVG. Fewer things for a store reviewer to ask about.

---

## 1. What the browser will and will not tell us

This section is the whole design constraint. Everything below follows from it.

### 1.1 Byte counts are not handed to us

Chrome's `webRequest.onCompleted` details do **not** include a response size.
(Firefox has `responseSize`; Chrome does not — the fields are `requestId`, `url`,
`method`, `frameId`, `tabId`, `type`, `timeStamp`, `ip`, `fromCache`,
`statusCode`, `statusLine`, `initiator`, and `responseHeaders` when asked for.)
`chrome.devtools.network` has exact sizes but only exists while DevTools is open.
`chrome.debugger` has exact sizes (`Network.loadingFinished.encodedDataLength`)
but see §1.4.

So bytes come from three sources, in this order of preference:

1. **`Content-Length` response header**, via
   `onCompleted` + `extraInfoSpec: ["responseHeaders"]`. Exact encoded body size.
   Available for every request the extension has host permission for, regardless
   of CORS, because the extension reads browser-level headers. Absent on chunked
   / streamed responses, which is most HTML and a lot of video.
2. **`PerformanceResourceTiming.transferSize`**, collected by a content script
   and posted to the worker. Exact, and covers the chunked case. But it is **0
   for cross-origin responses without `Timing-Allow-Origin`**
   ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming/encodedBodySize)),
   which is a large fraction of third-party traffic — so this cannot be the
   primary source either.
3. **A learned estimate**, from a per-`(host, resourceType)` running average
   built out of the requests we *did* measure, falling back to a per-type
   default.

Every stored number therefore carries how much of it was measured. The UI states
the measured share rather than presenting an estimate as a fact.

### 1.2 Reconciliation

`webRequest` is the ledger — it sees every request, including ones no page can
observe. Resource timings only *enrich* it.

```
onSendHeaders  -> up bytes   = sum(header bytes) + request Content-Length
onCompleted    -> down bytes = sum(header bytes) + response Content-Length
                  fromCache  -> body counted as 0
```

A record with a known body size is committed immediately. A record without one
goes into a bounded pending map keyed by `tabId|normalizedUrl` (max 400 entries,
15s TTL). Content-script timing batches arrive every ~2s and settle matching
pending records with the exact `transferSize`. Anything still pending at TTL
commits with the estimate and `estimated: true`.

Upload size comes from the *request* `Content-Length` header, not from
`requestBody`. Reading request bodies would mean reading what users type into
forms, for a number we can get from a header.

### 1.3 Attribution: bytes belong to the page, not the host

`googlevideo.com` bytes on a YouTube tab are YouTube's cost. So the primary key
is the **site** — eTLD+1 of the tab's committed top-level document — with the
per-request host kept for a drill-down.

- Tab → site map maintained from `webNavigation.onCommitted` (frameId 0),
  `tabs.onRemoved`, `tabs.onReplaced`, and a full `tabs.query({})` sync on
  startup and on worker wake.
- `tabId === -1` (browser-internal, other extensions' workers, some prefetches)
  → reserved key `#background`, shown as "Background & other".
- `initiator` starting `chrome-extension://` → reserved key `#extensions`.
- There is no browser API for eTLD+1, so `src/core/sites.ts` ships a compact
  list of multi-label public suffixes (`co.uk`, `com.au`, `github.io`, …). It is
  documented as approximate and covered by tests.

### 1.4 Real bandwidth throttling needs the debugger, and that is a real cost

MV3 cannot delay or pace a request declaratively. `declarativeNetRequest` blocks,
redirects and rewrites headers; it has no rate control. MV2's async blocking
`webRequest` is gone.

The one API that genuinely throttles is `chrome.debugger` +
`Network.emulateNetworkConditions` (throughput in bytes/sec, per tab). Two
problems: it shows the "an extension is debugging this browser" banner, it
conflicts with DevTools on the same tab, and **`debugger` cannot be an optional
permission** — Chrome's
[permissions list](https://developer.chrome.com/docs/extensions/reference/api/permissions)
names it as one of the few that must be declared in the manifest. So it cannot be
requested at runtime only from users who want it.

**Decision:** two build channels, exactly the way `grt-bus-time` ships
`dist/` and `dist-free/`.

- `dist/` — the store build. Budgets and shaping (below), no `debugger`.
- `dist-throttle/` — adds `debugger` and a true kbps cap per tab.

And the default build's "limit" is built from what MV3 *can* do, which turns out
to cover what people actually want:

- **A byte budget** per site per period, enforced by blocking once spent.
- **Shaping** — drop the heavy resource types (`media`, then `image`/`font`,
  then third-party `script`) for that site. This is where the bytes are, so it
  reduces bandwidth for real. It is a step change rather than a smooth rate, and
  the UI says so.

`docs`/`README` will not claim a kbps cap in the default build.

### 1.5 Savings have to be measured, not asserted

Three sources, each labelled in the UI:

| Source | How the number is obtained | Confidence |
| --- | --- | --- |
| **Visit delta** | Mean bytes per pageview with optimization on vs off for that site, from a deliberate ~10% holdout. Needs ≥3 samples a side. | measured |
| **Rewrite** | Baseline bytes observed for that exact original URL, minus bytes actually downloaded for the rewritten one. | measured |
| **Block** | Learned mean size for `(host, resourceType)`. | modeled |

The headline number for a site is the visit delta when it exists, because it is
the only one that survives the objection "you are just adding up your own
guesses". Per-request numbers fill in until then, marked as estimates.

### 1.6 Permissions, and why each one is unavoidable

| Permission | Needed for |
| --- | --- |
| `webRequest` | the request ledger (observation only; MV3 allows this, it is `webRequestBlocking` that is gone) |
| `host_permissions: <all_urls>` | `webRequest` only reports requests the extension has host access to; a tracker that skips most sites is not a tracker |
| `declarativeNetRequest` | budget enforcement, shaping, optimizer rewrites |
| `storage`, `unlimitedStorage` | the ledger |
| `webNavigation` | tab → site attribution, pageview boundaries |
| `alarms` | flush backstop, period rollover, retention pruning, the alert sweep |
| `notifications` | 75/90/100% alerts on an allowance — added in the audit; see §7.4 |
| `favicon` | site icons via `_favicon/?pageUrl=…`, no network request |
| `scripting` | the timing collector and the DOM optimizers |
| `debugger` | **throttle channel only** |

`tabs` was on this table during planning and is not in the manifest. It turned out to
be unnecessary: `webNavigation` supplies the committed URL for the tab→site map, and
`chrome.tabs.query`/`sendMessage`/`create` work without it — the permission only adds
`url`, `title` and `favIconUrl` to a `Tab`, none of which anything here reads. One
fewer line on the install prompt for no lost capability, which is a trade worth
recording so it is not undone by someone adding it back "for the popup".

No remote endpoints. Nothing leaves the machine. `content_security_policy` starts at
`default-src 'self'` and pins `form-action 'none'` and `base-uri 'none'`, so that is
enforced and not just promised. It was written as `connect-src 'self'` alone at first,
which is a weaker claim than the one two documents were making with it; §6 says why.

---

## 2. Layout

```
public/
  manifest.json          base manifest; vite plugin patches per channel
  icon.svg  icon.png
src/
  background.ts          worker entry: wires listeners, owns the flush loop
  popup.html/.ts/.css    420px panel
  dashboard.html/.ts/.css  full tab: charts, tables, savings, export
  settings.html/.ts      options page: plan, limits, Data Saver, privacy
  welcome.html/.ts/.css  first run: plan size, reset day, Data Saver  (§7.4)
  content/
    timing.ts            PerformanceObserver -> batched timing reports
    optimize.ts          DOM-level optimizers            (phase 3)
  core/
    types.ts             the data model, one place
    sites.ts             site keys, eTLD+1, public-suffix subset
    period.ts            local-time day/week/month keys and ranges,
                         and the billing cycle                       (§7.4)
    forecast.ts          the projection: pure, no clock              (§7.4)
    format.ts            bytes, rates, percentages
    db.ts                tiny IndexedDB promise wrapper
    settings.ts          chrome.storage.sync settings + defaults
    messages.ts          typed popup/dashboard <-> worker contract
    dom.ts               DOM helpers for the three UIs, incl. radiogroups
    chart.ts             hand-rolled SVG bar/donut
  track/
    tabs.ts              tab -> site map, pageview boundaries
    requests.ts          webRequest listeners -> records
    reconcile.ts         pending sizeless requests, timing settlement
    estimate.ts          learned (host,type) size model
    ledger.ts            in-memory accumulation + debounced flush
    stats.ts             read queries for every period and drill-down
  limit/
    budgets.ts           the model: allowances, windows, tiers, grants
    governor.ts          live counters, evaluation, rollover
    tiers.ts             off / trim / lean / strict, as a slope
    rules.ts             pure synthesis of declarativeNetRequest rules
    enforce.ts           session-rule installation
    notify.ts            the wording of the in-page banner
    alerts.ts            75/90/100% notifications, deduped per window   (§7.4)
    throttle.ts          chrome.debugger speed cap (throttle channel only)
  content/
    timing.ts            resource-timing reporter, declared in the manifest
    notice.ts            the in-page banner, injected on demand
  optimize/              phase 3
    features.ts  packs.ts  rules.ts  apply.ts  savings.ts  report.ts
    holdout.ts           the control group                             (§7.2)
  rules/session.ts       the single owner of the DNR session rule set
scripts/
  package.mjs  zip.mjs  crc32.mjs  make-icon.mjs  smoke.mjs
tests/
```

Two entries this tree used to carry are deliberately absent rather than pending.
`blocked.html` was the redirect target for a `main_frame` refused by a budget, and §4.0
removed the need for it: no tier blocks the document, so there is nothing to redirect.
`content/page-hooks.ts` was the MAIN-world hook for a YouTube playback-quality cap, and
§5.3 records why it was not built.

### Storage schema (IndexedDB `byte-budget`)

| Store | Key | Holds |
| --- | --- | --- |
| `daily` | `YYYY-MM-DD\|site` | down, up, requests, cached, estimated, saved, blocked, `byType` |
| `hourly` | `YYYY-MM-DDTHH\|site` | same shape; pruned past 72h, drives the today chart |
| `visits` | `visitId` | site, tab, start, end, bytes, saved, and *why* the load was or was not optimized (§7.2) |
| `hosts` | `YYYY-MM-DD\|site\|host` | per-third-party breakdown, pruned with `daily` |
| `sizeModel` | `host\|type` | mean, count — the estimator, LRU-capped at 5000 |
| `baselines` | SHA-256 digest of the URL | observed bytes, for measured rewrite savings; aged out at 60 days or retention, whichever is shorter (§7.1) |
| `meta` | key | schema version, session start, last prune |

Session totals live in `chrome.storage.session`, which Chrome clears when the
browser closes — which is exactly what "this session" means, and it survives
service-worker restarts, which an in-memory map does not.

Retention default 400 days for `daily`, configurable 30 / 90 / 400 / forever.
Rollups for week and month are summed from `daily` on read; a month is ~3,000
rows, which is cheap enough not to warrant a second write path.

### Flushing, and the service worker going to sleep

Deltas accumulate in memory and flush on a leading+trailing debounce: 2s after
the first dirty write, at most every 5s. Each `webRequest` event resets Chrome's
30s idle timer, so the worker stays alive while traffic is flowing and we have
flushed long before it is killed. Backstops: a 1-minute `chrome.alarms` flush,
a flush on `runtime.onSuspend`, and a flush when the popup asks for data so it
never shows a stale total.

---

## 3. Phase 1 — Track ✅

**Done when** the extension is loadable from `dist/`, shows a per-site breakdown
for session / today / week / month that agrees with a known page's actual byte
sizes, and states what share of the total was measured.

- [x] Repo scaffolding: `package.json`, `tsconfig.json`, `vite.config.ts`,
      `.gitignore`, `scripts/{zip,crc32,package}.mjs`, a rasterised icon
- [x] `core/`: types, sites, period, format, db, settings, messages, dom, chart
- [x] `track/`: tabs, requests, wire, reconcile, estimate, ledger, stats
- [x] `content/timing.ts` + declarative registration + injection into open tabs
- [x] `background.ts` wiring, alarms, retention pruning, toolbar badge
- [x] Popup: period tabs, current-site card, hour/day chart, type breakdown,
      top-site list, measured-share note
- [x] Dashboard: stat cards, daily chart with range tabs, filterable site list,
      site drill-down (hosts / types / hourly / page loads), settings, CSV + JSON
      export, storage report, delete-everything
- [x] Unit tests over the pure modules: sites, period, format, totals, estimator,
      wire arithmetic and attribution. (The count that used to sit on this line is
      gone deliberately — see §7.)
- [x] `scripts/smoke.mjs` — loads `dist/` in a real Chromium against a local
      server with known byte sizes, and checks the figure the extension reaches
- [x] `npm run verify` clean; `npm run smoke` deterministic over five runs

**Measured result:** 770,830 bytes served, 771,820 counted, 100% of bodies
measured. The 990-byte difference is the halved header estimate across five
requests.

### What the browser verification changed

None of these were visible from a passing typecheck and a green unit suite, which
is the argument for `scripts/smoke.mjs` existing at all.

1. **`flush()` did not guarantee freshness.** It returned an already-running
   flush, whose buffers had been swapped *before* the call — so "flush, then read"
   resolved with the newest requests still in memory and the reader rendered a
   total one request short, intermittently. Callers are now split: those a
   scheduled flush will cover share it, those arriving after the swap get a fresh
   flush chained behind it.
2. **The outlier damping in the size model was inverted.** Reducing the weight of
   the existing mean made a single 40 MB video segment on an 8 kB API host move
   the mean to 3.6 MB. Now the *sample* is winsorised instead, capping any one
   observation's influence at about 17% while still letting a host that genuinely
   changed converge in ~20 samples.
3. **Every chart rendered as a flat line.** `align-items: flex-end` meant the bars
   were never stretched, so the track collapsed to the fill's 2px minimum and a
   measured 772 kB drew as nothing. The bar is a grid with a `minmax(0, 1fr)` row
   inside a fixed-height flex item now.
4. **Every stacked-bar segment came out the same colour.** `--swatch: hsl(var(--hue) …)`
   declared on `:root` resolves `--hue` at the root, so all twelve categories
   inherited one finished teal. The hue is composed on the element that carries it.
5. **Empty chart tracks read as data.** Thirty idle days drew thirty
   near-full-height pale bars. Tracks are transparent with a baseline rule, and an
   empty bucket draws no element at all.
6. **The content script broke on re-injection.** Declared in the manifest *and*
   injected into open tabs on install, so it can run twice in one world; with
   top-level declarations the second run died on "Identifier 't' has already been
   declared" in the page's console. It is an IIFE behind a `window` marker now.
7. **"Delete all recorded usage" did not delete the current tab's usage.** Open
   tabs hold their own running counters and the next flush wrote them straight
   back into the emptied visits store.
8. **The dashboard ignored settings changed elsewhere.** A theme switch in the
   popup left an open dashboard tab light until reloaded.
9. **A dropped request was silent.** The `webRequest` handlers are
   fire-and-forget, so a rejected promise removed a request from the ledger with
   nothing logged — and the size model's loader could reject once and poison every
   request after it. Both now log and degrade.

## 4. Phase 2 — Limit

**Done when** a site with a 50 MB daily budget stops loading at 50 MB, having
shed media first, and the popup explains where it is.

### 4.0 The mechanism, verified before designing on top of it ✅

The load-bearing question was whether an extension can refuse a request at all,
or only notice it afterwards. Answered by measurement rather than by reading the
docs, in `scripts/smoke.mjs`:

```
ok    enforcement installed 2 rule(s) for the site
ok    the server was never asked for the image (hits: /?limited /fixture.js)
ok    the script was still allowed through, so the block is selective
ok    no image bytes were counted (0 B)
ok    the refusal is recorded (2 blocked)
ok    the period total is the document plus the script and nothing else (400589 vs 400589 B)
ok    lifting the limit removes every rule (0)
ok    the image loads again once the limit is lifted
```

The local server records every path it is asked for, so this is not the extension
vouching for itself: with `lean` enforced, the 250 kB image request **never reached
the server**, and the period total is exactly the document plus the script. That
settles it — `declarativeNetRequest` is evaluated in Chrome's network stack, a
refused request is never dispatched, and the bytes cost zero rather than
"zero after we noticed".

> Every block of smoke-test output quoted in this file is a transcript of the run
> that settled the question at the time it was asked, kept because the question and
> the answer are the record. The script has changed since — new assertions, reordered
> setup, different fixture figures — so a run today prints more lines than any of
> these and different numbers on the lines it shares. §7 says what changed. `README.md`
> describes the current assertions in prose rather than quoting a run, for the same
> reason: a transcript is evidence of one moment, not a specification.

Built for it, and kept:

- [x] `limit/tiers.ts` — `off` / `trim` / `lean` / `strict` as a slope, each tier a
      superset of the last, ordered heaviest-first
- [x] `limit/rules.ts` — pure synthesis of DNR rules, unit-tested
- [x] `limit/enforce.ts` — session-rule installation, mirrored decision map
- [x] Blocked requests recorded with `blocked` and a modelled `saved`, credited
      **only** when this extension is the one enforcing
- [x] 9 unit tests over tiers and rule synthesis
- [x] `SET_ENFORCEMENT` / `GET_ENFORCEMENT` messages — the same code path the
      budget evaluator will call, exposed so a test can drive it without waiting
      for a budget to be exceeded

Three things the experiment changed about the design:

1. **`main_frame` is not in any tier.** Blocking the document gives Chrome's error
   page, which reads as a broken website rather than as a limit someone set. The
   `strict` tier refuses every *subresource* and lets the shell load, so the page
   can say what happened. This removes the need for a `blocked.html` redirect
   target on the slope; a hard stop on navigation belongs behind its own setting.
2. **Rules are scoped by `tabIds` as well as by `initiatorDomains`.** Bytes are
   attributed to the tab's top-level site, so enforcement has to be scoped the same
   way or the thing being limited is not the thing being counted. The tab condition
   also reaches subresources inside iframes, whose initiator is the frame's origin
   rather than the page's.
3. **The credited saving came out ~10% high**, and for an instructive reason: the
   fixture host served both a 250 kB image and a 482-byte one, so the learned mean
   for `host|image` sat between them. This is exactly why §1.5 insists on labelling
   modelled figures. Phase 3's savings report must show confidence, not just a
   number.

### 4.1 Budgets that enforce themselves ✅

- [x] `limit/budgets.ts` — the model: site, allowance, window (`session` / `day` /
      `week` / `month`), shape (`progressive` / `hard`), snooze, one-window grants,
      and an optional kbps cap for the throttle channel. Stored in
      `chrome.storage.sync`, capped at 30, because a monthly cap set on one machine
      should apply on the others
- [x] `limit/governor.ts` — a live byte counter per budgeted site, primed from the
      database once and incremented synchronously from `ledger.record` afterwards.
      Not read from the rows: a database read on the path that records every request
      would be a promise per request, and the rows lag the traffic by the flush
      debounce, so a check against them would let a site sail past its cap
- [x] **Early arming.** A guard band is added before the threshold comparison, so
      enforcement engages before the boundary rather than after it. Nominally 2% of
      the allowance, floored at 250 kB, capped at 4 MB *and* at a tenth of the
      allowance — the last bound was added after the floor alone turned out to eat
      43% of a 600 kB budget
- [x] `limit/notify.ts` + `content/notice.ts` — the in-page banner, injected on
      demand rather than declared, in a closed shadow root so the page cannot
      restyle or remove it. Updated from the same place the rules are, so it cannot
      outlive the limit it describes
- [x] `limit/throttle.ts` — `chrome.debugger` `Network.emulateNetworkConditions` per
      tab, compiled out of the store build entirely by the `__THROTTLE_BUILD__`
      literal
- [x] Popup: a limit card on the current site with a meter, the tier in force,
      presets for setting one, and grant / pause / remove
- [x] Dashboard: a limits table with live meters and actions, plus a full editor
      (size parsed from typed text, refused rather than guessed when unreadable)
- [x] Window rollover, snooze expiry and grant evaporation all ride the existing
      one-minute maintenance alarm rather than each getting a timer
- [x] 20 more unit tests over the tiers, the rule synthesis and the budget arithmetic
- [x] Browser proof that a budget enforces itself with nothing set by hand

### 4.2 The self-enforcing budget, measured

```
ok    nothing is enforced before any traffic (off)
  after one load: {"used":651570,"share":0.8144625,"tier":"lean"}
ok    the governor counted the load live (651570 B)
ok    enforcement engaged from usage alone, no rules set by hand (lean)
ok    the live counter agrees with the stored ledger (651570 vs 651570 B)
  server hits over budget: ["/?budget-2","/fixture.js"]
ok    the over-budget load never asked for the image (hits: /?budget-2 /fixture.js)
ok    the page shows a notice ({"present":true,"tag":"DIV"})
ok    the grant raises the allowance for this window (25800000)
ok    and lifts enforcement (off)
ok    the notice is withdrawn when the limit is lifted
ok    the image loads again after the grant
ok    removing the budget leaves nothing behind ([])
```

An 800 kB daily budget, a page that costs 651 kB. One load crosses into `lean` on
its own; the next load never asks the server for the image. The live counter and the
stored ledger agree to the byte — two independent paths to the same number, which is
the check that matters, because a limit firing against a total nothing else agrees
with would be indefensible.

Two more things this run established:

- **The first load always gets everything.** Every request on a page is dispatched
  while parsing, before any of them has finished being counted, so the overshoot in
  §4.3 is not theoretical — it is one page load's worth on the load that crosses the
  threshold. The guard band shrinks it; nothing removes it.
- **A stale build invalidates every conclusion silently.** A threshold was retuned,
  the unit tests were run (which do not build), and the browser results were read as
  evidence about the new code while it was exercising the old. `scripts/smoke.mjs`
  now refuses to run against a `dist/` older than `src/`.

### 4.3 Known limits of the mechanism, stated in the UI

### 4.4 Left for later

- **A cap is not a rate.** MV3 cannot pace a request. `trim` and `lean` are step
  changes; the player's own bitrate logic is what turns them into something that
  behaves like a rate. The UI must not imply a dial.
- **Overshoot is bounded but not zero.** Requests already in flight when a
  threshold is crossed cannot be recalled, and rules take a moment to install. On
  video that is one or two segments — single-digit MB at 1080p. Arming early
  shrinks it.
- **A single large non-range response cannot be stopped once dispatched.** No
  extension API cancels a response mid-body; `chrome.debugger` can only fail a
  request before the body starts. A 60 MB download with no range requests will
  overshoot by up to 60 MB. Most large transfers are range-based, but this is a
  real hole and should be said out loud rather than discovered.
- **Blocking is visible.** A refused media request makes a player error rather than
  degrade. Tier order and an in-page notice are what keep that from reading as a
  bug.

## 5. Phase 3 — Optimize ✅

**Done when** a site with a pack enabled measurably loads lighter, and the savings
figure distinguishes measured from modelled.

- [x] `optimize/features.ts` — seven generic optimizers, each independently
      switchable because they are not equally safe, plus the settings model
- [x] `optimize/packs.ts` — five URL-rewrite packs: `pbs.twimg.com`,
      `upload.wikimedia.org`, Photon (`i0-2.wp.com`), Shopify CDN, Cloudinary
- [x] `optimize/rules.ts` — pure DNR synthesis: redirects, `Save-Data`, refusals
- [x] `rules/session.ts` — one owner of the session rule set, because limits and
      optimizers both publish rules and `updateSessionRules` replaces by id
- [x] `optimize/savings.ts` — three-source accounting, a baseline store that turns
      modelled savings into measured ones, and the page-load comparison
- [x] `optimize/holdout.ts` — the control group, decided synchronously before the
      document request so a control load is genuinely unoptimized
- [x] `content/optimize.ts` — the page-side optimizers, registered dynamically so
      nothing runs on any page while the feature is off
- [x] Popup: a per-site switch and an avoided-bytes figure. Dashboard: the full
      optimizer panel and a savings report with its three sources kept apart
- [x] 24 more unit tests: pack correctness, must-not-match, must-not-loop, rule
      synthesis, exclusion coverage, holdout scheduling, rule composition
- [x] Browser proof of a real pack rewriting a real host pattern

### 5.1 The optimizers, measured

```
ok    pack "twimg" uses a pattern Chrome accepts          (all five, via isRegexSupported)
  control load asked for: [".../1600px-Example.png"]
ok    an unoptimized load fetches the original variant
ok    the original size is now on file (1)
  wikimedia asked for: [".../800px-Example.png"]
ok    the Wikimedia thumbnail was requested at 800px, not 1600
ok    and the large variant was never requested
ok    the document carried Save-Data: on (on)
ok    the beacon was refused (hits: /optimized /fixture.png)
ok    the prefetch hint was dropped
ok    the saving is measured, not modelled (480275 of 481075 B)
ok    switching the optimizer off removes every rule (0)
```

The Wikimedia request goes to the real host with the real pack pattern; Playwright
fulfils it, so *what it was asked for* is the observable. And the order matters: a
control load first records what the 1600px variant weighs, so the saving on the next
load is subtraction rather than a model. That is the whole mechanism, demonstrated in
the order it happens.

`isRegexSupported` checks every pack pattern against Chrome's own RE2. Worth its own
assertion because an invalid pattern is not rejected on its own —
`updateSessionRules` applies atomically, so one bad regex takes down every other rule
including the limits.

### 5.2 What the browser test changed

1. **A page script cannot beat the preload scanner.** `loading="lazy"` set on an
   image six thousand pixels down still let the server be asked for it: by the time a
   `MutationObserver` sees an `<img>`, its request has gone. Both image features were
   relabelled to say they act on content added *after* the initial parse — feeds,
   galleries, anything an app renders — which is where the bytes are on the modern web
   anyway. The smoke test logs whether the initial fetch happened, so the claim cannot
   drift back.
2. **`updateContentScripts` merges rather than replaces.** A field left out keeps its
   old value, so clearing the never-optimize list did not clear `excludeMatches`. The
   site stayed excluded and the only symptom was that its pages were never optimized
   again. `excludeMatches` is now always passed, empty included.
3. **`*://*.127.0.0.1/*` is not a valid match pattern.** Chrome rejects a subdomain
   wildcard on an IP or a single-label host, and it rejects the *whole*
   `registerContentScripts` call — so excluding one such site left the page optimizer
   unregistered everywhere, silently. Those hosts now get the bare pattern, and the
   failure is recorded rather than only logged.
4. **`excludedInitiatorDomains` does not cover a document.** A top-level navigation
   has no initiator, so an excluded site still had `Save-Data` attached to its own
   page — the opt-out covered every image on it and not the page itself.
   `excludedRequestDomains` is now set alongside.
5. **Two variants of the same size prove nothing.** The first fixture served
   identical bytes for the 1600px and 800px URLs, and the measured saving came out as
   exactly zero — correctly. The fixture now scales with the square of the width.
6. **Deleting recorded usage deletes the baselines.** Which is right — an observed
   size is recorded usage — but it meant the test's control load was being wiped before
   the load it was meant to inform.

### 5.3 Deliberately not built

- **A YouTube playback-quality cap.** The lever is a MAIN-world hook into
  `movie_player.setPlaybackQualityRange`, an internal API. It would be the single
  biggest saving here and it cannot be verified from this machine — there is no way to
  test it without driving the real site, and an internal API that breaks silently is
  the worst kind of feature in a tool whose whole claim is that its numbers are
  honest. Left out rather than shipped untested.
- **Reddit's `preview.redd.it`.** Designed, then dropped: its width parameter is
  covered by a signature, so changing it returns 403 and the image does not load at
  all. A pack that trades a smaller image for no image is worse than nothing.
- **An ad and tracker blocklist.** Out of scope, and uBlock Origin exists. The beacon
  refusal here is by resource type, not by host list.

---

## 6. Decisions, so they do not get relitigated

- **`webRequest` is the ledger; performance timings only enrich it.** The
  reverse (timings as the source) silently loses every opaque cross-origin
  response, which is most of the third-party web.
- **Estimates are labelled, never laundered.** Every aggregate carries
  `estimatedBytes`, and the UI shows the measured share.
- **Bytes are attributed to the tab's site, not the request host.** A CDN is not
  a website you visited. Hosts are kept for the drill-down.
- **No kbps claim in the default build.** MV3 cannot pace requests; saying
  otherwise in a store listing would be false. The throttle channel exists for
  people who accept the debugger banner.
- **DNR session rules, not dynamic rules, for enforcement.** Enforcement is
  derived state; it should not outlive the browser session that computed it.
- **`chrome.storage.session` for session totals**, not an in-memory map — the
  service worker dies every 30 idle seconds, and "this session" should not mean
  "since the worker last woke".
- **No runtime dependencies.** IndexedDB wrapper and charts are hand-written.
- **Local only.** No account, no sync of browsing data, `default-src 'self'`. It
  started at `connect-src 'self'`, which was wrong in a way worth keeping written
  down: `connect-src` governs `fetch` and `XMLHttpRequest` and does not see
  `new Image().src`, a stylesheet, a font, a frame or a form submission, every one of
  which can reach an arbitrary host with no script involved. Two of the project's own
  documents cited it as *enforcement* of "no network request of the extension's own".
  A policy quoted as a guarantee has to actually be one.
- **Upload bytes from request headers, never from `requestBody`.** The body is
  what the user typed.
- **The holdout is on by default.** A savings number with no control group is a
  marketing number. It is disclosed and switchable, and off is one of the options —
  three claims this file made before any of them was true of a shipped build. §7.2.
- **A browser smoke test is part of the suite, not a nice-to-have.** Nine real
  defects survived a clean typecheck and a green unit suite, four of them
  cosmetically fatal — a chart that draws a flat line for 772 kB is worse than no
  chart. `npm run smoke` measures a page whose exact byte sizes are known and
  checks the number the extension reaches.
- **Content scripts import nothing and are idempotent.** Both rules are enforced:
  the first by `assert-classic-scripts` in the Vite config, the second by a marker
  on `window`.
- **Bytes are attributed to a page load, not to a tab.** `CommitEntry` carries the
  `visitId` it was priced under. Resolving the tab's *current* visit at commit time
  is wrong by up to the parked-request TTL, and it moves bytes onto the next page's
  row while leaving the period totals — which are keyed by site — looking correct.
  That is the worst available failure mode: `visits` is the only input to the
  optimizer's on-versus-off comparison, so the error correlates with the variable
  being measured.
- **Anything parked owns a timer.** The reconciliation queue is module state in a
  worker Chrome kills after thirty idle seconds. A flush hook cannot expire a
  request whose TTL has not elapsed, and an alarm wakes a *fresh* worker with an
  empty queue — so between them they lost the last streamed request on every page.
  The queue schedules its own sweep inside the TTL and drains on `onSuspend`.
- **What a clear deletes on disk, it deletes in memory.** The worker holds
  long-lived copies of the session totals, the open visits and the learned size
  model, and each of them has written deleted data straight back at least once. The
  size model is keyed by hostname, so this is a privacy property and not only an
  arithmetic one.
- **A DOM-level optimization gets a DOM-level assertion.** Nothing running in a
  page beats the preload scanner (§5.2). Claiming otherwise cost this project twice:
  the image features, then `dropHints`, whose smoke check asserted the network
  outcome and passed on the winning side of a race for as long as it kept winning.
- **The measured and modelled halves of a saving are never handed over merged.**
  `savedMeasured` and `savedModelled` both ride the report. A surface given one number
  renders one number, and no amount of prose beside it undoes that. §7.5.
- **A limit's refusal outranks an optimizer's rewrite.** They publish to the same rule
  set, and Chrome selects by priority before it applies the block-over-redirect
  ordering. Limits sit above optimizers, and a test pins the gap. The failure it
  prevents had already shipped: a hard cap that went on spending bytes through exactly
  the five CDNs the optimizer knows how to rewrite, and was refused everywhere else.
- **A plan is not a budget, and a budget is not an alert.** A plan size is a figure to
  reconcile against; a budget refuses requests; an alert is raised from an allowance
  the governor tracks. `settings.planBytes` on its own produces neither of the other
  two, so every flow that captures a plan writes the matching `ALL_SITES` budget in the
  same breath. §7.4.
- **A notification carries a measurement, never a projection.** `core/forecast.ts` is
  not imported by `limit/alerts.ts` and should not be. A modelled number arriving with
  an interruption's urgency is the hardest kind for a reader to question, and the
  dashboard is where a projection can stand beside its basis.
- **A capability with no surface is not shipped.** The audit's largest single finding
  was a list of fourteen implemented, in some cases tested, features that no user could
  reach. §7.5.

---

## 7. What the audit changed

`AUDIT.md` is a full read of the codebase at 0.1.0, written against a build that
typechecked, passed 105 tests and had a green smoke run. Its verdict was not that the
measurement was wrong. It was that "the engineering is ahead of the product, and the
product is ahead of its own UI" — an unusual amount of correct, tested machinery that
no user could reach, sitting behind a UI that could not express the one thing a person
on a metered plan wants to say.

Worked through in four waves, each a commit with its reasoning in the message: the
ship blockers, then measurement and methodology, then the missing product, then the
surfaces. This section records the decisions rather than the diffs — `git log` has the
diffs, and a decision with no reason attached gets relitigated.

On counts: the suite went from 105 tests to over 150 across the first three waves and
kept growing in the fourth. The per-phase numbers in §3 to §5 are what each phase added
at the time and are not maintained; the top-line number is gone from this file and from
`README.md` for the same reason. There is no CI to regenerate it, and a number nobody
regenerates is a number that is wrong.

### 7.1 Documents that described a product which did not exist

The most serious findings were not in the code. `normalize()` rebuilt `Settings` from
defaults and carried forward two fields, so `retentionDays` was permanently 400 and
`trackHosts` permanently true — while `PRIVACY_POLICY.md` said host counts were
"switchable off in settings" and that byte counts followed "your retention setting".
Every install got 400 days of per-site, per-host and per-page-load rows with no way to
shorten it. A privacy policy that documents a control the product lacks is a problem of
a different kind from a bug, because the remedy for it is not a patch.

Three more of the same shape:

- Budgets and the never-optimize list were in `chrome.storage.sync`, each carrying a
  site key, while the policy said the sync transfer "carries no browsing data". A list
  of the domains someone capped and a list they excluded is the most opinionated slice
  of a browsing history there is. Both moved to `chrome.storage.local`, with a one-time
  read of anything already synced so nobody loses a limit. The cost — a limit set on
  one machine is not a limit on the next — is now stated in both documents instead of
  being discovered.
- The CSP was `script-src 'self'; object-src 'self'; connect-src 'self'`, presented in
  two user-facing documents as *enforcement* of "no network request of the extension's
  own". See §6.
- `baselines` was keyed by the full third-party image URL, with a row-count cap and no
  age bound, so a profile under three thousand rows kept its first observation forever
  and outside every retention setting the policy describes. The store is read only by
  exact key, so the plaintext was never load-bearing: the key is a SHA-256 digest now
  and the rows age out at sixty days or the retention setting, whichever is shorter.
  Worth naming because those rows accrue whether or not Data Saver is on — an original's
  size has to be on file *before* the load that would have rewritten it.

The rule that comes out of this and is worth keeping: **a claim in a document is a
feature with a test missing.** Each of the four above was a sentence someone wrote in
good faith about what the code was going to do.

### 7.2 The holdout, rebuilt

This is the one to read if only one section of §7 gets read. §1.5 stakes the whole
savings argument on a randomised control group, and the control group was neither
randomised nor a control group.

**What was wrong, in three layers.**

1. **The arm labels.** `Visit.optimized` was a bare boolean and `visitDelta` counted
   every falsy value as a control. That swept in every load from before Data Saver was
   switched on, every load on an excluded site, and every load where `applyOptimize()`
   had not resolved yet. Switch the feature on today and the previous thirty days
   became your control group — so the first "measured" saving anyone saw was really a
   before-versus-after-install comparison, which is the exact objection a holdout
   exists to answer. Worse, the third case ran the other way: DNR session rules and the
   persisted content-script registration both survive a worker teardown, so a load that
   was genuinely optimized could be filed as a control.
2. **The sampling.** `decideHoldout` allowed at most one control per site per day and,
   below the minimum sample count, held out *deterministically*. So the first controls
   a site ever produced were its first eligible load on each of three days: cold HTTP
   cache, cold service worker, an authentication bootstrap. Those loads are heavier for
   reasons the optimizer had nothing to do with, and because the first load of the day
   was always spent on the control, the treatment arm got the cheap remainder. The
   comparison was reporting the shape of a day as a saving.
3. **The statistic.** A raw difference of means over a few dozen samples of a
   heavy-tailed distribution, with no variance and no interval — against §4.0's own
   conclusion that the report "must show confidence, not just a number".

Separately, the holdout tab set was module state with no `chrome.storage.session`
mirror, unlike the tab map and the enforcement map, which both restore for exactly this
reason. A control tab outliving the worker was silently optimized on the next wake
while still recording itself as a control.

**What replaced it.**

- `Visit` carries a reason — `optimized` / `holdout` / `disabled` / `excluded` /
  `unknown` — instead of a boolean. Only `holdout` counts as control and only
  `optimized` as treatment; pre-migration rows are `unknown` and count towards
  neither. `DB_VERSION` was bumped for it.
- The bootstrap control is drawn **uniformly from the first four loads of the day**:
  a quarter at the first, a third at the second, a half at the third, certainty at the
  fourth. That is the standard "choose one of N uniformly from a stream", and it puts
  first-of-day loads on both sides in proportion instead of all on one. On a day with
  one or two loads there is still a fair chance of taking one.
- The load ordinal is rebuilt from the visits store on every refresh, and the higher of
  the rebuilt and in-memory values wins. A worker torn down every thirty idle seconds
  would otherwise restart each day at ordinal one, where the draw probability is
  lowest — which is the original bias coming back through the back door.
- The tab set is mirrored to `chrome.storage.session`.
- The comparison is **trimmed means with a 95% interval**, and a site whose interval
  covers zero is not reported at all. Details that are decisions rather than
  implementation: 20% trimmed from each tail; the variance is *winsorised* rather than
  taken over the trimmed values, because the latter understates the trimmed mean's
  error and a too-narrow interval is the one direction this figure must not be wrong
  in; Welch's degrees of freedom; and a Student-t table rather than 1.96, because three
  loads a side is the floor and at three degrees of freedom the multiplier is 3.18 —
  using 1.96 would declare roughly a third of the noise significant. Past the end of
  the table the value is held slightly wide rather than relaxed toward 1.96.
- The half-interval is returned to the UI, so a per-site saving is rendered as "±"
  rather than as a bare number.

**The direction of every remaining error is deliberate.** Under-sampling, a wider
interval, a suppressed row and a dropped `unknown` all cost the report a saving it
might have been able to claim. None of them invents one. That asymmetry is the whole
design: the figure exists to survive the objection "you are adding up your own
guesses", and a figure that is occasionally too modest survives it while a figure that
is occasionally too generous does not.

The price is real and worth stating: the first measured saving for a site takes a day
or two longer to appear than it used to, and some sites never produce one. Both of
those look like the feature working less well. They are the feature working.

**And the rate is a setting with zero among the options** — off, 5%, 10% and 20%, with
10% the default. `holdout.ts` said this in its own header from the start and it was
true of nothing shipped: `HOLDOUT_OPTIONS` was exported and imported by no UI file, and
the dashboard's only reference to the rate picked between two empty-state strings. A
control load is a deliberately heavier page, which on a metered connection is money,
spent to improve a number the extension displays about itself. Off is a real option,
and if it were not going to be exposed then 0 was the honest default.

### 7.3 Measurement, where it was quietly wrong

Smaller than §7.2 individually, and all in the same category: figures that were wrong
without saying so.

- **Service-worker requests all landed in `#background`.** `attributeSite` returned the
  background bucket for every `tabId < 0`. On a site whose service worker re-issues
  fetches, those bytes missed the site row and were fed to the governor under a key no
  per-site budget could ever match. For a `tabId = -1` request the `initiator` is the
  page origin — the thing being asked for — so it is used as a fallback now. Requests
  with no initiator, and opaque origins, still land in `#background`.
- **A `HEAD` probe booked a phantom body and trained the estimator with it.**
  `priceCompleted` tested `contentLength()` before `bodyImpossible()`, so a `HEAD`
  against a 60 MB file recorded 60 MB of `down` and called `sizeModel.observe` with it.
  On a cold key the estimator set `mean = bytes` outright, so one probe could define
  the mean that priced every refused request and cache hit on that host. The order is
  swapped, and a cold key's first sample is now clamped to within 32× of the per-type
  prior — the first sample only, and 32× rather than the 8× later samples get, because
  the prior is an order-of-magnitude guess with nothing observed to disagree with it
  yet, and a host that genuinely serves 1 MB images against a 45 kB default has to be
  believed within three or four samples.
- **Header bytes were added twice on every estimate.** The model was trained on
  header-inclusive figures and `commitEstimate` then added headers again.
  Header-inclusive is now the stated convention, written down in four places, which is
  the actual fix — the arithmetic error was a symptom of two conventions coexisting.
- **A failed flush lost its deltas.** `doFlush` swapped the buffers into locals before
  the first await and only `console.error`d a rejection, so an aborted IndexedDB
  transaction dropped those bytes with the only trace in a console nobody opens.
  Rejected maps fold back into the live buffer now, and `GET_STORAGE_REPORT` carries a
  `lastFlushError` — an admission that writes did not land, which is a thing a
  measurement tool owes its user rather than debug output.
- **A long upload recorded zero bytes sent.** The declared `Content-Length` was held in
  a module-level map keyed by request id, and a long upload fires no events between its
  first and its last, so a quiet thirty seconds killed the worker and a 500 MB upload
  booked nothing. Entries above 64 kB mirror to session storage. Below that the loss
  survives, deliberately: a storage write per small request costs more than the bytes
  it saves.
- **Baselines were skipped for cached responses**, which on a repeat visit is most
  images — so the control load, whose entire purpose is recording what an original
  weighs, banked nothing for them. Chrome supplies response headers on a cache hit, so
  the declared size was knowable without spending a byte.
- **Any extension's block was credited to Byte Budget.** `isRefusedByOptimizer` tested
  a global resource-type set while its sibling at the same call site was site-scoped —
  under a comment saying neither should be credited for the other's work, or for an ad
  blocker's. Same signature now.

### 7.4 The product that was missing

The audit's §4(b) is a list of things the engine could support and the product could
not express. The largest was the simplest: **"ten gigabytes a month, resets on the
17th" could not be said at all.** `Budget` required a site key, `Settings` had no plan
field, and every month calculation was hard-anchored to the 1st — so the "30 days"
figure was never the figure on a bill.

- **A plan and a cycle.** `planBytes: number | null` and `cycleStartDay: 0..28`, with
  `startOfCycle` / `cycleRange` / `cycleResetsAt` / `cycleElapsed` beside the existing
  period functions rather than folded into them: a period is a window the user chose to
  look at, a cycle is the window the carrier is counting, and only one of them changes
  the answer to "will I go over". `null` is not zero — a zero plan is 100% spent before
  the first request, which would put an unanswered question into "over your limit". 28
  is the cap because every month has a 28th and a reset date that moves in February is
  the one value here a person checks against paper. Tested across eight timezones
  including two that skip midnight on a DST boundary, with a 400-day walk asserting
  every day belongs to exactly one cycle.
- **A budget over everything.** `ALL_SITES` (`#all`) is a `Budget.site` no stored row
  ever carries, so a reader summing the daily rows cannot meet it and double-count. Its
  Chrome rule carries no site condition, which is how the existing tier ladder reaches
  traffic with no site of its own. It is the only budget that can see `#background` —
  other extensions, service workers, browser services — which is real traffic on the
  same plan that no per-site rule can reach.
- **A trap disarmed on the way past.** `periodKeyFor("session")` returns a constant and
  `grantBytes` carries the previous value forward, so session-budget grants compounded
  forever and the allowance only ever grew. Unreachable while both UI call sites
  hardcoded `period: "day"` — and about to become reachable in the same wave that added
  period selection.
- **A projection.** `core/forecast.ts`, pure and clockless so it runs under
  `node --test`. A winsorised rate over the last fourteen finished days; today excluded
  from the rate and counted at its own cost or a typical day, whichever is larger; the
  finished days carried through as themselves so only the remainder is modelled. It
  **refuses to answer** below five finished days or a fifth of the cycle — not a wider
  answer, no answer — and returns a plain-English `basis` that the caller cannot render
  the number without. It is the only modelled figure on the overview payload and it is
  never added to a total.
- **Alerts.** The only two channels that could reach anyone arrived after the fact: an
  in-page banner injected into a tab already loading a limited site, and a badge that
  ships off. `limit/alerts.ts` fires at 75/90/100% of an allowance, highest fresh
  threshold only, deduped per window over `storage.local` so the record outlives worker
  teardown and a browser restart. Plan alerts default on, per-site off. The
  `notifications` permission is an install warning and is weighed out loud in
  `README.md` the way `debugger` is; the short version is that it needs no second
  channel, because it is not a capability anyone can be harmed by, only annoyed by, and
  the annoyance switches off. `forecast.ts` is deliberately not imported there: a
  modelled number arriving with a notification's urgency is the hardest kind to
  question.
- **A first run.** `onInstalled` set alarms, primed the tab map, injected the timing
  script and said nothing. With Data Saver off, the badge off and an empty ledger, a
  new install's first screen was "Nothing recorded for this period yet".
  `src/welcome.ts` asks the two questions and offers the one switch, everything on it
  skippable, nothing written until Save — so closing the tab leaves an install on its
  defaults rather than half configured.

One cross-cutting rule fell out of this and is easy to get wrong: **a plan size is not
an alert.** An alert is computed from an allowance the governor tracks, so
`settings.planBytes` on its own produces no alert ever. Any flow that captures the plan
has to write the matching `ALL_SITES` budget in the same breath, and keep the two in
step when the plan is edited or cleared.

### 7.5 Making it reachable

The audit's list of implemented-and-unreachable ran to: week/month/session budgets, the
`hard` shape, `kbps`, all five site packs, five default-on page optimizers,
`holdoutPercent`, `retentionDays`, `trackHosts`, `savedMeasured`, `GET_STORAGE_REPORT`,
`pageScriptError()`, `clearEnforcement()`, `deltaTotal` and `generatedAt`. Some of them
were tested. None of them had a surface.

The rule adopted, and the one to hold: **a capability with no surface is not shipped,
and a settings field that `normalize()` drops is a lie with a type annotation.** The
audit found both failure modes in the same file more than once.

Three decisions from that wave are design rather than plumbing:

- **The three "tablists" became radiogroups.** They set `role="tab"` and
  `aria-selected` with no keydown handler, no roving tabindex, no `aria-controls` and
  no `role="tabpanel"` anywhere — a screen reader announced "Today tab, 2 of 4" and
  Left did nothing. There is no tabpanel to have: changing period re-renders the
  surface. So `bindGroup`/`paintGroup` in `core/dom.ts` give all three real
  `radiogroup` semantics with arrow keys, Home/End and a roving tabindex, and the
  ad-hoc wiring is deleted rather than patched — three copies of half a widget is how
  it came to be wrong in three places. `bindGroup` is called once at startup and
  `paintGroup` from
  the render path: binding per render replaces the option elements and destroys the
  button the user is standing on.
- **The savings figure is handed over as two named fields.** `savedMeasured` and
  `savedModelled` both ride the report, so a surface cannot render one merged number by
  accident. It had been rendering exactly that — a subtraction of two observed sizes
  added to the estimator's opinion about requests that never happened — while the
  popup's own tooltip promised the dashboard broke it down.
- **`generatedAt` is compared against the clock on render.** The popup polls every two
  seconds and a worker torn down after an idle gap makes a failed poll ordinary; past
  about ten seconds the surface says how old the figures are instead of presenting them
  as live.

### 7.6 Left open, on purpose

Recorded here so the next person knows they were seen and costed, not missed.

- **No internationalization.** Zero hits for `chrome.i18n` or `_locales`, roughly 280
  prose literals across 35 files. Two structural complications beyond the mechanical
  work: `describePeriod` composes English in the worker and ships it as
  `payload.description`, so localisation has to reach the worker or that function has
  to return `{kind, from, to, days}` and let the UI format it; and no CSS uses logical
  properties, so RTL is a second pass. A defect worth **low** for an unpublished
  English-only v0.1, and **large** as work.
- **`TARGET_WIDTH` is a fixed 800 in a desktop-only extension.** The right answer is an
  800/1200/1600 ladder chosen from `devicePixelRatio` and screen width, and neither
  value exists in a service worker — it has to be measured by an extension page and
  stored. Until that ships the honesty sits in the pack floors, which only claim images
  large enough that 800 is still a reduction on a 2× screen. Do not lower a floor
  toward 1000 before shipping the ladder.
- **`Cookie` headers are still counted as zero.** `extraHeaders` would fix it and moves
  every request onto a slower path through Chrome's network stack. The trade stays as
  it is; what changed is that both documents now say the input set is incomplete
  *before* the halving, rather than implying halving is the only source of error.
- **Cross-profile totals.** Synced budgets are checked against measurements that never
  leave the profile, so a synced 5 GB budget is really two independent 5 GB budgets. A
  per-day, per-device total with no sites or origins would fix it inside Chrome's own
  sync and keep the no-account promise — but a 400-day window does not fit in the 8 kB
  per-item ceiling, so it needs a trimmed window and real design.
- **Foreground versus background bytes.** `#background` means "no tab at all", not "a
  tab you were not looking at" — and for a metered user the most infuriating spend is
  the kind they did not ask for. Tracking `activeTabId` per window and splitting
  `TabRecord.down` at commit time is additive to `Visit`, so no migration, and it is
  what would let the recommendation engine say something sharp about offscreen video.
- **No CI.** Both commands exist; `.github/workflows/ci.yml` with a `verify` job on two
  Node majors and a `smoke` job with `npx playwright install --with-deps chromium` is
  the whole pipeline. Until it exists, every count in these documents is a claim rather
  than a fact, which is why they no longer carry counts.

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
| `tabs` | current site in the popup, tab→site sync |
| `alarms` | flush backstop, period rollover, retention pruning |
| `favicon` | site icons via `_favicon/?pageUrl=…`, no network request |
| `scripting` | the timing collector and the DOM optimizers |
| `debugger` | **throttle channel only** |

No remote endpoints. Nothing leaves the machine. `content_security_policy` keeps
`connect-src 'self'`, so that is enforced and not just promised.

---

## 2. Layout

```
public/
  manifest.json          base manifest; vite plugin patches per channel
  icon.svg  icon.png
src/
  background.ts          worker entry: wires listeners, owns the flush loop
  popup.html/.ts/.css    420px panel
  dashboard.html/.ts/.css  full tab: charts, tables, limits, savings, export
  blocked.html/.ts       landing page for a main_frame blocked by a budget
  content/
    timing.ts            PerformanceObserver -> batched timing reports
    optimize.ts          DOM-level optimizers            (phase 3)
    page-hooks.ts        MAIN-world hooks, e.g. player quality   (phase 3)
  core/
    types.ts             the data model, one place
    sites.ts             site keys, eTLD+1, public-suffix subset
    period.ts            local-time day/week/month keys and ranges
    format.ts            bytes, rates, percentages
    db.ts                tiny IndexedDB promise wrapper
    settings.ts          chrome.storage.sync settings + defaults
    messages.ts          typed popup/dashboard <-> worker contract
    dom.ts               DOM helpers for the two UIs
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
    throttle.ts          chrome.debugger speed cap (throttle channel only)
  content/
    timing.ts            resource-timing reporter, declared in the manifest
    notice.ts            the in-page banner, injected on demand
  optimize/              phase 3
    packs.ts  rules.ts  savings.ts
scripts/
  package.mjs  zip.mjs  crc32.mjs  make-icon.mjs  smoke.mjs
tests/
```

### Storage schema (IndexedDB `byte-budget`)

| Store | Key | Holds |
| --- | --- | --- |
| `daily` | `YYYY-MM-DD\|site` | down, up, requests, cached, estimated, saved, blocked, `byType` |
| `hourly` | `YYYY-MM-DDTHH\|site` | same shape; pruned past 72h, drives the today chart |
| `visits` | `visitId` | site, tab, start, end, bytes, optimized flag, saved |
| `hosts` | `YYYY-MM-DD\|site\|host` | per-third-party breakdown, pruned with `daily` |
| `sizeModel` | `host\|type` | mean, count — the estimator, LRU-capped at 5000 |
| `baselines` | normalized URL | observed bytes, for measured rewrite savings (phase 3) |
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
- [x] 51 unit tests over the pure modules: sites, period, format, totals,
      estimator, wire arithmetic and attribution
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
- **Local only.** No account, no sync of browsing data, `connect-src 'self'`.
- **Upload bytes from request headers, never from `requestBody`.** The body is
  what the user typed.
- **The holdout is on by default.** A savings number with no control group is a
  marketing number. It is disclosed and switchable.
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

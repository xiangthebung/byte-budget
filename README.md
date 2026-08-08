# Byte Budget

A Chrome extension (Manifest V3) that measures how much data each website costs
you — this session, today, this week, this month — shows how much of that figure was
actually measured rather than inferred, and holds a site to a byte budget.

All three phases are done: track, limit, optimize. `PLAN.md` is the design document
and the record of what the browser tests changed about it.

```sh
npm install
npm run verify     # typecheck, unit tests, build
npm run smoke      # build, then measure a known page in a real Chromium
```

Then load `dist/` in `chrome://extensions` → Developer mode → Load unpacked.

## Where the numbers come from

Chrome does not tell an extension how big a response was. `webRequest` reports
that a request finished, its type, its tab, and its headers — not a byte count.
So a figure is assembled from three sources, in this order:

1. **`Content-Length` on the response.** Exact, and it is the encoded
   (post-compression) length, which is what crossed the wire. Available for every
   request regardless of CORS.
2. **`PerformanceResourceTiming.transferSize`, reported by the page.** Covers what
   the first source cannot: chunked and streamed responses declare no length. It
   is 0 for a cross-origin response without `Timing-Allow-Origin`, so it fills
   gaps rather than replacing the first source.
3. **A learned estimate.** A running mean per host and resource type, trained on
   the responses that *were* measured, with an order-of-magnitude default in
   front of it.

Every total carries how much of it came from (3), and the UI prints that as a
measured percentage. A tracker that shows one confident number is a tracker that
is occasionally wrong without saying so.

### What is approximate, stated plainly

- **The scope of the whole number.** Every total here covers one Chrome profile.
  A second profile, a different browser, a native app, an OS or app update, and
  every other device on the same hotspot are invisible to an extension — there is
  no API that would show them. So this figure can sit well below a carrier's,
  sometimes by a factor of several. It answers "what did my browsing in this
  profile cost", which is a smaller question than "what did my plan spend", and
  the smaller one is the only question anything running inside Chrome can answer
  honestly.
- **HTTP header overhead.** Counted from the header names and values, then
  halved, because HTTP/2 and /3 compress headers by an amount Chrome does not
  report. Bounded at a few hundred bytes a request. Not folded into the measured
  share — that figure answers "did we measure the body", which is the uncertainty
  that spans orders of magnitude.
- **`Cookie` and `Set-Cookie`.** Chrome hides both from `webRequest` unless the
  extension opts in with `extraHeaders`, which this build does not, so they are
  counted as zero — before the halving above, not after it. A logged-in session's
  `Cookie` header runs to a few kB and goes out with every request to that site,
  so the bytes-sent figure is structurally low wherever you are signed in. The
  opt-in is not free — it moves every request onto a slower path through Chrome's
  network stack — so the trade is deliberate; counting them as zero without saying
  so would not be.
- **WebSocket frames.** Not observable by an extension at all. Only the handshake
  is counted.
- **Cancelled requests.** Chrome aborts loads it decides it no longer needs, and
  by then part of the body has usually arrived. There is no API for how much, so
  the body counts as zero. The request itself is still counted.
- **Cache hits.** Cost no network bytes, and are counted as zero. What they would
  have cost is reported separately as "cache avoided", from the estimator.
- **Registrable domains.** There is no browser API for eTLD+1, so a compact table
  approximates the Public Suffix List. It errs towards grouping *more* than it
  should, never less: one merged row is visible and arguable, a site scattered
  across a dozen rows is just broken.

## Limits

A limit refuses requests before they are sent, so the bytes are never spent. It
cannot slow a request down — Chrome gives extensions no way to pace one — so a
filling budget sheds weight in steps:

| Tier | At | Refuses |
| --- | --- | --- |
| `off` | below 60% | nothing |
| `trim` | 60% | video and audio |
| `lean` | 85% | also images and web fonts |
| `strict` | 100% | every subresource |

The page's own HTML always loads, at every tier. Blocking the document gives
Chrome's error page, which reads as a broken website rather than as a limit someone
set; letting the shell through means the page can say what happened, which it does,
in a banner.

Set a limit per site, per session / day / week / month, either progressive (the
table above) or hard (nothing until it runs out). A limit can be paused for an hour
or granted extra bytes for the current window only — "I need a bit more today" and
"my limit was wrong" are different statements and only one of them should survive
until tomorrow.

### What a limit cannot do

- **A cap is not a rate.** `trim` and `lean` are step changes. A player's own
  bitrate logic is what turns them into something that behaves like a rate.
- **Overshoot is bounded, not zero.** Every request on a page is dispatched while
  parsing, before any of them has finished being counted, so the load that crosses a
  threshold gets everything. Enforcement arms early — 2% of the allowance, floored at
  250 kB, capped at 4 MB and at a tenth of the allowance — which shrinks the overshoot
  to roughly one video segment. Nothing removes it.
- **A single large non-range response cannot be stopped once dispatched.** No
  extension API cancels a response mid-body. Most large transfers are range-based, so
  in practice a cap bites at the next segment, but a 60 MB download with no range
  requests will overshoot by up to 60 MB.
- **A refused request is a visible one.** A blocked video errors rather than
  degrading. That is why the tier order sheds video first and why the banner exists.

A genuine kilobits-per-second cap needs `chrome.debugger`, and lives in the throttle
channel — see the bottom of this file.

## Optimizing

Two kinds of thing, and the split is not cosmetic.

**Network rules** refuse or alter a request before it is sent, so they remove bytes
outright. `Save-Data: on` on outgoing requests, which many image CDNs honour.
Analytics beacons refused. Web fonts refused, if you want that — it is the most bytes
for the most visible change, so it is off by default.

**Site packs** ask a known image service for a smaller version of the same file. This
is the only optimization that removes bytes without removing anything you would see: a
CDN that will serve a 2048px JPEG will serve a 680px one from the same path. Five to
start: `pbs.twimg.com`, `upload.wikimedia.org`, Photon (`i0-2.wp.com`), Shopify CDN,
Cloudinary.

Every pack has to satisfy four things, each a unit test: it matches what it claims, it
matches nothing else, it does not match its own output (a rewrite that matches its own
result is an infinite redirect and the request fails outright), and it leaves signed
URLs alone. Reddit's `preview.redd.it` was designed and then dropped on the fourth
one — its width is covered by a signature, so changing it returns 403 and you get no
image at all.

**Page-side optimizers** change what a page asks for. These come with a limit worth
stating: nothing running in a page can beat Chrome's preload scanner. By the time a
script sees an `<img>` in the DOM, its request has already gone out — measured, not
assumed. So the image features act on content added *after* the initial parse: feeds,
galleries, anything an app renders. Which is where the bytes are on the modern web
anyway, but it is not the same claim as "fixes the first screenful", and the labels in
the UI say which one it is.

### What "saved" means

Three different kinds of number, kept apart everywhere — in the ledger, in the
messages, and on screen. Merging them would drag the strongest down to the credibility
of the weakest.

| Source | How the number is obtained | Confidence |
| --- | --- | --- |
| **Load comparison** | Mean bytes per page load with the optimizer on versus off, from a deliberate holdout | measured |
| **Observed originals** | The original variant's size, seen before, minus what the rewritten one cost now | measured |
| **Estimated** | The size model's guess at what a refused request would have weighed | modelled |

The holdout is what makes the first row possible: a small share of page loads are left
unoptimized on purpose, so "saved" can be the difference between two sets of real loads
rather than the sum of our own guesses. It never fires before a site has five optimized
loads to compare against, never twice in a day for the same site, and the rate is a
setting with zero among the options.

The second row improves on its own. Every time a URL a pack *would* rewrite is fetched
un-rewritten — because the pack is off, or because that load was a control — its size
goes on file, and from then on the saving on that URL is arithmetic.

## What it stores, and where

Everything stays in the browser profile. There is no account, no endpoint, and no
network request of the extension's own — `default-src 'self'` in the manifest
enforces that rather than promising it. It has to start at `default-src`: this was
written at first as `connect-src 'self'` alone, which covers `fetch` and leaves
`new Image().src`, a stylesheet, a font, a frame and a form submission free to
reach any host on the internet. The policy also pins `form-action 'none'` and
`base-uri 'none'`, neither of which inherits from `default-src` and both of which
are exfiltration routes that need no script at all.

| Store | Holds | Kept for |
| --- | --- | --- |
| `daily` | bytes per site per day | 30 / 90 / 400 days, or forever |
| `hourly` | bytes per site per hour | 3 days |
| `hosts` | which hosts a site's bytes came from | with `daily`, switchable off |
| `visits` | one row per page load: site, origin, bytes | with `daily` |
| `sizeModel` | the learned size estimator | 5,000 keys, least-recently-used |
| `baselines` | observed sizes of un-rewritten image variants | 3,000 keys, least-recently-used |

`visits` deliberately holds the origin and no path or query. Per-page-load
averages need to know which site and how many bytes; anything more would make
this a browsing history, which is a different product with different stakes.

Preferences — theme, badge, retention, whether per-host detail is recorded — live
in `chrome.storage.sync` so they follow you between browsers. Nothing that names a
site goes with them: limits and the never-optimize list are lists of domains, which
is a browsing history in all but name, so they stay in `chrome.storage.local` on
the machine you set them on. Measurements never leave the device by either route.
The cost is that a limit set on one machine is not a limit on the next, which is a
worse product and a better promise.

Export everything to CSV or JSON. A number nobody can get out of an extension is a
number they have to take on faith, and this one is about a data plan.

## Permissions

| Permission | Why |
| --- | --- |
| `webRequest` | the request ledger. Observation only — MV3 removed blocking `webRequest`, not this |
| `http://*/*`, `https://*/*` | `webRequest` only reports requests the extension has host access to. A tracker that skips most sites is not a tracker |
| `storage`, `unlimitedStorage` | the ledger |
| `webNavigation` | which site each tab is showing, and where one page load ends |
| `scripting` | the timing reporter, injected into tabs that were already open at install |
| `alarms` | a flush backstop, and retention pruning |
| `declarativeNetRequest` | refusing requests over budget, and rewriting image URLs to smaller variants. Rules are session-scoped, so nothing survives a browser restart |
| `favicon` | site icons from the browser's own cache, so a list of forty sites costs no requests |

## Layout

```
public/manifest.json     base manifest; a Vite plugin patches it per channel and
                         writes a root manifest pointing into dist/
src/core/                types, site keys, periods, formatting, IndexedDB, messages
src/track/               webRequest listeners, reconciliation, the ledger, queries
src/limit/               budgets, the governor, tiers, rules, the in-page notice
src/optimize/            features, packs, rules, savings, the control group
src/rules/session.ts     the single owner of declarativeNetRequest session rules
src/content/             three classic scripts: timing, notice, page optimizers
src/background.ts        the service worker: the only writer
src/popup.*              the 420px panel
src/dashboard.*          the full tab: charts, drill-down, limits, optimize, export
scripts/                 build packaging, icon rasteriser, browser smoke test
tests/                   node --test over the pure modules
```

Content scripts import nothing and are idempotent. Both rules are enforced rather than
trusted: the first by an assertion in the Vite config, the second by a marker on
`window`. A bundle with an `import` in it loads fine in the popup and silently does
nothing on a page, and all three of these get injected more than once into the same
world.

## Loading it in Chrome

`chrome://extensions` → Developer mode → Load unpacked → select the **project folder**.

The build writes a manifest at the project root whose paths point into `dist/`, so the
folder you already have open is loadable — the same as the plain-JavaScript extensions
in this workspace, whose source is their bundle. `dist/` is still the only thing that
gets packaged and published; the root manifest is generated and gitignored.

## Verifying it

`npm run verify` proves the code compiles and that the pure modules behave. It
cannot prove that `chrome.webRequest` fires, that resource timings reach the
worker, or that the dashboard reads back what was written — those only happen in
a browser.

`npm run smoke` does that part. It serves a page whose byte sizes are known
exactly, loads `dist/` into a real Chromium, and checks the number the extension
arrived at:

```
ok    the HTML document itself is counted (main_frame = 482 B)
ok    the sized script is measured at full size (400107 of 400000 B)
ok    the sized image is measured at full size (250931 of 250348 B)
ok    the streamed fetch is measured from resource timing (120300 B)
ok    measured 773 kB, expected between 650348 and 1040216
```

770,830 bytes served, 771,820 counted. The difference is the halved header
estimate across five requests.

The same run then proves the enforcement mechanism, with the server as the witness
rather than the extension:

```
ok    enforcement installed 2 rule(s) for the site
ok    the server was never asked for the image (hits: /?limited /fixture.js)
ok    the script was still allowed through, so the block is selective
ok    no image bytes were counted (0 B)
ok    the period total is the document plus the script and nothing else (400589 vs 400589 B)
ok    lifting the limit removes every rule (0)
ok    the image loads again once the limit is lifted
```

A refused request is never dispatched, so it costs zero bytes — not "zero after we
noticed". That is what makes a byte budget enforceable rather than advisory.

And then that a *budget* enforces itself, with nothing set by hand:

```
ok    nothing is enforced before any traffic (off)
ok    enforcement engaged from usage alone, no rules set by hand (lean)
ok    the live counter agrees with the stored ledger (651570 vs 651570 B)
ok    the over-budget load never asked for the image (hits: /?budget-2 /fixture.js)
ok    the page shows a notice
ok    the grant raises the allowance for this window (25800000)
ok    the notice is withdrawn when the limit is lifted
```

The live counter and the stored ledger agree to the byte. They are two independent
paths to the same number — one incremented per request in memory, one read back off
disk — and a limit firing against a total nothing else agrees with would be
indefensible.

And that the optimizers do what they say, with the local server and Playwright's route
handler as the witnesses rather than the extension:

```
ok    pack "wikimedia" uses a pattern Chrome accepts
  control load asked for: [".../1600px-Example.png"]
  wikimedia asked for: [".../800px-Example.png"]
ok    the Wikimedia thumbnail was requested at 800px, not 1600
ok    the document carried Save-Data: on (on)
ok    the beacon was refused (hits: /optimized /fixture.png)
ok    the saving is measured, not modelled (480275 of 481075 B)
```

That last line is the one worth reading twice. A control load recorded what the 1600px
variant weighs; the next load fetched the 800px one; the saving is the subtraction. Not
a model.

The script refuses to run against a `dist/` older than `src/`. Results from a stale
build are worse than no results, and they do not announce themselves.

It needs Playwright, installed out of tree so it stays out of the extension's
dependencies:

```sh
npm install --no-save playwright
```

Add `--shots` to write `outputs/popup.png`, `outputs/dashboard.png` and
`outputs/dashboard-dark.png`.

## Build channels

`dist/` is the one you load in Chrome and the one that gets published.

`dist-throttle/` (`npm run build:throttle`) additionally declares the `debugger`
permission, which is the only way MV3 can genuinely cap a tab's throughput:
`Network.emulateNetworkConditions` sets a real ceiling, and a page's adaptive-bitrate
logic responds to it the way it would to a slow connection — video steps down and
keeps playing rather than stopping. A limit in that channel takes an optional kbps
figure alongside its byte allowance.

Chrome does not allow `debugger` as an optional permission, so it cannot be requested
at runtime from the people who want it; it would be an install warning for everyone.
And attaching shows Chrome's "an extension is debugging this browser" banner, which
cannot be suppressed and should not be. Hence a second channel. The packaging script
fails if the wrong one declares the permission, and the store build compiles the
throttle code out entirely rather than shipping a branch that can never be taken.

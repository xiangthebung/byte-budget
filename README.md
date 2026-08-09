# Byte Budget

A Chrome extension (Manifest V3) that measures how much data each website costs
you — this session, today, this week, this month — shows how much of that figure was
actually measured rather than inferred, holds a site or the whole browser to a byte
budget, and says so before the budget runs out rather than after.

All three phases are done: track, limit, optimize. `PLAN.md` is the design document,
the record of what the browser tests changed about it, and the record of what this
project's own audit changed.

```sh
npm install
npm run verify     # typecheck, unit tests, build
npm run smoke      # build, then measure a known page in a real Chromium
```

Then load `dist/` in `chrome://extensions` → Developer mode → Load unpacked.

See the [Privacy Policy](https://github.com/xiangthebung/network-data-tracker/blob/master/PRIVACY_POLICY.md).

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
   front of it. A cold key's *first* sample is held to within 32× of that default
   in either direction, and only the first. One unrepresentative response — a `HEAD`
   probe against a 60 MB file, a redirect, an error page — used to define the key for
   good, and that one number then priced every refused request and every cache hit on
   the host. The band is wide because the default is an order-of-magnitude prior
   rather than a measurement, so a host that genuinely serves 1 MB images against a
   45 kB default has to be believed: the first sample is held to the edge of the band,
   and three or four real ones walk the mean the rest of the way. Every sample after
   that is winsorised against the running mean instead, which caps any single
   observation's influence at about 17%.

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
- **Bytes sent come from the request's `Content-Length`,** never from the body —
  the body is what you typed into a form. An upload that declares no length
  contributes only its headers. Above 64 kB the in-flight figure is mirrored to
  session storage, because a long upload fires no `webRequest` events between its
  first and last and a quiet thirty seconds kills the service worker: a 500 MB
  upload used to be recorded as zero bytes sent. Below 64 kB it is still lost on a
  teardown, which is a few tens of kB and not worth a storage write per request.
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

## Your plan, and the day it resets

Everything above answers "what did this cost". A metered connection asks a different
question — "will I get to the end of the month" — and that needs two numbers the
extension used to have nowhere to put.

- **Plan size.** A byte figure, or nothing at all. Nothing is the default, and it is
  a different state from zero rather than a shorter way of writing it: a plan of zero
  is 100% spent before the first request, so an unanswered question would render as
  "over your limit" for someone who has simply never been asked. Unset shows a
  prompt to set one, never a 0 B or a 0%.
- **Reset day.** The 1st to the 28th, or "calendar month". Capped at 28 because every
  month has a 28th; anchoring a cycle on the 31st means the reset date moves in
  February, and the reset date is the one value here that a person checks against a
  paper bill. It is a picker rather than a typed number for the same reason.

Most carrier cycles do not reset on the 1st, so a "this month" figure anchored there
was never the figure on the bill. The cycle is a separate concept from the period
tabs on purpose: a period is a window you chose to *look* at, a cycle is the window
the carrier is counting.

A new install opens a page that asks those two questions, with the Data Saver switch
on the same screen. Everything on it is skippable and nothing is written until you
press Save, so closing the tab leaves an install running on its defaults rather than
one that is half set up. Without a plan the extension still measures everything it
measures; it just cannot answer the question the plan is for.

Setting a plan also sets a budget over everything at the same size — see below. A plan
that enforces nothing and warns about nothing would be a number in a text field.

### The projection, and where it refuses to answer

A cap is a deadline, and the only useful thing to say about a deadline is whether the
current rate meets it. So a plan carries a projected total for the cycle.

This is the one modelled number on a surface whose entire argument is that it keeps
modelled and measured apart. That is not a caveat attached afterwards; it is why the
function is shaped the way it is.

- **The days already recorded are carried through as themselves.** Only the days that
  have not happened are modelled, so the model never overwrites the measurement.
- **The rate is the typical day over the last 14 finished days, winsorised** — the
  heaviest and lightest days are pulled in to their neighbours rather than dropped.
  Dropping them understates a plan genuinely spent on one big evening a week, and the
  person then sails past a cap the tool said they would clear; keeping them raw means
  one downloaded film projects someone into bankruptcy and the warning gets ignored
  from then on. Fourteen days so a weekend is in the window whatever day the cycle
  starts on, and no longer, because behaviour a month old does not pace next Tuesday.
- **Today is excluded from the rate** and counted at whatever it has cost so far, or
  at a typical day, whichever is larger. Averaging in a day that is three hours old
  would make the projection fall every midnight and climb back through the day —
  comfortable at 9am, honest only at bedtime.
- **Below five finished days, or a fifth of the cycle, no figure is printed at all.**
  Not a wider figure, no figure. Three days into thirty, extrapolating multiplies
  whatever the rate has wrong by ten. What gets printed instead is the reason, which
  is written to stand on its own: "Too early to project: only 3 days of this 30-day
  cycle have finished…"
- **Every projection carries its basis in words,** and the UI cannot render the number
  without it. A byte count on its own is indistinguishable on screen from a
  measurement, and the sentence — what rate, over what window, with what treatment of
  today — is the thing that stops it being read as one.

The projection is never added to or subtracted from a total. It sits beside them,
labelled, and the totals stay measurements.

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
until tomorrow. The grant is sized from the allowance rather than fixed, so it is a
proportionate top-up on a 500 MB limit and on a 10 GB one.

### A limit over everything

`#all` is a budget with no site: "stop me at 10 GB this month, across the browser".
It runs the same tier ladder through the same mechanism — the rule Chrome is handed
simply carries no site condition — so nothing new had to be built to enforce it.

It is also the only budget that can see `#background`: requests with no tab of their
own, which is other extensions, service workers and browser services. Those bytes are
on the same plan, they appear in every total, and no per-site rule can ever reach
them, so leaving them out would make the one budget that claims to cover everything
the only one that cannot see them. When a total limit and a per-site limit both bite
at once, the banner names which one is doing it.

A plan size and this budget are two different objects — one is a figure to reconcile
against, the other is a thing that refuses requests and raises alerts — so every flow
that captures a plan writes both, and edits and clears keep them in step.

### A limit outranks an optimizer

Both halves of this extension publish rules to the same Chrome API, and Chrome picks
the highest-priority *matching* rule, using the allow-over-block-over-redirect
ordering only to break a tie inside one priority. At the priority these used to
share, the optimizer's redirect beat the limit's block — so a site past a hard cap
kept spending bytes through exactly the five image CDNs the optimizer knows how to
rewrite, refused everywhere else and quietly not refused there. Limit rules sit above
optimizer rules now, and a unit test pins the gap so it cannot close again silently.

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

## Alerts

An allowance nobody is watching is not a budget. Before this there were two channels
that could reach a person, and neither of them arrives in time: the in-page banner is
injected into a tab that is already loading a limited site, so it explains bytes that
have been spent, and the toolbar badge ships off. An install could be running,
correct, and watch someone spend 90% of a month in silence.

So: a Chrome notification at 75%, 90% and 100% of an allowance.

**The thresholds are fixed, and there are three of them.** 75% is early enough that
the rest of the window can still be spent differently, 90% is the last point at which
what is left can be rationed, and 100% is a fact rather than a warning. A fourth
would not change anyone's behaviour and would spend the attention that makes the
first three land; a configurable one would be a fourth setting in a product that
already asks for two, in exchange for moving a number most people would leave alone.
The copy says 75/90/100 rather than "when you are running low", because a warning
whose trigger is unstated is a warning you cannot plan around.

**What it sends is a measurement.** Bytes counted against an allowance you set — the
same figure every other surface prints, no tilde and no "about". The projection is
deliberately not wired to this: a modelled number arriving with a notification's
urgency is the one place in this codebase where a guess would be harder to question
than a measurement, and the dashboard is where a projection can stand next to its
basis.

**One alert per threshold per window, and only the highest.** A single video takes
someone from 40% to 105%, crossing all three; three notifications arriving together
bury the one that matters, so the lower two are recorded as said without being sent.
The record of what has been said is written to disk before anything is sent, so a
service worker torn down mid-alert cannot announce 75% twice, and it outlives a
browser restart — a monthly window does not.

Plan alerts are on by default. Per-site alerts are off: a per-site limit is something
you typed in, on a site you chose, expecting to reach — being told is being told what
you already know. Both are switchable, and deleting all recorded usage clears the
record of what has been announced, because the counters restart at zero and a profile
that kept it would climb back through 75% in silence.

### On the install warning

`notifications` adds a line to the prompt every installer reads, and most people who
grant it will see three notifications a month at the outside. That is worth weighing
out loud, the way the `debugger` permission is at the bottom of this file.

The differences are what make the trade come out the other way. `debugger` cannot be
an optional permission, shows a banner Chrome will not let anyone suppress, and gives
one build the ability to read every request in the browser — so it gets a separate
channel and most people never see it. `notifications` is not a capability anyone can
be harmed by, only annoyed by, and the annoyance has an off switch inside the
product. What it buys is the single thing this extension exists to prevent, on the
one occasion it matters, through the only channel that can reach someone who is not
looking at a page. So it is declared in the store build, and the cost is bounded
before it is spent rather than trusted: three thresholds and no stream, deduped per
window, per-site alerts off, and no notification the extension sends is ever a
forecast.

## Optimizing

Two kinds of thing, and the split is not cosmetic.

**Network rules** refuse or alter a request before it is sent, so they remove bytes
outright. `Save-Data: on` on outgoing requests, which many image CDNs honour — its
own switch, because it is also the one optimization that makes this browser more
distinguishable, and `PRIVACY_POLICY.md` says why. Web fonts refused, if you want
that — it is the most bytes for the most visible change, so it is off by default.

And beacons, refused **by destination**. This used to be an unscoped block on the
`ping` resource type, under a label that said "analytics" and a description that said
nothing on the page waits for them. True of the network wait; false of the
consequence. `sendBeacon` is not an analytics API — it is how a page flushes the
paragraph you were typing when you closed the tab, posts a CSP violation, and tells a
server the session ended, and all of those go to the site's own origin. The rule now
carries a list of nineteen registrable domains that are analytics services and
nothing else. Error and crash reporters are deliberately absent from it. A
destination not on the list keeps its beacons, which is the direction that costs
bytes rather than data, and the browser test proves the scoping both ways: the
analytics beacon is refused on the same page load where the page's own still goes.

The eight generic optimizers are each switchable on their own, and grouped by how
visible the change is, because they are not equally safe — asking for a smaller image
is invisible and holding video until it is clicked is not. Bundling them behind one
switch would make the cautious setting the useless one.

**Site packs** ask a known image service for a smaller version of the same file. This
is the only optimization that removes bytes without removing anything you would see: a
CDN that will serve a 2048px JPEG will serve a 680px one from the same path. Six rules
over five services: `pbs.twimg.com`, `upload.wikimedia.org`, Photon (`i0-2.wp.com`),
the Shopify CDN (two, because modern themes and legacy themes encode the width
differently), and Cloudinary.

"Anything you would see" is a claim about a 1× display, and it is stated in the code as
such. Every pack rewrites to 800 pixels, which is right for a full-width image on a
standard screen and wrong on a 2× one, where an 800-CSS-pixel slot selects a 1600px
candidate and rewriting it means the browser upscales. The proper fix is an 800 / 1200
/ 1600 ladder picked from `devicePixelRatio`, and neither of those values exists in a
service worker, so nothing sets it yet. Until something does, the honesty sits in the
patterns: a pack only claims an image large enough that 800 is still a reduction on a
2× screen, and the descriptions say so.

Every pack has to satisfy five things, each a unit test: it matches what it claims, it
matches nothing else, it does not match its own output (a rewrite that matches its own
result is an infinite redirect and the request fails outright), it leaves signed URLs
alone, and the transformation suits the media type. Reddit's `preview.redd.it` was
designed and then dropped on the fourth — its width is covered by a signature, so
changing it returns 403 and you get no image at all. The fifth arrived during this
project's audit: Cloudinary passes an SVG through untouched only while *no*
transformation is requested, so asking it for a smaller one rasterised a 6 kB vector
logo into a larger PNG that no longer scaled, no longer followed `currentColor`, and
broke every sprite reference pointing at it. Each pattern names the file extensions it
is willing to touch now instead of accepting whatever sits at the path.

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
| **Load comparison** | Trimmed mean bytes per page load with the optimizer on versus off, from a deliberate holdout, reported only where the 95% interval clears zero | measured |
| **Observed originals** | The original variant's size, seen before, minus what the rewritten one cost now | measured |
| **Estimated** | The size model's guess at what a refused request would have weighed | modelled |

The split is not only a claim in this file. `savedMeasured` and `savedModelled` are two
named fields on the message the dashboard reads, and it renders two tiles: **Measured**
without a tilde, because it is arithmetic on observed sizes, and **Estimated** with
one. Handing a surface a single merged figure is how it comes to print one, so it is
not handed one.

The holdout is what makes the first row possible: a small share of page loads are left
unoptimized on purpose, so "saved" can be the difference between two sets of real loads
rather than the sum of our own guesses. It never fires before a site has five optimized
loads to compare against, never twice in a day for the same site, and the rate is a
setting — off, 5%, 10% or 20%, with 10% the default — sitting next to the number it
pays for. Off is a real option and it means the load comparison never fills in; on a
metered connection the occasional heavier page is real money, and spending it to
improve a figure the extension displays about itself is not a decision to make on
someone's behalf.

That row got harder to earn during this project's audit, and the claim it supports got
stronger for it. Three things changed; `PLAN.md` §7.2 has the full record.

- **The control arm no longer contains loads that were never controls.** A page load
  used to carry a bare "was it optimized" boolean, and every falsy value counted as a
  control — which swept in every load from before Data Saver was switched on, every
  load on an excluded site, and every load where the settings had not resolved yet.
  Turn the feature on today and the previous thirty days became your control group, so
  the first "measured" saving anyone saw was really before-versus-after-install. A load
  now records *why* it was unoptimized, and only a deliberate holdout counts.
- **The sampling is a draw rather than a schedule.** The first controls a site produced
  used to be the first eligible load of the day: a cold HTTP cache, a cold service
  worker, an authentication bootstrap — heavier for reasons the optimizer had nothing
  to do with, while the treatment arm got the cheap remainder. The comparison was
  reporting the shape of a day as a saving. The control is now drawn uniformly from the
  first four loads of the day, so first-of-day loads land on both sides in proportion.
- **A control tab no longer stops being one.** The set of tabs held out was kept only
  in the service worker's memory, so a control tab that outlived a thirty-second idle
  gap was silently optimized on the next wake while still recording itself as a
  control. That bias ran one way — it dragged the control mean toward the optimized
  one, understating the very figure this section stakes its credibility on.

And the number that comes out carries an interval. Page weights are heavy-tailed — one
autoplaying video, one 4 MB ad creative — so the arms are compared as trimmed means
with a 95% interval around the difference, and a site whose interval covers zero is not
reported at all. Every per-site saving that appears is printed as "± so much", and the
sites that appear are the ones whose saving can be told apart from noise. Fewer rows,
each of which means something.

The second row improves on its own. Every time a URL a pack *would* rewrite is fetched
un-rewritten — because the pack is off, or because that load was a control — its size
goes on file, and from then on the saving on that URL is arithmetic. Those originals
are recorded on cache hits too, which is where most of a repeat visit's images come
from, so the file fills in from ordinary browsing rather than only from the loads a
control was spent on.

## Free and Plus

Byte Budget has a paid tier, and the line between the two is drawn on one principle:
**measurement is free, and so is every disclosure that makes it trustworthy.** The
accuracy percentage, the measured-versus-modelled split on Data Saved, the projection's
basis, the profile-scope admission and the privacy statement are free forever, because a
figure a reader cannot audit is not a preview of a better figure — it is a worse one, and
this project's whole argument is that it does not ship those.

What Plus holds back is depth, which also makes it the simplifier a first install wants:

| Free | Plus |
| --- | --- |
| All measurement, all four period tabs bar one, the whole popup, the plan cycle and the projection at full accuracy | — |
| Data Saver on/off, Light/Balanced/Maximum, site exceptions | The eight individual switches, the six image services, the holdout rate |
| The plan-wide limit, plus 3 site limits, daily | Unlimited site limits, and weekly/monthly/per-session windows |
| Alerts, theme, toolbar badge, retention, delete, storage report | Units, and the calendar-versus-rolling week and month rules |
| The last 7 days of reporting and export | Everything on disk — up to 400 days — reported and exported |
| The dashboard, the drill-down, the charts, both Data Saved figures | The third-party host table, and the per-site with/without comparison |

Two of those are worth spelling out because they are the ones easiest to get wrong.

**Retention is not the paid setting; the reporting window is.** The ledger keeps 400 days
for everyone. A free install draws and exports the last seven of them and the rest sit on
disk untouched, so subscribing reveals history that was already there and lapsing deletes
nothing. Gating retention instead would mean a billing event destroying data, which is not
a trade anyone agreed to.

**The plan cycle is exempt from the seven-day window.** The popup headline, the plan meter
and the projection read the whole cycle — up to 31 days — on the free tier. Clipping them
would not make the free tier smaller, it would make it wrong, and "will I make it to the
reset date" is the question the product exists to answer.

Nothing already configured is ever disabled by a lapse. The ceilings are on what can be
*added or changed*: eight limits set while subscribed keep running and stay editable, and
the ninth is what is refused.

Payments go through [ExtensionPay](https://extensionpay.com); `src/plus/` is all of the
code involved, and `PRIVACY_POLICY.md` describes the account key, reply and retention.

## What it stores, and where

Everything measured stays in the browser profile, and none of it is ever sent
anywhere. `default-src 'self'` in the manifest enforces that rather than promising
it. It has to start at `default-src`: this was written at first as `connect-src
'self'` alone, which covers `fetch` and leaves `new Image().src`, a stylesheet, a
font, a frame and a form submission free to reach any host on the internet. The
policy also pins `form-action 'none'` and `base-uri 'none'`, neither of which
inherits from `default-src` and both of which are exfiltration routes that need no
script at all.

There is one hole in that policy and it is deliberate: `connect-src` also allows
`https://extensionpay.com`, for the paid tier (see "Free and Plus"). A never-connected
free install makes no request. Starting a trial, subscribing or restoring creates an
opaque provider key stored locally; later checks send that key and no measured usage,
site name, limit or setting. The provider can return account fields, including an email;
`plus/provider.ts` reduces the reply immediately and persists only the paid state,
dates and plan interval. One origin is reachable, and it is named.

| Store | Holds | Kept for |
| --- | --- | --- |
| `daily` | bytes per site per day | 30 / 90 / 400 days, or forever |
| `hourly` | bytes per site per hour | 3 days |
| `hosts` | which hosts a site's bytes came from | with `daily`, switchable off |
| `visits` | one row per page load: site, origin, bytes | with `daily` |
| `sizeModel` | the learned size estimator | 5,000 keys, least-recently-used |
| `baselines` | observed sizes of un-rewritten image variants, keyed by digest | 60 days, or your retention if it is shorter; 3,000 keys |

`visits` deliberately holds the origin and no path or query. Per-page-load
averages need to know which site and how many bytes; anything more would make
this a browsing history, which is a different product with different stakes.

`baselines` used to hold the full third-party image URL as its key —
`pbs.twimg.com/media/<mediaId>`, `res.cloudinary.com/<cloudName>/…` — with no age
bound at all, so a profile that never reached three thousand rows kept its first
observation forever, outside every retention setting this file describes. The key is
a SHA-256 digest of the URL now. Nothing reads that store except by exact key, so the
plaintext was never needed for anything, and the rows age out on the shorter of sixty
days and your retention. Worth naming rather than fixing quietly: these rows
accumulate whether or not Data Saver is switched on, because the size of an original
has to be on file *before* the load that would have rewritten it.

Preferences — theme, badge, retention, whether per-host detail is recorded, your plan
size, the day the cycle resets, and which alerts you want — live in
`chrome.storage.sync` so they follow you between browsers. Nothing that names a site
goes with them: limits and the never-optimize list are lists of domains, which is a
browsing history in all but name, so they stay in `chrome.storage.local` on the
machine you set them on, and so does the record of which alerts have already fired.
Measurements never leave the device by either route. The cost is that a limit set on
one machine is not a limit on the next, which is a worse product and a better promise.

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
| `alarms` | a flush backstop, retention pruning, window rollover, and the alert sweep |
| `declarativeNetRequest` | refusing requests over budget, and rewriting image URLs to smaller variants. Rules are session-scoped, so nothing survives a browser restart |
| `notifications` | the only channel that reaches you before the bytes are spent. Three per allowance per window, at 75/90/100%, and switchable off — see [Alerts](#alerts) for what the install warning is being spent on |
| `favicon` | site icons from the browser's own cache, so a list of forty sites costs no requests |

## Layout

```
public/manifest.json     base manifest; a Vite plugin patches it per channel and
                         writes a root manifest pointing into dist/
src/core/                types, site keys, periods and billing cycles, formatting,
                         IndexedDB, messages, the projection
src/track/               webRequest listeners, reconciliation, the ledger, queries
src/limit/               budgets, the governor, tiers, rules, the in-page notice,
                         the allowance alerts
src/optimize/            features, packs, rules, savings, the control group
src/rules/session.ts     the single owner of declarativeNetRequest session rules
src/content/             three classic scripts: timing, notice, page optimizers
src/background.ts        the service worker: the only writer
src/popup.*              the 420px panel
src/dashboard.*          the full tab: charts, drill-down, savings, export
src/settings.*           the options page: plan and cycle, limits, Data Saver,
                         appearance, privacy and data
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
arrived at.

The blocks below are the script's own assertions with each line's run-specific
figures removed — the checks, not a transcript. The figures move with the fixture and
with Chrome, and quoting one run's numbers as if they were the claim is how a README
ends up describing a build that no longer exists.

**That the measurement is real:**

```
ok    the HTML document itself is counted
ok    the sized script is measured at full size
ok    the sized image is measured at full size
ok    the streamed fetch is measured from resource timing
ok    the local site appears in the dashboard
ok    measured …, expected between … and …
ok    measured share is …, expected 60% or better
```

The streamed fetch is the load-bearing one: it declares no `Content-Length`, so the
only way it can be counted at all is source (2). The total is asserted as a range —
floored at the two sized fixtures, ceilinged at 1.35× everything served — because
headers, favicon attempts and the streamed body sit inside it, and a pinned total
would be a test that fails on a Chrome update rather than on a regression. The
phase-1 verification recorded 770,830 bytes served against 771,820 counted, and the
990-byte gap is the halved header estimate across five requests; that pair is a
recorded observation in `PLAN.md`, not something the script asserts on every run.

**That a refusal costs zero,** with the server as the witness rather than the
extension:

```
ok    deleting usage empties every store
ok    enforcement installed … rule(s) for the site
ok    the site is recorded as limited
ok    the server was never asked for the image
ok    the script was still allowed through, so the block is selective
ok    no image bytes were counted
ok    the refusal is recorded
ok    every refusal is priced from the default, so the model really was deleted
ok    the script still arrived at full size
ok    the period total is the document plus the script and nothing else
ok    lifting the limit removes every rule
ok    the image loads again once the limit is lifted
```

The server records every path it was asked for, so this is not the extension vouching
for itself: with `lean` in force the image request never reached it, and the period
total is the document plus the script and nothing else. A refused request is never
dispatched, so it costs zero bytes — not "zero after we noticed". That is what makes a
byte budget enforceable rather than advisory.

The odd-looking line about the model is the sharpest check in the run. A refused
request has no size, so the credited saving can only have come from the estimator, and
the clear at the top of the block emptied it — so every refusal has to price at the
per-type default exactly. An earlier version asserted a range and passed while the
estimator was still answering from an in-memory copy of a table that had been deleted
from disk. A range is what let that hide.

**That a budget enforces itself,** with nothing set by hand:

```
ok    the budget is stored
ok    nothing is enforced before any traffic
ok    the governor counted the load live
ok    enforcement engaged from usage alone, no rules set by hand
ok    the live counter agrees with the stored ledger
ok    the over-budget load never asked for the image
ok    the page shows a notice
ok    the grant raises the allowance for this window
ok    and lifts enforcement
ok    the notice is withdrawn when the limit is lifted
ok    the image loads again after the grant
ok    removing the budget leaves nothing behind
```

The live counter and the stored ledger agree to within a rounding tolerance of each
other. They are two independent paths to the same number — one incremented per request
in memory, one read back off disk — and a limit firing against a total nothing else
agrees with would be indefensible.

**That the optimizers do what they say,** with the local server and Playwright's route
handler as the witnesses:

```
ok    pack "…" uses a pattern Chrome accepts
ok    an unoptimized load fetches the original variant
ok    the original size is now on file
ok    the Wikimedia thumbnail was requested at 800px, not 1600
ok    and the large variant was never requested
ok    the document carried Save-Data: on
ok    the analytics beacon was refused
ok    and the page's own beacon still went
ok    the rewrite is counted
ok    a saving is credited
ok    the measured part is never larger than the whole
ok    the saving is measured, not modelled
ok    no page-load comparison is claimed without samples on both sides
```

Two pairs there are worth reading twice. The beacon pair is what makes the "analytics"
label true: on one page load, one beacon to a listed analytics host is refused and the
page's own beacon to its own origin still goes. And the saving is measured because a
control load recorded what the 1600px variant weighs before the next load fetched the
800px one; the number is a subtraction of two observed sizes, and the line beside it
asserts that the measured part can never exceed the whole.

The last line is a check on restraint rather than on a feature: with samples on only
one side of the comparison, the report claims no page-load delta at all.

The script refuses to run against a `dist/` older than `src/`. Results from a stale
build are worse than no results, and they do not announce themselves.

It uses the pinned Playwright development dependency. Install the package dependencies
and the matching Chromium build once:

```sh
npm install
npx playwright install chromium
```

Add `--shots` to write ten screenshots into `outputs/`: the popup empty and over a
limit, the dashboard light and dark, Settings in five states including two phone
widths, and the in-page notice on a real page.

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

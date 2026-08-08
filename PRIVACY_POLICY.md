# Privacy policy — Byte Budget

Last updated: 8 August 2026

## The short version

Byte Budget measures how much data each website costs you. Everything it measures
stays in your browser profile. Nothing is uploaded, and the extension makes no
network requests of its own.

## What these numbers cover

One Chrome profile — this one. An extension is only shown the requests its own
browser profile makes, so a second Chrome profile, a different browser, native
apps, system and application updates, and every other device sharing a phone's
hotspot are all invisible here. That is part of why nothing has to leave your
device; it is also why this total can be a good deal smaller than the one on a
carrier bill, sometimes by a factor of several. Read it as "what my browsing in
this profile costs", not "what my plan is spending".

## What is stored on your device

- **Per-site byte counts**, per day and per hour: bytes received, bytes sent,
  number of requests, how much of the figure was estimated, and cache hits.
- **Per-host byte counts** inside each site, so the extension can show that a
  video CDN accounted for most of a page. Switchable off in settings.
- **One row per page load**, holding the site, the page's origin (scheme and host,
  such as `https://www.example.com`), the time, and the bytes. It holds **no path
  and no query string** — the extension does not record which pages you visited,
  only which sites and how heavy they were.
- **A size model**: an average response size per host and resource type, used to
  estimate responses whose size the browser did not report.
- **Observed image sizes**: when an image URL is one the extension can ask a
  service for a smaller version of, the size of the original is recorded against
  that URL. This is what lets it report a real saving rather than an estimate.
  These are image asset URLs on content delivery networks, not pages you visited.
- **Your settings**: theme, badge choice, how long byte counts are kept, whether
  per-host detail is recorded at all, and the display defaults (units, and how a
  week and a month are counted).
- **Your limits and your never-optimize list**: the domains you capped and the
  domains you excluded. These name sites, so they are held separately from the
  settings above and never leave this device — see "What leaves your device".

Byte counts are kept for as long as your retention setting says. There are four
choices and no others: 30 days, 90 days, 400 days, or keep everything. Hourly
detail is always dropped after three days regardless. You can delete everything at
any time, and export it all as CSV or JSON first.

## What is not stored

- No page contents, no request bodies, no form data. Upload sizes are read from
  the `Content-Length` request header, never from the body itself.
- No URLs beyond the site and origin described above.
- No cookies, credentials, or authentication tokens.
- No identifiers of you, your device, or your browser.

## One thing worth stating plainly about optimizing

When you switch optimizing on, the extension adds a `Save-Data: on` header to
requests and asks some image services for smaller files. That changes what those
services see: `Save-Data` tells them you would prefer a lighter page, and a
rewritten URL tells them which size you asked for. No request is sent anywhere it
was not already going, and nothing about you is put inside one — but the header
itself is new information about your browser, and it is worth being exact about
what kind.

`Save-Data` was once ordinary: Chrome sent it for everyone using Lite mode, which
was retired in Chrome 100, and desktop Chrome has offered no way to turn it on
since. So a desktop browser sending `Save-Data: on` in 2026 is uncommon, and it is
the same on every site it visits — which is the shape of signal that helps a
tracker tell one browser apart from the rest, whatever else it does about cookies.
Switching optimizing on makes this browser more distinguishable, not less. That is
the trade: fewer bytes, one more stable bit about you.

Today the header travels with the rest of optimizing — off until you turn
optimizing on, never sent to a site on the never-optimize list. A switch for this
one header, defaulting to off, is planned; the image packs deliver their savings
without it, and only some services honour it. Until that ships, the two go
together.

## What leaves your device

Nothing of yours. The extension has no server, no analytics, and no third-party
components. Its content security policy starts at `default-src 'self'`, so every
way an extension page could reach the network — a script, a stylesheet, a font, an
image, a frame, a `fetch` — resolves to the extension's own package and nothing
else, and forms have nowhere to submit to. Chrome enforces that; it is not a
promise about our own code. (Earlier versions of this file cited `connect-src
'self'` alone. That covers `fetch` and would have left an `<img>` free to reach any
host on the internet, which is a weaker claim than the one being made here.)

Your **preferences** — theme, badge, how long counts are kept, whether per-host
detail is recorded — are stored in Chrome's `storage.sync`, so they follow your
Chrome profile between your own devices if you have Chrome sync switched on. That
transfer is Chrome's, governed by Google's own privacy terms. None of those values
names a site.

Everything that does name a site stays here. Your limits and your never-optimize
list are lists of domains you care about — the most opinionated slice of a browsing
history there is — so they are kept in local storage on this device and are not
synced. The cost of that is real and worth stating rather than discovering: a limit
you set on your laptop does not appear on your desktop. Your measurements — byte
counts, per-host counts, page loads — never leave the device by either route.

## Why the permissions are needed

- **`webRequest`** and access to **`http://*/*` and `https://*/*`**: the extension
  counts network requests. It uses `webRequest` only to observe. Chrome only
  reports requests for hosts the extension has access to, which is why the access
  is broad; an extension that measured only some sites would not answer the
  question it exists to answer.
- **`declarativeNetRequest`**: to refuse requests once a site is over a limit you
  set, and to redirect image requests to smaller versions of the same file on a
  fixed list of image services compiled into the extension — `pbs.twimg.com`,
  `upload.wikimedia.org`, Photon (`i0-2.wp.com`), the Shopify CDN and Cloudinary.
  No other host is ever rewritten. These rules are evaluated by Chrome itself —
  the extension declares them and is not told about the individual requests they
  match, which is the point of the API. They are session-scoped and do not survive
  a browser restart.
- **`webNavigation`**: to know which site each tab is showing, so bytes are
  attributed to the page you were on rather than to a CDN hostname.
- **`scripting`**: for three small scripts, and no others. One reports the page's
  own resource transfer sizes, which is the only way to size a streamed response.
  One shows a notice when a site is being limited, so a refused image does not look
  like a broken website. One adjusts how the page asks for images and whether it
  loads things speculatively, and is registered only while optimizing is switched
  on — with it off, no script of the extension's runs on any page. None of them
  reads page content, form fields or text.
- **`storage`, `unlimitedStorage`**: to keep the counts.
- **`alarms`**: to write buffered counts and to delete data past its retention.
- **`favicon`**: to show site icons from the browser's existing cache, without
  fetching anything.

## Children

The extension is not directed at children and collects no personal information
from anyone.

## Where this lives

This file is the policy of record, but a policy only a developer can read is not a
policy. The Chrome Web Store requires one reachable at a stable public URL that
survives version changes, and the same URL belongs in the store listing's privacy
field and in the extension's `homepage_url` so the product itself links to it.

Not yet done, and the one thing a person has to do by hand before submitting: the
manifest currently carries the placeholder `https://REPLACE-ME.example/byte-budget`.
Publish this document at a real URL, put that URL in the store listing, and replace
the placeholder with it.

## Changes

Material changes to this policy will be published with a new version of the
extension and a new date at the top of this file.

## Contact

xiangli3625@gmail.com

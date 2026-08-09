# Privacy policy — Byte Budget

Last updated: 8 August 2026

## The short version

Byte Budget measures how much data each website costs you. Everything it measures
stays in your browser profile, and none of it is ever uploaded.

If you start a trial, subscribe, or restore a subscription, the extension checks
that account with extensionpay.com. It sends an opaque account key and never sends a
usage figure, site name, limit, or setting. ExtensionPay can return account and
subscription fields; Byte Budget keeps only the paid state, relevant dates and plan
interval, and discards fields it does not use. A free install that has never opened
one of those account flows has no key and makes no subscription request. Details are
under "The subscription check" below.

## What these numbers cover

One Chrome profile — this one. An extension is only shown the requests its own
browser profile makes, so a second Chrome profile, a different browser, native
apps, system and application updates, and every other device sharing a phone's
hotspot are all invisible here. That is part of why nothing has to leave your
device; it is also why this total can be a good deal smaller than the one on a
carrier bill, sometimes by a factor of several. Read it as "what my browsing in
this profile costs", not "what my plan is spending".

The extension asks for your plan size and the day it resets, and compares its own
figure against them. That makes the gap more important rather than less: it
puts a Chrome-profile total on one side and a whole-plan allowance on the other, so
"10 GB of 15 GB" is a floor on what the plan has spent and not a reading of it. The
plan size is a number you type in; nothing checks it against a carrier, because the
extension has no way to ask one and does not try.

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
  service for a smaller version of, the size of the original is recorded so a real
  saving can be reported rather than an estimate. These are image assets on content
  delivery networks, not pages you visited.

  What is stored is a **SHA-256 digest of the URL**, not the URL. Earlier versions
  kept the full address — `pbs.twimg.com/media/<mediaId>` and the like — and kept it
  indefinitely, because the store was capped by row count and nothing else, so a
  profile that never reached three thousand rows held its first observation for good.
  Nothing ever reads that store except by looking up a URL it already has in hand, so
  the readable form was never needed. The rows now also expire: sixty days, or your
  retention setting if that is shorter.
- **Your settings**: theme, badge choice, how long byte counts are kept, whether
  per-host detail is recorded at all, the display defaults (units, and how a week and
  a month are counted), the size of your data plan, the day of the month it resets,
  and which usage alerts you want.
- **Which alerts have already been sent**: for each allowance, the current window and
  the thresholds announced in it, so the same warning is not repeated. It names the
  sites you set limits on, so it is held on this device with them — see "What leaves
  your device". Deleting your recorded usage clears it too.
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
- No identifier is attached to the browsing measurements. If you use a Plus account,
  the extension separately stores an opaque ExtensionPay account key and its reduced
  subscription status as described below.

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

The header now has its own switch, separate from the rest of optimizing, so you can
have the image packs — which deliver their savings deterministically, without telling
anyone anything — and not this. Being exact about the default: it is **on** whenever
optimizing is on, and optimizing itself ships off, so nothing sends `Save-Data` until
you turn optimizing on and nothing sends it to a site on your never-optimize list. If
the paragraph above matters to you more than the bytes do, that one switch is where
to turn it off.

## And one about alerts

The extension can now show a desktop notification when an allowance passes 75%, 90%
or 100%. That is new in kind rather than in degree: everything else here is something
you go and look at, and a notification arrives whether you were looking or not.

Nothing is transmitted to send one. The figures come from the counts already on this
device, Chrome draws the notification, and no request leaves the machine. The privacy
question is a different one, and it is about your screen rather than your network: a
notification is readable by anyone who can see the display, and it is captured by
screen recording and screen sharing along with everything else.

A plan alert names no site — "75% of your data allowance used" and two byte figures. A
per-site alert names the site. That is one of the reasons per-site alerts are off by
default and plan alerts are on; the other is in `README.md`. Both are switchable, and
switching them off is enough — the extension asks Chrome for a notification only when
it is about to show one, so with alerts off it never asks.

## What leaves your device

None of the measured usage, site names, limits, exceptions, or learned request sizes
leaves your device. The extension has no analytics. Its content security policy
starts at `default-src 'self'`, so every way an extension page could reach the network
— a script, a stylesheet, a font, an image, a frame, a `fetch` — resolves to the
extension's own package and nothing else, and forms have nowhere to submit to. The one
exception is written into the policy and is visible in the manifest: `connect-src`
also allows `https://extensionpay.com`, which is the subscription check and nothing
more. Chrome enforces all of that; it is not a promise about our own code. (Earlier
versions of this file cited `connect-src 'self'` alone. That covers `fetch` and would
have left an `<img>` free to reach any host on the internet, which is a weaker claim
than the one being made here.)

## The subscription check

Byte Budget has a paid tier. Everything that measures, reports and limits your usage
is in the free tier and stays there; what is paid for is a set of settings and a longer
reporting window.

**Before an account flow.** A free install that has never started a trial, subscribed,
or restored a subscription has no provider key. Checking its tier is answered locally
and makes no request.

**What is sent.** Starting one of those account flows creates an opaque account key,
stores it in `chrome.storage.local`, and sends it to `https://extensionpay.com` when
checking the account. No usage figure, site name, hostname, limit, preference, or part
of the measurement database is sent. The key is not stored in Chrome Sync.

**What comes back.** ExtensionPay's account response may contain an email address,
payment and trial dates, a plan, and subscription status. Byte Budget reduces that
response immediately to whether Plus is active, the reason, the relevant dates, and
the plan interval. That reduced status is stored locally. The email and the rest of
the provider response are not stored by Byte Budget and are not synced.

**How often.** Once a provider key exists, the check runs about four times a day while
the browser is running, plus immediately after a payment or a trial starts. The answer
is cached, so being offline does not lock anything: a check that cannot be made leaves
the previous answer in place rather than downgrading it.

**Payment.** Handled on [ExtensionPay](https://extensionpay.com), which uses Stripe.
If you subscribe, you give them an email address and payment details on their pages.
Card details never enter this extension. As described above, the account response can
include the account email; Byte Budget discards it and stores only its reduced status.
ExtensionPay's and Stripe's handling of the account and payment data is governed by
their policies.

**Turning it off.** There is no switch once an account has been connected. The check
is what keeps a trial or subscription current; disabling it would silently disable the
feature it is attached to. A never-connected free install makes no check.

Your **preferences** — theme, badge, how long counts are kept, whether per-host
detail is recorded, your plan size, your reset day, and which alerts you want — are
stored in Chrome's `storage.sync`, so they follow your Chrome profile between your own
devices if you have Chrome sync switched on. That transfer is Chrome's, governed by
Google's own privacy terms. None of those values names a site: a plan size is a number
of bytes, a reset day is a day of the month, and the alert preferences are two
switches.

Everything that does name a site stays here. Your limits and your never-optimize
list are lists of domains you care about — the most opinionated slice of a browsing
history there is — so they are kept in local storage on this device and are not
synced. The record of which alerts have already fired stays with them, for the same
reason and no other: it is keyed by the sites you capped. The cost of that is real and
worth stating rather than discovering: a limit you set on your laptop does not appear
on your desktop. Your measurements — byte counts, per-host counts, page loads — never
leave the device by either route.

## Chrome Web Store Limited Use

Byte Budget's use of information received from Chrome APIs complies with the Chrome
Web Store User Data Policy, including its Limited Use requirements.

- Request metadata and browsing measurements are handled only because they are
  strictly necessary to provide Byte Budget's disclosed single purpose: measuring and
  reducing the network data used by Chrome browsing.
- That data is not sold, used for advertising, used for credit or lending decisions,
  or transferred for purposes unrelated to that single purpose.
- The developer cannot read the locally stored browsing data. A human sees it only if
  you deliberately send an export for support, or where access is required for security
  or legal compliance.
- Browsing measurements and site lists are not transferred to ExtensionPay, Stripe or
  any other third party. The subscription exchange described below is limited to its
  opaque account key and the account fields needed to determine Plus access.

## Why the permissions are needed

- **`webRequest`** and access to **`http://*/*` and `https://*/*`**: the extension
  counts network requests. It uses `webRequest` only to observe. Chrome only
  reports requests for hosts the extension has access to, which is why the access
  is broad; an extension that measured only some sites would not answer the
  question it exists to answer.
- **`declarativeNetRequest`**: for three things, all of them lists compiled into the
  extension. To refuse requests once a site — or the browser as a whole, if you set a
  total limit — is over a limit you set. To redirect image requests to smaller
  versions of the same file on a fixed list of image services: `pbs.twimg.com`,
  `upload.wikimedia.org`, Photon (`i0-2.wp.com`), the Shopify CDN and Cloudinary. No
  other host is ever rewritten. And, while optimizing is on, to refuse beacons sent to
  a fixed list of nineteen analytics domains — beacons to any other destination,
  including the site's own, are left alone, because that is also how a page saves your
  work as you close the tab. These rules are evaluated by Chrome itself — the
  extension declares them and is not told about the individual requests they match,
  which is the point of the API. They are session-scoped and do not survive a browser
  restart.
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
- **`alarms`**: to write buffered counts, to delete data past its retention, and to
  check allowances against their thresholds.
- **`notifications`**: to tell you an allowance is running out, at 75%, 90% and 100%
  of it. Nothing else uses this permission, no notification is sent for anything but
  a limit you set, and it is bounded at three per allowance per window. Turning both
  alert switches off stops the extension asking Chrome for one at all.
- **`favicon`**: to show site icons from the browser's existing cache, without
  fetching anything.

## Children

The extension is not directed at children and collects no personal information
from anyone.

## Where this lives

This file is the policy of record, but a policy only a developer can read is not a
policy. Before submission, publish it at a stable public URL and put that direct URL in
the Chrome Web Store Privacy practices field. The extension intentionally declares no
`homepage_url`; a product homepage is not required for the policy link to work.

## Changes

Material changes to this policy will be published with a new version of the
extension and a new date at the top of this file.

## Contact

xiangli3625@gmail.com

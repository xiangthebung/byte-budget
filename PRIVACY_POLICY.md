# Privacy policy — Byte Budget

Last updated: 31 July 2026

## The short version

Byte Budget measures how much data each website costs you. Everything it measures
stays in your browser profile. Nothing is uploaded, and the extension makes no
network requests of its own.

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
- **Your settings**: theme, units, period definitions, retention, badge choice,
  any data limits you set, and which optimizers you have switched on or off.

Byte counts are kept for as long as your retention setting says: 30, 90 or 400
days, or indefinitely. Hourly detail is always dropped after three days. You can
delete everything at any time from the dashboard, and export it all as CSV or
JSON first.

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
rewritten URL tells them which size you asked for. No new information about you is
sent, and no request is sent anywhere it was not already going — but the requests
themselves are not byte-for-byte what the page would have made, and that is worth
knowing rather than discovering.

Any site can be put on a never-optimize list, and the whole feature is off until
you turn it on.

## What leaves your device

Nothing of yours. The extension has no server, no analytics, and no third-party
components. Its content security policy restricts network access to the extension
itself (`connect-src 'self'`), which enforces this rather than promising it.

Your **settings** — not your measurements — are stored in Chrome's `storage.sync`,
so they follow your Chrome profile between your own devices if you have Chrome
sync switched on. That transfer is Chrome's, governed by Google's own privacy
terms, and carries no browsing data.

## Why the permissions are needed

- **`webRequest`** and access to **`http://*/*` and `https://*/*`**: the extension
  counts network requests. It uses `webRequest` only to observe. Chrome only
  reports requests for hosts the extension has access to, which is why the access
  is broad; an extension that measured only some sites would not answer the
  question it exists to answer.
- **`declarativeNetRequest`**: to refuse requests once a site is over a limit you
  set, and to redirect image requests to smaller versions of the same file on the
  services listed in the dashboard. These rules are evaluated by Chrome itself —
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

## Changes

Material changes to this policy will be published with a new version of the
extension and a new date at the top of this file.

## Contact

xiangli3625@gmail.com

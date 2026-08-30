# Chrome Web Store submission copy — Byte Budget

This file is the paste-ready source for the Store dashboard. Keep it aligned with the
manifest, `PRIVACY_POLICY.md`, `TERMS_OF_SALE.md`, and the behavior of the uploaded ZIP.

## Single purpose

Help people understand and reduce the network data used by their Chrome browsing by
measuring per-site traffic locally, applying limits they choose, and optionally asking
sites for lighter resources.

## Short description

See what each site costs you in data — session, today, week, month. Usage measurements
stay in this Chrome profile.

## Detailed description

Byte Budget shows how much network data each site uses in this Chrome profile. See a
session, day, week or month at a glance, open a per-site breakdown, and export the
figures as CSV or JSON.

Set a plan-wide allowance or daily limits for individual sites. As a limit fills, Byte
Budget can progressively refuse heavy resources such as video and images, or stop
subresources only after the allowance is spent. Page HTML remains available so the
site can explain what happened.

Data Saver can request smaller versions of known image-service URLs, avoid selected
background transfers, and report measured and modelled savings separately. It ships
off and is controlled by the user.

Important scope and privacy facts:

- Byte Budget handles the domains and network resources requested by this Chrome
  profile so it can produce the report. Stored page-load rows contain a site and origin,
  never a path, query string, page text, form value, cookie or request body.
- Measurements, site names, limits and exceptions stay in this browser profile.
  Non-site preferences can follow the user through Chrome Sync.
- A never-connected free install makes no subscription request. Starting a trial,
  subscribing or restoring creates an opaque local ExtensionPay key. Account checks
  send that key and no usage or site data. ExtensionPay can return an account email and
  subscription fields; Byte Budget keeps only reduced subscription state and discards
  the rest. Card details stay on ExtensionPay and Stripe's pages.
- The figures cover Chrome on this device, not other browsers, profiles, apps, system
  updates, or other devices sharing the connection.

Free includes all measurement, the dashboard, daily limits, standard Data Saver levels,
alerts, export of the recent window and the plan projection. Byte Budget Plus adds
longer reporting and export, additional limit windows, more site limits, individual
Data Saver controls, third-party host detail and appearance options. Plus is CA$0.99 per
month or CA$7.99 per year (CAD), with a 14-day trial. Subscriptions renew until cancelled.
The developer of Byte Budget, not Google, is the seller. Cancellation and refund terms
are displayed inside the extension before checkout.

## Permission justifications

- `storage`: save preferences, limits, reduced subscription status and buffered counts.
- `unlimitedStorage`: retain the locally recorded history for the selected retention
  period, including the user's “keep everything” option.
- `webRequest`: observe request and response metadata needed to count bytes. It is not
  used as a blocking Web Request API.
- Access to `http://*/*` and `https://*/*`: Chrome reports Web Request details only for
  hosts the extension may access; measuring only selected sites would make the report
  incomplete.
- `webNavigation`: associate subresource traffic with the site currently shown in a tab.
- `declarativeNetRequest`: install user-selected limit rules and the optional fixed Data
  Saver rules for smaller image variants and selected background requests.
- `scripting`: report Resource Timing transfer sizes, show a limit notice, and run the
  optional page-side Data Saver features. The scripts do not read page text or forms.
- `alarms`: flush buffered counts, roll allowance windows, refresh alerts and prune data.
- `notifications`: show the 75%, 90% and 100% allowance alerts selected by the user.
- `favicon`: display site icons from Chrome's favicon cache without fetching them.

## Published policy URLs

Paste these into the Developer Dashboard. They are live now — check them before
you submit rather than after, because a reviewer following a dead privacy link is
a rejection, and this collection has already shipped one extension whose in-product
legal links pointed at a host that did not exist.

```
Privacy policy   https://personal-website.xiangli3625.workers.dev/legal/byte-budget/privacy
Terms of sale    https://personal-website.xiangli3625.workers.dev/legal/byte-budget/terms
```

The copy in this repository is the original. The portfolio site keeps a vendored
copy and its test suite diffs the two, so edit the file here and re-copy — never
the published page on its own.

## Privacy practices selections

Disclose these categories while the current implementation is shipped:

- Web history: domains, origins and requested resources are handled to measure browsing;
  stored page-load records omit paths and queries.
- Personally identifiable information: an ExtensionPay account reply can contain the
  account email; Byte Budget discards it and does not persist or sync it.
- Financial and payment information: plan interval, paid state and payment/trial dates
  are received and reduced to local subscription status; card details never enter the
  extension.
- Authentication information: the opaque ExtensionPay account key is stored locally and
  sent only to ExtensionPay for account checks.

Select **No, I am not using remote code**. All executable JavaScript is packaged in the
extension. The ExtensionPay response is data, not code.

Certify that data is used only for the disclosed user-facing features, is not sold or
used for advertising or credit decisions, and is not read by humans except for the
policy's support/legal exceptions. Put this direct GitHub URL in the Privacy policy
field:

https://github.com/xiangthebung/byte-budget/blob/master/PRIVACY_POLICY.md

No product homepage URL is declared in the manifest.

## Reviewer test instructions

1. Pin Byte Budget or open it from `chrome://extensions`.
2. Browse an ordinary HTTP or HTTPS page, then open the popup and Dashboard to see the
   site and byte totals.
3. In Settings, set a daily limit for the current site. A small test limit demonstrates
   the limit notice and progressive resource refusal.
4. Turn on Data Saver and choose Light, Balanced or Maximum; the Dashboard reports
   measured and modelled prevented data separately.
5. To review Plus, open Settings → Plus → **I already subscribed** and use the reviewer
   ExtensionPay credentials supplied privately in the Store Test instructions field.
   Do not place credentials in this repository or the public listing.

## Graphic assets

Generated by `npm run store:assets` into `store-assets/`:

- Five 1280×800 current-product screenshots.
- One 440×280 small promotional tile.
- The 128×128 Store icon is `public/icon.png`.

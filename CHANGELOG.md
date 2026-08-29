# Changelog

Notable changes to Byte Budget, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The documentation is now checked by the test suite.** `tests/docs.test.mjs` reads
  facts out of the source and asserts the documents contain them: every file path they
  name exists and is unambiguous, every `npm run` they suggest is real, every manifest
  permission is justified in both the privacy policy and the store listing, and the
  prices, trial length, alert thresholds, retention options, analytics-domain count and
  image-rewrite hosts all match the constants they are copied from. Adding a tracked
  Markdown file the test does not cover fails the suite. This closes the one class of
  defect nothing else in the project could see — a document that is wrong is invisible
  to a typecheck, a linter and a browser test alike — and it was written because three
  documents had drifted into stating that the project had no internationalization, no
  CI and no version control, all of which were false.
- **Two tests pinning that the session total is handed out as a copy.** Written as a
  pair on purpose: a shallow copy passes the first and fails the second.

### Fixed

- **A tab that closed while the service worker was asleep never finished its visit.**
  `ensureTabsReady` reconciled the record away without calling `finishVisit`, so the row
  kept no `endedAt`, `visitObserver` never fired, and the load was invisible to the
  optimizer's on-versus-off comparison. Invisible rather than wrong — but the loads that
  end while nothing is watching are not distributed evenly across the two arms, so a
  comparison that silently drops them is not obviously unbiased either.
- **`sessionUsage()` handed out the ledger's live totals.** All seven callers happened
  to copy before mutating, so nothing was wrong yet; one `addTotals` against the returned
  map would have added straight into the session count, and the result would have looked
  like traffic rather than like a bug. It returns a copy now, `byType` included.
- **The privacy policy did not mention the throttle build's `debugger` permission.** The
  README documents a second build channel that takes a permission the published one does
  not, and the policy's permission section did not acknowledge it existed. A policy that
  is silent about a capability is the same defect as one that is wrong about it.
- **The privacy policy named two image services in prose rather than by host.** "The
  Shopify CDN and Cloudinary" now reads `cdn.shopify.com` and `res.cloudinary.com`,
  which is what the sentence "no other host is ever rewritten" needs in order to be
  checkable — and is now checked.
- **Stale GitHub links.** `README.md` and `STORE_LISTING.md` pointed at
  `network-data-tracker`, which the repository has not been called since it was renamed
  to `byte-budget`. The second is the URL that goes in the Chrome Web Store's privacy
  policy field, so a dead link there is a submission blocker.

### Changed

- **Four documents became two.** AUDIT.md, PLAN.md and NEXT_AI_HANDOFF.md — 217 KB
  between them — were replaced by `ARCHITECTURE.md` (design, the navigation map, the
  invariants and the traps) and `STATE.md` (baselines, what is open, the release
  checklist). Split by how fast a fact goes stale rather than by topic, so every fact
  has one home. The three deleted files each claimed to be the source of truth and
  contradicted each other on load-bearing behaviour: the parked-request TTL was
  documented as both 8 s and 15 s, budgets as living in both `chrome.storage.sync` and
  `local`, and one deferred defect as both open and fixed. Every source comment that
  cited them now cites a named section of `ARCHITECTURE.md`; `git log` has the originals.
- **The popup no longer shifts when the period changes.** The pace verdict is emptied
  rather than removed from the flow, and the scrollbar gutter is reserved on both the
  page and the site list — so switching to `session`, which has no previous window to
  compare against, no longer steps every block below the headline up by a row and
  sideways by a scrollbar.

### Added

- **A paid tier, and a seventh settings section for it.** Byte Budget Plus is CA$0.99 a
  month or CA$7.99 a year (CAD), with a 14-day trial, handled by
  [ExtensionPay](https://extensionpay.com). The line between free and paid is drawn on
  one rule: **measurement is free, and so is every disclosure that makes it
  trustworthy.** The accuracy figure, the measured-versus-modelled split on Data Saved,
  the projection's basis, the profile-scope admission and the privacy statement are all
  free and stay that way. What Plus unlocks is depth — the fourteen individual Data
  Saver switches, site limits past three and windows longer than a day, reporting and
  export past seven days, the third-party host table, the per-site savings comparison,
  and the units and week/month rules. Which is also the answer to a problem the settings
  page has had since it was built: a first install now meets one Data Saver choice
  instead of fourteen.
- **Locked controls stay on screen, and say what they are.** A ceiling greys the control
  and puts a sentence in front of it saying what the free tier does instead — rather than
  hiding it, which would make the product look like it has fewer features than it does
  and leave nothing to explain why a chart stops where it does. An option inside a
  segmented control carries a padlock, a tooltip and an accessible name ending "Part of
  Byte Budget Plus", and pressing it opens the Plus section rather than doing nothing.
- **A disabled state for the shared buttons and fields.** The design system had none, so
  every disabled control had been borrowing the dimming of whatever box it happened to
  sit in.
- **The first-run page says where to find the extension afterwards.** Byte Budget is
  used from a toolbar button, and Chrome starts a newly installed extension hidden
  behind the puzzle-piece menu — so nothing in the product had ever mentioned the one
  step that makes its main surface reachable. The panel also says that pinning is
  optional, because measurement does not depend on it.

### Changed

- **The privacy claim is narrower, because it had to be.** Nothing measured is uploaded.
  A never-connected free install makes no subscription request; starting a trial,
  subscribing or restoring creates an opaque ExtensionPay key stored locally. Checks
  send that key and no usage or site data. The provider's reply can contain account
  fields including an email, so the extension now reduces it immediately, stores only
  paid state, dates and plan interval, and says exactly that in the product and policy.
  Card details remain on ExtensionPay and Stripe's pages. The manifest's `connect-src`
  names the one reachable origin.
- **Nothing already configured is disabled by a lapse.** The ceilings are on what can be
  added or changed, never on what exists: eight limits set while subscribed keep running
  and stay editable after a subscription ends, and it is the ninth that is refused. A
  failed subscription check never removes access either — the last successful answer
  stands, marked as old, because being on a plane is not evidence of not having paid.
- **Retention stayed free; the reporting window is what is paid for.** The ledger keeps
  400 days for everyone. A free install draws and exports the most recent seven and the
  rest sit on disk untouched, so subscribing reveals history that was already recorded
  and lapsing deletes nothing. Gating retention would have made a billing event destroy
  data, which is a different kind of thing entirely.
- **The plan cycle is exempt from that window.** The popup headline, the plan meter and
  the projection read the whole cycle — up to 31 days — on the free tier. Clipping them
  to seven would not have made the free tier smaller, it would have made it wrong, and
  "will I make it to the reset date" is the question the product exists to answer.
- **A limit can no longer refuse the subscription check.** The limit over Everything
  installs an unscoped block rule, so at its strictest tier it would have taken out both
  the check and every asset on the payment page — leaving someone unstyled text at the
  moment they were trying to subscribe, and silently demoting a paying customer for
  hitting the limit they were paying to manage. One `allow` rule at a higher priority
  covers extensionpay.com and nothing else.
- **A disabled option in a segmented control can no longer be chosen with the keyboard.**
  Arrow keys move *and* activate in a radio group, so a locked option left in the ring
  would have been reachable by pressing Right. Found while building the locks; it is a
  general fix to the shared control.
- **A locked option is no longer a control that looks ordinary and does nothing.** The
  first version set `disabled` and dimmed to 45%, which sounds sufficient and was not:
  on a light panel "30 days" beside "7 days" was all but indistinguishable, so the
  segment read as available, ignored the press, and never said why. It now carries a
  padlock — a difference people read rather than one they notice by comparison — and
  activating it opens the Plus section. `aria-disabled` stays, because "present but not
  selectable" is the truthful claim; `disabled` would have removed it from the
  accessibility tree entirely and hidden the tier boundary from screen readers.
- **"Set limit" no longer looks live while it is disabled.** At the free tier's limit
  ceiling the add-limit form is disabled top to bottom, and the primary button sat under
  a faded form in full accent green. The rows fade because `[data-locked]` dims them;
  the button is a direct child of the row and was reached by nothing. Controls state
  their own availability now instead of inheriting an ancestor's opacity.
- **Export ranges the free tier cannot pick say so in their label** — "Last 90 days —
  Plus". A `<select>` option has no tooltip anyone will find and no room for a glyph, so
  a greyed row with no explanation was the same defect in a different control.
- **An empty dashboard says it is empty.** A fresh install used to open on eight panels
  of confident nothing: a "100% measured" badge over 0 B, a daily chart drawing a date
  axis over thirty invisible bars, and a Data Saver panel presenting two 0 B figures,
  the holdout note, the 95% interval rule and the "needs five loads on both sides"
  line to someone who has never switched it on. The accuracy badge is dropped when
  there is no total to qualify, the chart says "Nothing recorded yet", and the Data
  Saver panel holds one sentence until it has something to report. Nothing was deleted:
  every figure and every disclosure returns with the first byte. The page is a third
  shorter before you have browsed anything.
- **The storage table no longer contradicts itself.** Seven counts of zero over "Disk
  in use 81.1 kB" reads as one of the two figures being invented. Both are right — an
  empty IndexedDB is not a zero-byte one — and the note now says so while that is the
  whole explanation.
- **Data Saver is introduced by what it is for, then by how it works.** The first-run
  description opened on "Asks known image CDNs…", which is four words of jargon in
  front of the product's main feature. It now opens on "Asks sites for less, so a page
  costs fewer bytes to open" and names the same three behaviours after it.
- The popup's limit card, on a tab that is not showing a website, leads with the reason
  and what to do rather than with what Byte Budget cannot limit. It is the first thing
  anyone sees who clicks the toolbar button on the new-tab page.
- "Site limits" in the settings rail reads "None" instead of nothing when there are no
  limits, matching "No plan set" and "Off" on the two items above it.
- **The settings page is six sections behind a rail, not one six-screen scroll.**
  Every control is a row — what it is on the left, the control on the right — and
  the paragraph that used to sit above each one is now either the two lines beside
  it or behind a disclosure. Data plan, Data Saver, Alerts, Appearance and Privacy
  are two or three rows each.
- **Data Saver is one choice: Light, Balanced or Maximum.** The eight per-feature
  switches and the six image-service switches are still there, under Advanced, with
  their descriptions and impact meters. A set matching no level reads "Custom" and is
  left exactly as it is.
- **Plainer words for what a limit does.** "Shed weight" and "Hard stop" are now
  "Cuts back gradually" and "Stops at the limit", on every surface. A site limit is
  asked the same question the plan is, instead of a switch labelled "Hard cap".
- **The plan size saves when you leave the field**, like every other control on the
  page. Its Save button is gone.
- The list of site limits is a card per limit at every width, rather than a
  six-column table that turned into one on a phone.
- Units and the week/month counting rules moved into Appearance → Advanced.

- Group headings on the settings page use the same treatment as the dashboard's panel
  headings, so the two surfaces read as one product.
- **Shorter copy on the dashboard.** The plan panel no longer explains twice that there
  is no plan, the enforcement note points at the button under it instead of naming the
  all-sites limit, and the measurement and comparison notes say the same things in
  fewer words. Nothing they disclose was dropped — the measured-versus-modelled split,
  the 95% interval rule and the profile-scope admission all still read in full.
- Prose on the dashboard is 12px. Eleven was the size for a gloss under a figure, and
  it was also being used for three-paragraph explanations.

### Fixed

- **The popup told you how to switch Data Saver off, next to a button offering to turn
  it on.** The row's description ended "Switch it off again from here, for this site or
  for everything" — an instruction for a state the reader was not in.
- **Seven strings in the shared chart module were never translated.** "Everything else"
  in both breakdown legends, the two-tone key, the headings and caption of the value
  table a screen reader reads instead of the picture, and the whole spoken summary of
  every chart in the product — assembled from English fragments while the rest of the
  UI followed the browser's language. Text that is correct and read aloud in the wrong
  language is worse than text left untranslated; all of it now comes from the
  catalogue, and the chart tests assert the words rather than the key.

- **The Data Saver tile captions were cut off mid-sentence.** They read "Original sizes
  on file, minus what the sma…" and "The size model's guess for requests refus…" — the
  two sentences that say which figure is measured and which is modelled, truncated to
  the half that says nothing. Captions wrap now, and the two tiles fill the panel
  instead of being capped at 240px with 600px of empty space beside them.
- The last row of a table drew a hairline under its label and none under its figure, so
  the storage panel ended in a rule that stopped halfway across.
- The shorter of the two bottom panels was stretched to match the taller one, leaving a
  bordered card with a paragraph at the top and a few hundred pixels of nothing below.
- **The page no longer jumps when you switch between the dashboard and settings.**
  The two had drifted apart in four ways at once: settings was 60 px narrower, so both
  centred 30 px apart; the Dashboard/Settings switch sat in a different place on each;
  the settings header was a line shorter, so everything below it started 18 px higher;
  and the scrollbar appeared on one and not the other. The frame is now one frame, and
  the browser test measures it on both pages and fails if they disagree.
- **Four buttons opened the settings page and ignored the section they named.** The
  popup's "Set a plan" and "Manage limits", and two links on the dashboard, still
  pointed at fragments from an earlier layout. The section names are now shared and
  typed, so naming one that does not exist fails the build.

## [0.1.0] — unreleased

The first release, and not yet submitted to the Chrome Web Store. Nothing below
is a change against a published version, because there is no published version:
this entry says what 0.1.0 **is**. A short account of how it got here is at the
end.

Byte Budget measures what each site costs you in bytes, holds sites — or the
whole browser — to a limit you set, and reports what optimizing them actually
saved. It runs in one Chrome profile, on your machine, with no account and no
network request of its own.

The rule the whole product is built around: **a measured number and a modelled
number are never added together.** Where the extension has to estimate, it says
so, says how much of the figure is estimate, and keeps the two totals separate
all the way to the CSV.

### Added

**Measurement.** Per-site, per-host and per-page-load byte counts, from a
three-source waterfall — a declared `Content-Length` first, the page's own
`transferSize` from Resource Timing second, and a per-`host|type` learned mean
only where neither exists. Every row carries how much of it was estimated, so
"93% measured" is computed rather than asserted. Request and response header
bytes are counted from their names and values and halved as a rough allowance
for HPACK/HTTP/2 compression; WebSocket frames, `Cookie` headers and cancelled
bodies are counted as zero, and all of that is stated in the product rather than
only in the code.

**Limits.** A budget can cover one site or everything (`#all`). Periods are
session, day, week and month; shapes are progressive — which walks a site down a
tier ladder as it approaches the cap — and hard, which stops at it. Enforcement
is Declarative Net Request session rules, so no request content is ever read.
When a limit starts refusing subresources the page gets an in-page notice saying
which limit is biting and how to lift it, because a limit with no explanation is
indistinguishable from a broken website.

**Data Saver.** Off by default. Eight page-level optimizers — five on once you
enable it, three opt-in, each labelled by how visible its effect is — plus six
URL-rewrite rules across five image CDNs, every one with its own switch and every
one pinned by tests asserting it matches what it claims and nothing else.
Per-site exclusions.

**Savings measurement, as a controlled experiment.** A randomised holdout leaves
a share of page loads unoptimized so the saving can be a subtraction between two
arms rather than a model's opinion of itself. The rate is a setting, the cost of
running it is stated where it is set, and zero is one of the options. Reported
figures use a trimmed mean with a 95% interval, and a site whose interval
straddles zero is not reported at all. The dashboard prints **Measured** and
**Estimated** as two separate tiles.

**A plan, and a cycle.** A data plan in bytes and a reset day from 1 to 28
(capped at 28 because every month has one). Monthly windows are placed from the
cycle start, not from the 1st, so the "this month" figure is the figure on the
bill.

**Projection and alerts.** A forecast from a winsorised rate over the last 14
finished days, which refuses to answer at all before five finished days or a
fifth of the cycle have passed, and which carries a plain-English statement of
what it assumed. Notifications at 75%, 90% and 100% of an allowance, deduped per
window across service-worker restarts. Plan-level alerts default on, per-site
off.

**Four surfaces.** A popup that answers "how am I doing" with a denominator and a
reset date; a dashboard with per-site detail, type breakdown, hosts and page-load
weights, and limit controls on the site you are looking at; a settings page
ordered plan → Data Saver → limits; and a two-question first-run page, because
every number in the product means more once it knows what your plan is.

**Data controls.** CSV and JSON export, a retention setting, a switch for
per-host tracking, and delete — per site, per range, or everything.

**Two build channels.** The store build, and a `dist-throttle/` build that adds
bandwidth throttling via `chrome.debugger`. The throttling code and the
`debugger` permission are compiled out of the store build rather than merely
switched off in it.

### Security

- Limits and the never-optimize list are stored in `chrome.storage.local`, not
  `sync`. Both carry site keys, which is the most opinionated slice of a
  browsing history there is, and the privacy policy promises the sync transfer
  carries no browsing data.
- The content security policy sets `default-src`, `form-action` and `base-uri`.
  `connect-src` alone was presented in two user-facing documents as proof the
  extension makes no network request of its own, and on its own it does not see
  an `img` src, a form post or a prefetch.
- Optimizer baselines are keyed by a SHA-256 digest instead of the full
  third-party image URL, and age out. They used to be the one store retention
  did not reach.
- CSV export escapes leading `=`, `+`, `-`, `@`, tab and CR, so a hostile site
  name cannot become a formula in a spreadsheet.
- The `Save-Data` header is disclosed as what it is — a fingerprinting bit that
  makes the browser more distinguishable — and has its own switch. It is only
  sent when Data Saver is on, which is not the default.
- Every figure in the product covers one Chrome profile on one machine. Other
  browsers, other profiles, native apps and everything else on the tether are
  invisible to it, and the disclosures now say so.

### Engineering

- The project is under version control, with CI on every push:
  `.github/workflows/ci.yml` runs typecheck, the unit suite and both build
  channels on Node 22 and 24, and runs the browser smoke test against a real
  Chromium.
- `tsconfig.json` gained `erasableSyntaxOnly`, `verbatimModuleSyntax` and
  `noImplicitReturns`. The first two protect the test harness specifically: the
  suite runs `node --test` straight over the `.ts` sources and relies on Node's
  type stripping, so a single `enum`, `namespace` or constructor parameter
  property would break every test with an error about the module system that
  points nowhere near the cause.
- `engines` declares Node `>=22.18` and there is a `.nvmrc`, because that is the
  version where type stripping stopped being a flag. Below it the suite dies
  inside a `.ts` file with nothing explaining why.
- `eslint.config.js` enforces `@typescript-eslint/no-floating-promises`. The
  worker is torn down on idle, so nearly every write is asynchronous, and the
  codebase marks deliberate fire-and-forget with a `void` prefix — 70 of them at
  this release, every one of them a real promise. A bare call missing both
  `void` and `await` looks identical and is a write that may never land. ESLint
  and Playwright are pinned development dependencies. Lint now gates `npm run verify`.
- `.editorconfig` records what the tree already contains — LF, UTF-8, two-space
  indent, no tabs — so an editor with different defaults cannot turn a two-line
  change into a whole-file diff.

### Pre-release history

The audit that shaped this release was folded into `ARCHITECTURE.md` and `STATE.md`
in August 2026 and its own file deleted; `git log` has the original. Each of the four
remediation waves is one commit, and the commit messages carry the reasoning at
more length than this file can.

| Commit | What it settled |
| --- | --- |
| `47452a3` | Baseline: the state the audit was written against |
| `2fa22b3` | The eight ship blockers — enforcement surviving worker teardown, limits that can be removed, a banner that appears more than once, limit rules outranking optimizer redirects, and the privacy documents made true |
| `b44321a` | Measurement and holdout correctness — a control arm that no longer includes every load from before Data Saver was switched on, unbiased sampling, an interval instead of a bare difference, and six measurement undercounts |
| `c5a9be4` | Plan, cycle, total budget, projection and alerts — plus the UI primitives the surfaces needed |
| `5e54111` | The three surfaces rebuilt and a first-run page: week/month/session budgets, hard caps, per-feature and per-pack controls, the holdout rate and the measured/estimated split all became things a user can actually reach |

The short version of what waves 1–4 were for: the measurement engine was
finished and honest, and an extraordinary amount of correct machinery behind it
was reachable by nobody.

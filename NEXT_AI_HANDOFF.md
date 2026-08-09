# Byte Budget — Next AI Handoff

**Last updated:** August 8, 2026
**Workspace:** `c:\Users\bing bong\Projects\Network data tracker`  
**Current status:** The Dashboard/Settings split, the visual Advanced impact indicators and the narrow-viewport layout fix are all implemented and validated. Since then a review pass over the **measurement pipeline** found and fixed three high-severity defects and several smaller ones, all of which were silent — the numbers were wrong or missing with nothing on screen to say so. See section 8. The Settings page was then rebuilt as a rail of six sections (section 9); read that section before changing anything on that page.

**Most recent change: the paid tier** (section 11). Byte Budget now has a free tier and Byte Budget Plus, at CA$0.99 a month or CA$7.99 a year (CAD) through ExtensionPay, with a 14-day trial. Read section 11 before touching `src/plus/`, the settings rail, or anything that reads a period or a range — and read 11.1 before touching the privacy copy, because the sentence this product used to lead with is no longer true and the replacement is load-bearing.

The pass before it was the first-run pass (section 10). Every surface had been reviewed in the state it is in *after* a week of browsing, and none in the state it is in on the first morning. Installed on a clean profile, the dashboard opened on eight panels of confident nothing and the product never mentioned the one step that makes its own toolbar button reachable. Section 10 is what changed and what was deliberately left. No required implementation work remains; section "Deferred findings" lists what was found and deliberately left.

## Read this first

This document is the handoff source of truth for the next AI working in this repository. Read it before changing the UI or optimizer behavior.

The previous handoff said "no required implementation work remains" and, for the UI, that was true. It was read as meaning the project was finished, which it was not: nothing had ever reviewed `src/track/`, and it had no unit tests at all. If you are looking for work, prefer the parts of this extension that decide what the numbers are over the parts that display them.

The conversation contains screenshots from multiple iterations. Some attached images show the **old combined page** with Overview, Limits, Data Saver, and Settings all on one long dashboard. Those images are obsolete. The current implementation has two real pages:

- `dashboard.html`: reporting only
- `settings.html`: controls only

Use the source files and the current screenshots listed below as authoritative.

## User intent and non-negotiable UX direction

The user wants Byte Budget to feel simple, intuitive, and customer-facing, following an Apple-like principle that simplicity comes first.

Preserve these decisions unless the user explicitly asks to reverse them:

1. **Dashboard and Settings must be separate pages.** Do not put controls back below the reports on one long page.
2. **Normal users should not see implementation details.** Avoid exposing units configuration, calendar-week rules, control-group percentages, retention internals, optimizer matrices, or similar technical settings in the primary UI.
3. **Prefer one-size-fits-most defaults.** Do not reintroduce a large matrix of optimizer feature and pack switches.
4. **Advanced is progressive disclosure.** High-impact or behavior-changing options belong in a collapsed Advanced section.
5. **Use customer language.** Explain outcomes, not the implementation.
6. **Communicate visually where possible.** The Advanced options now use compact relative-impact bars rather than paragraphs or invented percentages.
7. **Do not add decorative marketing filler.** The user specifically rejected phrases/chips such as:
   - “Works automatically”
   - “Keeps pages familiar”
   - “Easy to undo”
8. **Advanced choices must survive the master switch.** Turning Data Saver off and back on must not reset the user’s selected Advanced options.
9. **Be honest about limitations.** Do not claim that a content script can stop every parser-discovered initial request.

## What is implemented now

### 1. Dashboard and Settings are separate surfaces

#### Dashboard

Files:

- `src/dashboard.html`
- `src/dashboard.ts`

The Dashboard contains only usage reporting and results:

- Session/Today/7 days/30 days period selection
- Data used
- Top site
- Accuracy
- Data saved
- Site list and search
- Site drill-down
- Daily usage chart
- Data-type breakdown
- Collapsed measurement explanation
- Data Saver results
- Link to manage Data Saver in Settings

It does **not** contain:

- Daily limit controls
- Data Saver master or Advanced switches
- Appearance settings
- Toolbar settings
- Export/delete controls

The main navigation has only:

- Dashboard
- Settings

#### Settings

Files:

- `src/settings.html`
- `src/settings.ts`

The Settings page owns all configuration, in six sections behind a rail (see section 9 for the layout and why):

- **Data plan** — plan size, reset day, what happens when it runs out, the current cycle
- **Data Saver** — master switch, the Light/Balanced/Maximum level, website exceptions; Advanced holds the eight per-feature switches, the image services and the holdout rate
- **Site limits** — the limits themselves, and the form that adds one
- **Alerts** — the two notification switches
- **Appearance** — theme and toolbar badge; Advanced holds units and the week/month rules
- **Privacy & data** — what is recorded, retention, per-host detail, export, delete, storage report

`settings.ts` is a dedicated controller rather than a conditionally shared dashboard controller. This matters because the project’s `query()` helper is intentionally strict: it throws when an expected element does not exist. Keeping separate controllers prevents missing-element failures and keeps page responsibilities clear.

### 2. Extension entry points and navigation were updated

Files changed:

- `vite.config.ts`
- `public/manifest.json`
- `scripts/package.mjs`
- `src/popup.ts`

Current behavior:

- Vite builds both `dashboard.html` and `settings.html` as independent entries.
- `public/manifest.json` declares `"options_page": "settings.html"`.
- The packaging script requires both `settings.html` and `settings.js`.
- Popup **Manage limits** opens `settings.html#limits`, and **Set a plan** opens `settings.html#plan`. The fragment names come from `SETTINGS_SECTIONS` in `src/core/types.ts` and `openSettings()` takes that type, so a caller cannot name a section that does not exist — which is exactly what all four deep links did the first time these sections were renamed.
- Popup **Open dashboard** still opens reporting.
- Background `OPEN_DASHBOARD` behavior remains a reporting destination.

Important generated-file rule:

- Edit `public/manifest.json` when changing the extension manifest.
- Do **not** hand-edit root `manifest.json`, `dist/manifest.json`, or `dist-throttle/manifest.json`.
- Vite generates/patches those files. The root manifest is rewritten to point into `dist/` so the project root can be loaded unpacked.

### 3. Advanced Data Saver uses concise visual impact indicators

The Advanced disclosure is collapsed by default. It contains three customer-facing options:

| Setting | Relative impact | Meter | Default | Short explanation |
| --- | --- | --- | --- | --- |
| Click to load media | High | 3/3 segments | Off | Video and audio wait for the user. |
| Stop page preloading | Medium | 2/3 segments | Off | Links load only when opened. |
| Use system fonts | Low | 1/3 segment | Off | Skips downloaded typefaces. |

The labels **High**, **Medium**, and **Low** remain visible, so the meter does not communicate through color alone. Each meter also receives an accessible label such as `Expected data savings: High`.

Relevant files:

- `src/settings.html`
- `src/settings.ts`
- `src/dashboard.css`
- `src/optimize/features.ts`

Impact metadata is deliberately separate from feature visibility:

```ts
SAVINGS_IMPACT_BY_FEATURE
```

`FeatureInfo.visibility` describes how noticeable a behavior change is. It must not be reused as a savings estimate.

The current relative map is:

```ts
clickToLoadMedia: "high"
dropHints: "medium"
systemFonts: "low"
```

These are relative product estimates, not measured percentages. The UI says that expected savings vary by site.

### 4. System-font positioning is now honest

The user correctly questioned whether system fonts save much data.

Current product position:

- System fonts are **Low** relative impact.
- The option remains off by default.
- Its feature description no longer says it saves the most bytes.
- The description explains that the saving is usually limited to the first uncached visit because fonts are commonly cached.

In practical terms, downloadable fonts may cost tens or hundreds of kilobytes on a first visit, occasionally more on a font-heavy site. That is generally minor compared with video, audio, and large images. Keeping it as a Low-impact Advanced option is defensible, but removing it entirely is also a reasonable future product decision.

### 5. Click-to-load media behavior

Relevant files:

- `src/optimize/features.ts`
- `src/content/optimize.ts`
- `src/background.ts`

`clickToLoadMedia` is an off-by-default page feature.

Current behavior:

- Captures the media element’s exact `src`, child `<source src>`, `preload`, and `autoplay` attributes.
- Removes held sources.
- Adds an accessible **Load video** or **Load audio** control in a closed shadow root.
- Also allows a trusted click on the media element to release it.
- Rejects untrusted/script-generated activation.
- Restores the exact attributes and sources.
- Calls `load()` and attempts `play()` under the user activation.
- Keeps the site’s native controls usable if playback is refused by autoplay policy.
- Handles dynamically added and retargeted media.
- Processes media source mutations immediately instead of waiting an animation frame.
- Uses fixed extension-provided UI strings rather than page-provided text.

A focused Chromium validation confirmed:

- The preference survives Data Saver off/on.
- A dynamically assigned media source makes no request before activation.
- A scripted `.click()` does not release it.
- A trusted browser click restores it and causes exactly one media request.

#### Known browser limitation

Media embedded directly in initial HTML can be discovered by Chrome’s parser/preload scanner before an asynchronous content-script settings lookup completes. Therefore this feature is best-effort for initial parser-inserted media, not a guaranteed network firewall.

Do not change the copy to promise that every initial media request is blocked. A declarative network rule could guarantee blocking, but per-element click-to-allow behavior would then require a more invasive tab-scoped allow-list or extension-mediated fetch design.

### 6. Advanced settings persist correctly

`saveOptimizeSettings()` in `src/optimize/features.ts` merges partial feature and pack changes with the current settings.

Both the Dashboard-era master switch and the current Settings master switch send only:

```ts
{ enabled: true }
```

or:

```ts
{ enabled: false }
```

The popup also sends only `enabled` when turning Data Saver on. It does not overwrite `features`, `packs`, or `holdoutPercent` with defaults.

Do not regress this behavior by sending `defaultOptimizeSettings()` from a master-switch handler.

### 7. Settings works at a phone width

This was the previous handoff's Priority 3. It was a validation task, and it found a genuine defect rather than confirming the layout.

**What was wrong.** At a 390 px viewport the Settings document was **772 px wide**. The whole page scrolled sideways, and the limit row's **Pause** and **Remove** buttons sat off screen with nothing on screen to suggest they were there.

**Why.** A grid item's automatic minimum size is its min-content size, and min-content propagates up through ancestors. The six-column limits table gave `#limits-panel` a min-content width of 760 px, which the `.settings-stack` grid then had to honour. The `.table-scroll` wrapper never got the chance to scroll, because the overflow had already been pushed onto the page.

This was measured, not reasoned about. Isolating it in Chromium gave:

| Candidate | Document width at 390 px |
| --- | --- |
| unchanged | 772 (837 with a long site name) |
| `min-width: 0` on the page grid items only | 566 |
| stacked limit card only | 390 (440 with a long site name) |
| both | 390 (407 with a long unbreakable site name) |
| both plus `overflow-wrap` on chips | 390 |

So all three parts are load-bearing. Removing any one of them brings the sideways scroll back — the third only for a long hostname with no hyphens, which is why it is easy to drop by accident.

**The fix**, all in `src/dashboard.css` plus `data-label` attributes in `src/settings.ts`:

1. `.page > *, .settings-stack > * { min-width: 0 }` — nothing laid out by the page grid may be sized by its own contents. Unconditional, because the invariant holds at every width.
2. Under 640 px the limits table becomes **one card per limit**: `thead` is hidden, the rows and cells become blocks, and each cell prints its column name from `data-label`. Scoped to `#limits-table`, so the Dashboard's own breakdown tables keep scrolling horizontally instead.
3. `overflow-wrap: anywhere` on `.chip`, because a domain has no spaces and is therefore one unbreakable word. `anywhere` rather than `break-word` specifically because only `anywhere` also reduces min-content width, which is what the page grid is measured against.

In the card layout `.host-name` wraps instead of ending in an ellipsis, since its `title` tooltip is unreachable on a touch device.

**Superseded in part by section 9.** Point 2 is gone: the limits table is a list of cards at every width now, which is what it collapsed into here anyway, so there is no `data-label`, no hidden `thead` and no `#limits-table`. Points 1 and 3 stand and are still load-bearing — 1 for the Dashboard, which still has three tables and a chart, and 3 for the exception chips, which are unchanged. The measurements in the table above are of the layout that no longer exists; the check in `scripts/smoke.mjs` still asserts 390/390 with a limit present, and still passes.

**The Dashboard did not have this defect.** Measured at 390 px with the site drill-down both closed and open, it is 390/390, and its host table is 332 px inside the available space. That is the realistic case rather than an adversarial one; a drill-down with many very long third-party hosts was not tested, though `.host-name`'s 240 px ellipsis and the new `min-width: 0` rule mean such a table should now scroll inside `.table-scroll` rather than widen the page.

### 8. Measurement pipeline review

This was a review of `src/track/`, which had never been reviewed and had **no unit tests**. Every defect below was silent: the extension kept reporting confident figures.

The common shape is worth naming, because it will recur. This codebase is careful about *disclosing* uncertainty — `estimatedDown`, the Accuracy figure, measured versus modelled savings. It was much less careful about state that outlives the thing it describes. A service worker dies every thirty idle seconds, a request is priced up to eight seconds after it finishes, and a tab navigates whenever the person feels like it. Four of the defects are that mismatch.

#### 8.1 A parked request could be lost outright

`src/track/reconcile.ts`

A response with no `Content-Length` is parked for eight seconds while the page reports its size. Expiry used to be driven only by the pre-flush hook and the one-minute maintenance alarm, and **neither can reach the last request on a page**. The flush two seconds later looks too early and correctly leaves it alone; then traffic stops, nothing schedules another flush, and Chrome tears the worker down at thirty seconds. The queue is module state, so it goes too. The alarm later wakes a *fresh* worker with an empty queue.

The request was not estimated. It was gone. And only for streamed bodies with no usable resource timing — the responses an estimate is least able to stand in for.

Fixed with `scheduleSweep()`: a timer inside the TTL, which fires while this worker is still alive (eight seconds against a thirty-second teardown) and flushes behind itself. Plus `drainPending()` on `runtime.onSuspend` for the browser-closing case.

**Do not remove the sweep timer on the grounds that the alarm covers it.** It does not, and the comment that claimed it did was wrong.

#### 8.2 Bytes landed on the next page's visit row

`src/track/ledger.ts`, `src/track/tabs.ts`, `src/track/requests.ts`

`ledger.record` credited `addTabBytes(tabId, …)`, which resolved the tab's visit **at commit time**. For a chunked request that is up to eight seconds after it finished, comfortably long enough to have clicked a link. Those bytes went to the next page's row.

Nothing looked wrong, and that is the point: the period totals are keyed by site and stayed correct. `visits` quietly became the wrong shape instead — and `visits` is the only input to the optimizer's on-versus-off comparison, the one savings figure the project describes as surviving the objection "you are adding up your own guesses". The error correlated with the variable being measured, because the holdout decision is taken per navigation.

`CommitEntry` now carries `visitId`, captured when the request is priced. `tabs.ts` keeps recently ended loads addressable in a bounded `retired` map so late bytes are written back to their own row. An entry with no visit is counted against the site and left out of the visit rows rather than guessed at.

`noteNavigation` also installs the new tab record **before** awaiting the previous visit's IndexedDB write. It used to await first, and the document's own `onCompleted` arrives just after `onCommitted` — so the request that *is* the new page was priced against the old page's record.

Measured in the browser, and mutation-verified both ways:

| `addTabBytes` resolves by | `localhost` site total | `localhost` visit mean |
| --- | --- | --- |
| tab (old) | 121,061 B | **670 B** |
| visit (fixed) | 121,061 B | **121,061 B** |

670 bytes is the empty document on its own. The 120 kB had moved to the next page.

#### 8.3 A stale session read resurrected deleted usage

`src/track/ledger.ts`

`loadSession()` awaits `chrome.storage.session.get`. If "delete all recorded usage" ran while that read was in flight, the read resolved with pre-clear data, merged it in, took `startedAt = min(old, now)` — the old value — and the next flush wrote it back to disk. The window is one storage round trip, and traffic-in-flight-during-a-clear is the normal case, not an edge one.

Guarded with a `sessionEpoch` bumped by `resetSession()`. A read that finds the epoch changed discards what it read.

#### 8.4 The learned size model survived "delete all recorded usage"

`src/track/estimate.ts`, `src/background.ts`

`clearAllUsage()` has always emptied the `sizeModel` store. What it could not reach was the copy the worker holds in memory for its whole life: the model kept answering from it, and the first observation afterwards wrote the key back with its full accumulated count. The button emptied a table that immediately refilled itself.

This is not a rounding error. **The model is keyed by hostname**, so it is a record of which sites you have visited, and it was outliving the control that claims to delete it.

`SizeModel.reset()` now runs alongside `resetOpenVisits()` in `CLEAR_DATA`.

The browser check for this is exact rather than a range, because a range is what let the old behaviour hide: after a clear, a refused image is priced at the per-type default and nothing else, so `saved` must equal `blocked ×` that default. The default is read out of `src/track/estimate.ts` by the smoke script rather than copied into it, so retuning `DEFAULT_SIZES` cannot silently break the check. The previous version asserted `saved >= 100,000` and passed against a 250 kB learned mean that should no longer have existed.

#### 8.5 Smaller fixes

- **The parked-request cap counted requests already dealt with.** `MAX_PENDING` was tested against `queue.length`, which includes committed entries awaiting a shift. It tripped early, and then the whole force budget was spent estimating requests parked milliseconds earlier whose real sizes were still arriving — dropping the disclosed Accuracy figure for a reason unrelated to measurability. Now counted against live entries.
- **Index buckets outlived their page.** A settled entry stayed in its `tabId|url` bucket until every entry in the bucket had settled. Entries are spliced on commit, which also makes `settleTiming` O(1).
- **Errored requests were dropped unless they had upload bytes.** The function's own comment said "the request is still counted so the request total stays right"; the code returned early. A cancellation where `onSendHeaders` never fired vanished from the request counts that the per-host and per-visit tables are built from.
- **The session chart disagreed with its own heading.** Session totals come from `chrome.storage.session`; the chart came from whole stored days. Restart the browser at three in the afternoon and the bars visibly summed higher than the figure above them. `hourBuckets()` now clamps to the hour the session began.
- **`visitStats` was DST-unsafe and double-counted a boundary.** Its upper bound was `startOfDay(to) + 86_400_000`, which lands at 23:00 on a 25-hour day and drops the last hour of page loads; and `IDBKeyRange.bound` is inclusive, so a load starting exactly at midnight counted in two ranges. Now `startOfDay(addDays(to, 1))` with `upperOpen`.
- **Hourly retention kept four days while documenting three.** Off-by-one in the cutoff key.
- **A rewrite noted at redirect time could not always be priced.** `handleCompleted` now releases it in a `finally` rather than leaving it for the LRU.

#### 8.6 A false claim in the customer copy

`src/settings.html`, `src/optimize/features.ts`

The Advanced option "Stop page preloading" read **"Links load only when opened."** The smoke run showed the prefetch reaching the server anyway.

`dropHints` has no network rule behind it. It is a content script that removes `<link rel=prefetch>` elements, so whether the request goes out is a race against Chrome's preload scanner, which reads the hint out of the first HTML before any script exists. This is the same limit PLAN.md §5.2 records for the image features and the one the click-to-load copy already discloses — `dropHints` was missed in that relabelling.

The hint now reads **"Trims links a page loads before you click."** and the feature description says hints in the first HTML may start before an extension can remove them.

The smoke test's network assertion was **demoted to a note**, next to the identical note the offscreen image already had. It had been passing on the winning side of a race; the two runs after the change came out differently from each other, which is the proof that it was never an assertion. What the feature can honestly promise is the DOM check that sits beside it.

**Do not restore that assertion, and do not promote the copy back.** A content script cannot beat the preload scanner.

### 9. The Settings page was rebuilt

`src/settings.html`, `src/settings.ts`, `src/settings.css` (new), `src/optimize/features.ts`, `src/core/types.ts`, `i18n/settings.json`, `i18n/core.json`

**What was wrong.** The page had drifted back to everything-at-once. One column, roughly six screens tall at 1280 px, with about thirty controls on screen and a paragraph of prose above each. With Data Saver on it grew to eight feature checkboxes plus six image-service checkboxes plus a holdout percentage — the optimizer matrix that direction 3 above says not to reintroduce — and units, calendar-week rules and retention internals were all in the primary UI, against direction 2. Nothing was hidden, which is the same thing as nothing being findable: the plan size and the export button were the same size, in the same kind of box, three thousand pixels apart.

**The shape now.** Six sections behind a rail, each about one question:

| Section | Default height | Holds |
| --- | --- | --- |
| Data plan | 3 rows | size, reset day, what happens when it runs out; the cycle below |
| Data Saver | 2 rows | the master switch and one three-way level |
| Site limits | a card per limit | the limits, and a four-row form to add one |
| Alerts | 2 rows | the two notification switches |
| Appearance | 2 rows | theme, toolbar badge |
| Privacy & data | 2 rows | retention, per-host detail; export and delete below |

Four rules hold it together, and each is the answer to something the old page did:

1. **Every control is one row.** What it is on the left, the control on the right, at most two lines of small print between them. A setting that cannot state itself in a row is a setting whose explanation belongs in a disclosure — not in a paragraph above the control, which is what most of the old page's height was.
2. **Every pane is in the DOM from startup.** Controls are built once and only painted after that, the same rule `bindGroup` documents for its own options. Switching sections cannot destroy a control mid-interaction, and `query()`'s strictness keeps working.
3. **The rail items are anchors.** Real `href="#saver"` links, so Back works, `settings.html#privacy` opens on the right section, and the browser handles the keyboard. Three of them carry the section's current value ("15.0 GB · resets in 8 days", "Balanced", "2 limits"), because the reason to open a section is usually that its value is wrong.
4. **Advanced is where the matrix went, not where it died.** All fourteen switches are still there, under a disclosure, with their honest descriptions and their impact meters.

**The savings level.** `SAVER_LEVELS` in `src/optimize/features.ts` — Light, Balanced, Maximum — is the ordinary way to use Data Saver now. Each level is *derived* rather than listed: Light is every feature whose `visibility` is `invisible`, Balanced is every feature with `defaultOn`, Maximum is all of them. That is deliberate. A listed set is a second table to keep in step with `FEATURES`, and the failure when it drifts is silent — a feature added there and forgotten here would be reachable from Advanced and from no preset, so choosing "Maximum" would quietly switch it off. `tests/optimize.test.mjs` pins the property none of the three definitions states alone: that they nest, and that they are distinct.

`levelOf()` returns `null` when a stored set matches no level, and **nothing repairs it**. Someone who opened Advanced and switched one thing off has a selection; the page says "Custom" and warns that picking a level replaces it. Do not round to the nearest preset.

**Deep links are typed now.** `SETTINGS_SECTIONS` lives in `src/core/types.ts` and `openSettings()` takes that type, because when the panels became panes all four deep links from the popup and the dashboard kept pointing at `#…-panel`. That does not throw and does not warn — it opens Settings at the top, so four buttons quietly stopped doing what their labels said. The smoke run also checks every `settings.html#…` string in `dist/`.

**Wording.** The settings-scoped shape labels became outcomes rather than mechanisms: "Just measure / Shed weight / Hard stop" → "Just track it / Cut back gradually / Stop at the limit", and `coreBudgetShape*` followed so the popup and the dashboard say the same words. The site-limit form asks the same question the plan does, with the same two options, instead of a switch labelled "Hard cap" whose off state named nothing. **The disclosures were not softened**: the plan's scope admission, the full privacy statement, the `Save-Data` fingerprinting note and the holdout's cost sentence are all still on the page, word for word — moved under the control they belong to, or behind a summary, rather than stacked above it.

**The plan size saves on `change`.** Its Save button is gone, because it was the only one on the page: the reset day, the enforcement choice and every switch already saved themselves, so a person who changed the size and moved on had no way to know that one field alone had not stuck. Emptying the field still removes the plan and still says so.

#### 9.1 The two surfaces share one frame

The header and the nav under it are the only thing a person sees on both pages, so anything that differs between them reads as the page jumping when they switch. Three things did, and each was invisible from inside either page on its own:

| | Dashboard | Settings | Effect |
| --- | --- | --- | --- |
| `.page` max-width | 1160 | 1100 | both centred 30 px apart — the icon, the title and the nav all slid sideways |
| the Dashboard/Settings nav | its own row under the header | inside the header, far right | it moved 918 px across and 72 px up |
| header height | 65 px (three-line brand) | 47 px (two lines) | everything below started 18 px higher |

Plus a fourth: the dashboard is always taller than the viewport and Settings usually is not, so the classic scrollbar appeared on one and vanished on the other.

**The rules now, and do not break them:**

1. `.page` carries the width, in `dashboard.css`. Settings sets no `max-width` of its own.
2. The header holds the brand, and the nav is the block after it. Same markup, same order, on both.
3. The brand is three lines on every surface. Settings' third line is empty and `settings.css` gives it `min-height: 1lh` — it is there to be as tall as the dashboard's period line, so removing it moves the nav, the rail and every pane.
4. `html { scrollbar-gutter: stable }` in `dashboard.css`, so the gutter is reserved whether or not there is a scrollbar in it. Deliberately not in `app.css`: a 400 px popup cannot spare the width.

`scripts/smoke.mjs` measures `.page`, `.page-head`, `.section-nav` and `.brand-mark` on both pages at one viewport and asserts they are equal — as equality, not as four remembered numbers, so it keeps holding when the header changes. Only `.page`'s height is exempt; that is the one thing the two are allowed to disagree about.

Two smaller alignments came with it: the group headings use `.panel-title`'s uppercase treatment, so a heading over a group of settings is not a different kind of thing from a heading over a panel of figures, and `.settings-panes` is capped at 820 px — the frame is the dashboard's now, and at the full 854 px a row put "Website" and the field to fill in 700 px apart.

#### 9.2 The dashboard's own pass

Same reading, applied to the surface Settings now matches.

**Cut off.** `.stat-hint` was one line clipped with an ellipsis. That was written for "0 sites" and became nonsense when a tile carried a sentence: the Data Saver panel shipped reading *"Original sizes on file, minus what the sma…"* and *"The size model's guess for requests refus…"* — the two captions that say which of the two figures is measured and which is modelled, truncated to the half that says nothing. They wrap now. `scripts/smoke.mjs` checks that no caption on the page has content wider than its box.

**Bad layout, three instances:**

1. `#savings-panel .stats` capped its two tiles at 240 px, leaving ~600 px of empty panel. There are exactly two and there always will be — a measurement and a model, which README.md:133-141 forbids adding together — so the grid names the count instead of capping the width.
2. `.bottom-grid` was declared twice, the second silently overriding the first, and stretched its items. The shorter panel became a bordered card with a paragraph at the top and a few hundred pixels of nothing under it. `align-items: start` now.
3. `.table tbody tr:last-child td { border-bottom: 0 }` cleared the rule on `td` only. The storage table's row labels are `<th scope="row">`, so its last row drew a hairline under the label and none under the figure — a rule that starts at the left edge and stops halfway across. `> *` now.

**Wordy.** Seven messages tightened, and one typographic rule behind them: **a sentence is 12 px, a gloss under a figure stays 11.** The disclosures, the projection basis and the comparison notes are paragraphs and were being set at the size the product uses for an aside. The rule is applied by selector in `dashboard.css` rather than on `.field-hint`, because that class legitimately carries both kinds of text.

**Nothing disclosed was dropped**, and this is the constraint on any further trimming here: the measured-versus-modelled split, the "100% measured means every body was measured, not that the total is exact" sentence, the 95% interval rule, the profile-scope admission and both privacy claims under the storage table all still read in full. What went was repetition — the plan panel explaining twice that there is no plan — and jargon: "A limit over Everything" now reads "Turn it into a limit", which is also the label on the button directly beneath it.

### 10. The first-run pass

`src/welcome.html`, `src/welcome.css`, `src/dashboard.html`, `src/dashboard.ts`, `src/settings.ts`, `src/core/chart.ts`, `i18n/*.json`, `tests/chart.test.mjs`, `scripts/smoke.mjs`

**How this was found, because the method is the reusable part.** Every previous pass read the surfaces in the state the smoke run leaves them in: usage recorded, a limit set, Data Saver on. That is the state they are in on the *second* day. This pass loaded `dist/` into a Chromium with an empty profile and photographed what a person actually meets — the welcome tab, the popup on a real site with no traffic yet, the dashboard with an empty ledger, and each settings section with nothing configured. Four of the six findings below are invisible in every screenshot in `outputs/`, because every one of those was taken with data behind it. **`outputs/dashboard-first-run.png` and `outputs/welcome.png` now exist so this is no longer true.**

**What was wrong, and what it now does.**

1. **The accuracy pill claimed 100% of nothing.** `measuredShare` returns 1 for an empty total on purpose — 0% confidence in nothing is the wrong reading, and the comment on it says so — but the Data Used card then shipped "0 B" wearing "100% measured". The pill is a qualifier on the total; with no total it qualifies nothing, so it is not rendered. **Do not "fix" this by changing `measuredShare`.** Its return value is right for what it is; the card was the wrong place to use it unconditionally.

2. **The daily chart drew an axis over thirty invisible bars.** `chartInto`'s empty test was `series.length === 0`, and `GET_SERIES` answers a thirty-day request with thirty rows whether or not anything is in them — so the empty branch could only ever fire for a range with no days in it. The test is on the values now. This was the one panel on the page with no empty state, which made it the one whose emptiness read as a fault.

3. **The Data Saver panel presented its methodology to someone who had never used it.** Two 0 B tiles, the holdout disclosure, the 95%-interval rule and the "needs five optimized loads and one unoptimized one" line — about four hundred pixels of statistics, and the tallest thing on an empty dashboard. `savingsUntouched()` gates it: the switch off **and** `saved`, `blocked`, `rewritten` and `deltas` all zero. One sentence stands in until then.

   **Every one of those five has to be zero, and that is not fussiness.** Someone who ran Data Saver last week and turned it off yesterday has results the panel exists to defend. It is only the install that has never had it on that is spared. And the panel's "Manage Data Saver" link is in the header, outside everything this hides, so the way in is unchanged.

4. **The storage table contradicted itself.** Seven counts of "0 rows" over "Disk in use 81.1 kB". Both figures are correct — an empty IndexedDB is not a zero-byte one — and nothing said so, which leaves one reading available: that one of the two is invented. `dashboardStorageEmptyNote` replaces the privacy note while that is the whole explanation, and the privacy note returns with the first row, since it describes rows.

5. **Nothing in the product mentioned pinning it.** Byte Budget is used from a toolbar button and Chrome starts a new extension hidden in the puzzle-piece menu. An install can be set up perfectly and leave the person with no reason to know its main surface exists. `#pin-panel` on the first-run page says how, and says in its second paragraph that nothing depends on it — measurement runs whether or not the button is visible. This is the only place the fact is worth stating; do not repeat it on the dashboard.

6. **Three pieces of copy said the wrong thing.**
   - The popup's Data Saver row, while off and beside a button reading "Turn on", ended "Switch it off again from here, for this site or for everything" — the exit from a state the reader is not in.
   - `popupNoLimitHere` — what a person sees if their first act after installing is to click the button on the new-tab page — led with what Byte Budget cannot limit. It leads with the reason and the next step now. Its last sentence is a disclosure and stays.
   - `welcomeSaverIntro` opened on "Asks known image CDNs…": four words of jargon in front of the product's main feature, where Settings already had "Ask sites for less, so a page costs fewer bytes to open". Outcome first, then the same three mechanisms, none dropped.

**A seventh, found on the way and unrelated to first run.** `src/core/chart.ts` had seven strings that never reached the catalogue: "Everything else" in both breakdown legends, "Total" in the two-tone key, "When"/"Data"/"Chart values" in the value table, "Breakdown" as the stacked bar's fallback name — and the whole of `describeSeries`, which is assembled from English fragments and is the only reading of the primary chart a screen reader gets. Wave 6 internationalized every surface and missed the module both of them import. All of it is `t()` now, one message per clause.

`tests/chart.test.mjs` **serves the real `i18n/core.json` through a `chrome.i18n` stub** rather than asserting the keys. Without it `t()` falls back to the key in Node and the assertions would have passed against `coreChartEverythingElse` — pinning the fallback, not the string. The stub resolves `$NAME$` through `placeholders` to `$1`, as Chrome does, so a key deleted from the catalogue fails here instead of shipping as its own name in a legend.

**The browser checks for all of this live at one specific point in `scripts/smoke.mjs`** — immediately after the `CLEAR_DATA` before the blocking experiment, and *before* the `SET_ENFORCEMENT` under it. That is the only moment in the run where the first-run state exists: every store empty, no plan, Data Saver never on. A refusal credits `blocked`, which would take the savings panel out of its untouched state, so the order is load-bearing. All four were mutation-verified together: reverting the four predicates produces four named FAILs, including "30 bars" for the chart — which is the proof the old length test could never have fired.

The `waitForSelector` there goes through `checkWait`. A bare wait would report the regression by throwing, which under this script's rule 2 deletes every check after it from the evidence.

### 11. The paid tier

`src/plus/` (new: `tier.ts`, `gate.ts`, `plans.ts`, `lock.ts`, `rules.ts`), `src/background.ts`, `src/settings.*`, `src/dashboard.*`, `src/popup.ts`, `src/core/dom.ts`, `src/core/types.ts`, `src/app.css`, `public/manifest.json`, `scripts/smoke.mjs`, `tests/plus.test.mjs`

**The rule the split is drawn on, and it is not negotiable without the user saying so:** *measurement is free, and so is every disclosure that makes it trustworthy.* The accuracy percentage, the measured-versus-modelled split on Data Saved, the projection's basis, the profile-scope admission and the privacy statement are free forever. A figure a person cannot audit is not a preview of a better figure; it is a worse one, and this project's whole argument is that it does not ship those. **Do not gate a disclosure to make the paid tier look better.**

**The four modules and why they are four.**

| File | Holds | May import |
| --- | --- | --- |
| `plus/tier.ts` | the ceilings, `PlusStatus`, `PlusPage` | nothing but types |
| `plus/plans.ts` | prices, `TRIAL_DAYS`, the two refresh intervals | nothing |
| `plus/gate.ts` | the reduced cache and failure policy | `plus/provider.ts` |
| `plus/provider.ts` | ExtensionPay protocol, local opaque key, response reduction | nothing |
| `plus/lock.ts` | the lock notice DOM, `setControlsEnabled` | `core/dom`, `core/i18n` |
| `plus/rules.ts` | one `allow` rule | `core/types`, `rules/session` |

`provider.ts` is the only module that can reach the provider. It stores the opaque key in local storage, never sync, and reduces the provider reply without persisting the raw object. The payment-page content script only relays a completion event. **Nothing outside the worker may import the provider** — `core/messages.ts` names `PlusPage` from `tier.ts` for exactly that reason.

**Three ceilings, in `tier.ts`.** `FREE_SITE_LIMITS = 3` (the `ALL_SITES` limit is outside the count), `FREE_BUDGET_PERIODS = ["day"]`, `FREE_REPORT_DAYS = 7`. Plus the derived `FREE_PERIODS`, which is every period except `month`.

**Three rules the ceilings obey. Each is a promise the product keeps, and each is easy to break by accident:**

1. **A ceiling limits what you can change, never what you already have.** Someone who subscribes, sets eight limits and a custom Data Saver selection, then lapses, keeps every one of them — running, enforcing, and still editable. `assertBudgetAllowed` in `background.ts` therefore counts only *new* sites and only gates a period that *differs* from the stored one. The alternative is a billing event silently deleting a limit somebody relied on.
2. **Retention is not the paid setting; the reporting window is.** The ledger keeps 400 days for everyone. `FREE_REPORT_DAYS` bounds what is *drawn and exported*, never what is kept, so subscribing reveals history that was already there and lapsing destroys nothing. **Do not "simplify" this by gating `retentionDays`.**
3. **The plan cycle is exempt from the reporting window.** The popup headline, the plan meter and the projection read the whole cycle — up to 31 days — on the free tier. `reportDays()` is never applied to `cycleDays`. Clipping it would not make the free tier smaller, it would make it wrong, and "will I make it to the reset date" is the question this product exists to answer.

**The failure policy, at the head of `gate.ts`.** A failed check never removes access: the last successful answer stands, marked `stale`, with no expiry. A failed check never grants it either — `unknownStatus()` is free. The asymmetry is deliberate; only one of the two errors hurts someone who paid.

**A lock is an attribute, not CSS.** `plus/lock.ts` sets `disabled` on a whole block; `[data-locked]` only dims. `pointer-events: none` stops a mouse and leaves Tab and Space working, which is not a lock. `bindGroup` in `core/dom.ts` also steps over locked options when the arrow keys move, because arrow keys *activate* in a radio group — a locked option left in the ring was choosable by pressing Right.

**A locked option is not a disabled one, and the difference cost a round of rework.** The first version of the segmented-control lock set `disabled` and dimmed to 45%. Measured on the shipped build that was invisible — "30 days" beside "7 days" is muted text on a light panel either way — so the segment looked ordinary, ignored the press and never said why. Three defects from one attribute. `setGroupOptionsLocked` in `core/dom.ts` is what replaced it, and each part of it is load-bearing:

| | why |
| --- | --- |
| padlock glyph | a difference people *read*, not one they notice by comparison |
| `title` + `aria-label` suffix | carries the reason without adding a note to the layout |
| `aria-disabled`, not `disabled` | truthful (present, unselectable) and stays in the accessibility tree; `disabled` hides the tier boundary from screen readers entirely |
| stays operable, `onActivate` opens Plus | a control that cannot do the thing can at least say what would |
| out of the arrow ring | arrow keys activate, so leaving it in would throw someone onto another page for pressing Right |

Two consequences to know about. Playwright reads `aria-disabled` as "not enabled" and will not click, so the smoke check passes `force: true` — a browser has no such rule and the click fires normally, so that is reproducing real behaviour rather than working around a defect. And `bindGroup` stashes `dataset.label`, because the accessible name has to be rebuilt from the words after a glyph is appended.

**A `<select>` cannot do any of that**, so a locked export range says it in its own label (`settingsExportRangeDaysLocked` → "Last 90 days — Plus"). Any future gated `<option>` needs the same.

**The shared controls have a `:disabled` state now** (`app.css`, `dashboard.css`), and they need it: at the limit ceiling the add-limit form is disabled top to bottom and "Set limit" was rendering in full accent green, because `[data-locked]` dims `.row-copy` and `.row-control` and the button is a direct child of `.row`. **A control must state its own availability rather than inherit an ancestor's opacity** — that is the general rule, and the button was the instance that proved it.

**One `allow` rule, in `plus/rules.ts`.** The limit over Everything installs an unscoped block, so at `strict` it would refuse both the subscription check and every asset on the payment page — leaving unstyled text at the moment someone was trying to pay, and silently demoting a paying customer for hitting the limit they pay to manage. The rule sits at priority 4, above `limit/rules.ts`'s 3, because Chrome only falls back to allow-over-block to break a tie *within* one priority and this is not a thing to rest on a tie. It is published once at worker start under the new `guard` source in `rules/session.ts`.

#### 11.1 The privacy claim had to be narrowed

Byte Budget used to say, in `settings.html`, the welcome page, `README.md` and `PRIVACY_POLICY.md`, that it made **no network request of its own**. A subscription cannot be checked without asking something, so that sentence is false now and has been replaced in all four places rather than left standing.

What is claimed instead: nothing measured is uploaded. A never-connected free install makes no provider request. Once an account flow creates an opaque key, checks send that key and no usage or site data. ExtensionPay can return account fields including an email; `provider.ts` discards fields Byte Budget does not use and persists only reduced status. `PRIVACY_POLICY.md` and the Plus pane say all of this directly.

`connect-src` in `public/manifest.json` names `https://extensionpay.com` and nothing else, so the narrower claim is enforced the same way the old one was. **If you add anything that talks to a network, that policy line and these four documents are part of the change, not a follow-up.**

#### 11.2 What the smoke run needed

`setPlus(paid)` in `scripts/smoke.mjs` writes the same `chrome.storage.local` record the worker writes. It is not a test-only branch in production code — there is none — it works because `startPlus` drops its memo on `storage.onChanged`, a listener that exists for its own reasons (rule 16: a copy held for the life of a worker must not outlive the record it came from). The run asserts the free tier's locks first, because that is the only moment in the run where the free tier is the live state, then unlocks for everything after it.

Two things there are easy to get wrong and are commented in place: `heldRules()` filters the permanent guard out of every assertion about what a limit or the optimizer installed, and the `SETTINGS_SECTIONS` count is read out of `core/types.ts` rather than remembered — the check used to assert `panes.length === 6` and a seventh section made it fail, which is a test failing because the product grew.

## Earlier simplification work that remains important

Before the page split, the application received a broader simplicity pass. Preserve these improvements:

- Fixed broken segmented settings controls caused by mismatched camelCase/kebab-case data selectors.
- Added keyboard support and roving tab stops for segmented controls.
- Added visible Saving/Saved/error states.
- Reduced normal settings to Appearance and toolbar usage.
- Standardized normal periods to simple rolling windows.
- Simplified limits to progressive daily allowances.
- Kept technical explanations inside collapsed disclosures.
- Reframed customer-facing metrics around outcomes:
  - Accuracy instead of measurement internals
  - Data saved instead of raw blocked/rewritten counts
  - Plain site shares rather than request-count-heavy summaries
- Removed the full optimizer feature/pack/holdout control matrix from customer UI.
- Kept website exceptions available without overwhelming the default view.

## Current source map

### Primary UI

- `src/popup.html`, `src/popup.ts`, `src/popup.css`
  - Compact usage view for the current browsing context
  - Site-level Data Saver toggle
  - Limit presets
  - Opens Dashboard for reporting
  - Routes Manage limits to Settings

- `src/dashboard.html`, `src/dashboard.ts`
  - Reporting only
  - Overview, sites, detail, charts, savings results

- `src/settings.html`, `src/settings.ts`
  - Configuration only
  - Six sections behind a rail; every control exists from startup and is only painted after that

- `src/settings.css`
  - The options page's own layout: the rail, the panes, the group and the row
  - `@import`s `dashboard.css` for the primitives the two surfaces share

- `src/dashboard.css`
  - Shared by the Dashboard, the first-run screen and (through `settings.css`) Settings
  - Contains shell, reporting, form controls, the table, the switch, the meters and the status chip
  - Also owns the page-grid `min-width: 0` rule

- `src/app.css`
  - Shared design tokens and base controls

### Optimizer

- `src/optimize/features.ts`
  - Feature IDs and metadata
  - Defaults
  - Relative savings-impact map
  - Settings normalization and merge behavior

- `src/content/optimize.ts`
  - Page-side optimizations
  - Click-to-load media gate
  - Source mutation handling

- `src/background.ts`
  - Applies optimizer rules
  - Registers/unregisters the page optimizer
  - Filters `GET_PAGE_FEATURES` by sender tab, site, exclusions, and holdout status
  - Waits for optimizer startup readiness before returning page features

### Tracking

Where the numbers come from, and where the section 8 defects were. Read PLAN.md §1 before changing any of it: every design choice here follows from what Chrome will and will not tell an extension.

- `src/track/requests.ts`
  - The `webRequest` listeners, used purely as an observer
  - Prices each request and captures the `visitId` it belongs to

- `src/track/reconcile.ts`
  - Requests that finished without declaring a size
  - Owns its own sweep timer and a suspend drain — see 8.1

- `src/track/ledger.ts`
  - In-memory accumulation, the debounced flush, the session mirror
  - Also `pruneOldRows`

- `src/track/tabs.ts`
  - Which site each tab shows, where one page load ends
  - Routes bytes to the load that earned them, including recently ended ones

- `src/track/estimate.ts`
  - The learned `host|type` size model, and `reset()`

- `src/track/stats.ts`
  - Every read query the popup and dashboard display

- `src/track/wire.ts`
  - Byte arithmetic and the attribution rule. The best-tested module here

### Limits

- `src/limit/budgets.ts`
- `src/limit/enforce.ts`
- `src/limit/governor.ts`
- `src/limit/notify.ts`
- `src/limit/rules.ts`
- `src/limit/throttle.ts`
- `src/limit/tiers.ts`

### Build and validation

- `vite.config.ts`
  - Multi-entry build
  - Standard and throttle output directories
  - Root-manifest generation
  - Classic-content-script assertions

- `scripts/smoke.mjs`
  - Full Chromium extension validation
  - Page-separation checks
  - UI control checks
  - Visit-attribution and parked-request checks (section 8)
  - Screenshot generation

- `tests/reconcile.test.mjs`
  - The only unit coverage `src/track/` has
  - Stubs `ledger.record` and `sizeModel.observe` on the singletons
  - Mutation-verified; see "Validation evidence"

- `scripts/package.mjs`
  - Packaging requirements and manifest-reference verification

## Validation evidence

The latest completed validation sequence was:

```powershell
npm run verify
npm run build:throttle
npm run smoke -- --shots
```

The original paid-tier pass finished with 267/267 tests and a green browser suite. Release hardening later removed the copied ExtPay library and `homepage_url`; the current verification counts and archive contents must be read from the latest run, not this historical count.

`tests/plus.test.mjs` is the 13 new tests, and all seven properties in it were **mutation-verified**: making the month free, removing the `reportDays` clamp, making it widen a small request, freeing every budget window, dropping the window below a week, unlocking `unknownStatus`, and cutting the limit ceiling to 1 each produce exactly one failure.

Six existing browser checks had to be repartitioned rather than relaxed, because the new guard `allow` rule is present in every reading of Chrome's session rules. `heldRules()` filters it out; the assertions themselves are unchanged, and one new check confirms the guard survives every install and teardown in the run.

The earlier sequence, for the record:

### `npm run verify`

Passed:

- TypeScript (`tsc --noEmit`)
- **105/105 tests** — 95 existing plus 10 new in `tests/reconcile.test.mjs`
- Production Vite build

The production build emitted separate entries including:

- `dist/dashboard.html`
- `dist/dashboard.js`
- `dist/settings.html`
- `dist/settings.js`

`tests/reconcile.test.mjs` is the first unit coverage `src/track/` has ever had, and it exists because that is where the defects were. It stubs `ledger.record` and `sizeModel.observe` on the singletons rather than introducing a seam for the tests' benefit. The properties it asserts are the ones whose failure is silent: nothing waits forever, nothing is lost on teardown, a measurement beats an estimate, an estimate is labelled, a request is committed exactly once, and the cap is measured against requests still waiting.

It was **mutation-verified**, which is worth doing for anything added here. Restoring `queue.length > MAX_PENDING` makes exactly one test fail. A test that passes against the bug it was written for is decoration.

### `npm run build:throttle`

Passed. The throttle build emitted the same separate UI entries in `dist-throttle/` and retained the channel-specific debugger behavior. The permission split still holds: `dist/manifest.json` does not mention `debugger`, `dist-throttle/manifest.json` does.

### `npm run smoke -- --shots`

Passed all Chromium checks, with `--shots` and without.

Checks added by the measurement review:

- A parked request survives the page that made it, and **stays on that page load rather than the next one**. `localhost` and `127.0.0.1` are the same local server and two different site keys, which is what makes visit attribution observable at all; the fetch is cross-origin and `no-cors`, so its `transferSize` is 0 and the page cannot report it, which is what keeps the request parked past the navigation instead of being settled a second later. The same twelve-second wait covers 8.1: once the page has gone, nothing but the queue's own timer can commit it.
- Deleting usage empties every store, **and** every subsequent refusal is priced from the per-type default — the exact assertion described in 8.4.
- The prefetch outcome is now reported rather than asserted (8.6).

Checks added by the earlier UI work:

- The root extension loads.
- `options_page` is `settings.html`.
- Dashboard has reporting but no settings controls.
- Settings has controls but no reporting widgets.
- Advanced impact meters render exactly:
  - High with three filled segments
  - Medium with two filled segments
  - Low with one filled segment
- The Settings Data Saver switch works through actual UI interaction.
- The Settings appearance control works through actual UI interaction.
- Settings does not scroll sideways at 390 px, with a limit present.
- Every limit row action stays on screen at 390 px.
- The limit card says what each of its four figures is.
- Advanced does not scroll sideways at 390 px.
- All eight feature switches stay on screen at 390 px.
- The impact meters still read High 3 / Medium 2 / Low 1 at 390 px, all on screen.

Checks added by the Settings rebuild (section 9):

- Choosing a savings level sets the individual switches under Advanced to exactly that level's set — read back off the checkboxes, not off the settings object, because the defect it guards against is a picker that saves one thing and shows another.
- Switching one of those back off makes the level read **Custom** rather than being rounded to the nearest preset.
- Every `settings.html#…` deep link in `dist/` names a section that exists. This is the check that would have caught all four links breaking when the panels became panes.
- The Dashboard and Settings frames are equal: `.page` position and width, `.page-head`, `.section-nav` and `.brand-mark`, measured on both at one viewport with fonts settled (section 9.1).
- No caption on the dashboard has content wider than the box it is in (section 9.2). Read the comment on it before trusting it as a regression net — it covers the class of defect, not the one instance that produced it.

- Existing measurement, site drill-down, exports, limits, notices, optimizer rules, image rewriting, Save-Data behavior, prefetch blocking, savings reporting, and service-worker behavior remain functional.

The six narrow-viewport checks run on a plain `npm run smoke`, not only with `--shots`, because the defect they cover is invisible at a desktop width. They live where they do for a reason: the limits check needs a budget to exist for the table to have a row, and the Advanced check needs Data Saver on for the disclosure to be reachable. Both restore the 1280 px viewport afterwards, because the later checks and screenshots assume it.

The smoke log includes expected `net::ERR_BLOCKED_BY_CLIENT` messages when the extension intentionally blocks requests. Those are not regressions.

Playwright is a pinned development dependency for the smoke script. The release packager
walks `dist/` only, so development dependencies cannot enter the store archive.

## Current screenshots

Authoritative current captures:

- `outputs/dashboard-first-run.png`
  - **The state a new install opens on**, and the one every other capture here hides. Taken at the one point in the smoke run where it exists (see section 10), with the site drill-down explicitly closed first.
  - Read it before making the dashboard busier: no accuracy pill, an empty chart that says so, a one-sentence Data Saver panel, and a storage note that explains its own disk figure.

- `outputs/welcome.png`
  - The first-run page, including `#pin-panel`
  - At 390 px the document measures 380 against a 390 px viewport, so it does not scroll sideways either. That is not asserted anywhere; re-measure it if the page grows a table or a wide control.

- `outputs/dashboard.png`
  - Report-only Dashboard
  - Two-item Dashboard/Settings navigation
  - No limit or setting controls
  - **With usage behind it.** Every panel section 10 collapsed is expanded here, which is the check that the collapse is conditional rather than a deletion.

- `outputs/dashboard-dark.png`
  - Current report-only Dashboard in dark mode

- `outputs/settings.png`
  - The Data plan section, which is what the page opens on
  - The whole section is under 400 px tall. That is the point of section 9; compare it with anything in `outputs-before/`.

- `outputs/settings-optimize.png`
  - The Data Saver section with Advanced **open**, which is a state a person has to ask for
  - Best screenshot for reviewing the High/Medium/Low visual meters
  - Closed — the default — that section is three rows
  - **Taken with Plus unlocked**, like every capture here except the two below

- `outputs/settings-plus.png`
  - The Plus section on a free install: the state, the two prices, what is unlocked, and the four actions
  - Read it before changing the free/paid split — the list on it is the promise

- `outputs/settings-saver-locked.png`
  - **The state every new install is in**, and the one no other capture shows
  - Advanced open, the fourteen switches and the holdout dimmed and disabled, the lock notice above them
  - Both of these are photographed at the end of the smoke run, which sets the tier back to free for exactly that purpose and restores it afterwards

- `outputs/settings-limits.png`
  - The Site limits section with an active daily limit
  - Desktop reference for the limit card and the add-limit form

- `outputs/settings-narrow.png`
  - Site limits at 390 px with a limit over its allowance
  - Shows the rail lying down as a horizontal scroller, and the limit card with all three actions on screen

- `outputs/settings-narrow-advanced.png`
  - Data Saver at 390 px with Advanced open
  - Shows the feature rows with their switches and meters intact

- `outputs/popup.png`
- `outputs/popup-limit.png`
- `outputs/notice.png`

Obsolete captures were deleted:

- `outputs/dashboard-limits.png`
- `outputs/dashboard-optimize.png`

If an image in the conversation still shows Limits, Data Saver controls, Appearance, or Privacy at the bottom of the Dashboard, it is from the old design and should be ignored.

## Required work remaining

None.

Both builds, 254 unit tests, the full browser suite and the screenshots are green. Do not make further product changes solely to "finish" this handoff.

`npm run lint` is part of `npm run verify`. ESLint, typescript-eslint and Playwright are
pinned development dependencies; use `npm install` and `npx playwright install chromium`
on a clean machine.

## Deferred findings

These were found in the same review and deliberately **not** fixed. They are recorded so the next person inherits the list rather than rediscovering it. None is currently producing a wrong user-facing number; the first two are the ones most likely to start.

1. **A tab that vanishes while the worker sleeps never finishes its visit.** `ensureTabsReady` reconciles against `chrome.tabs.query` and deletes records for tabs that are gone, without calling `finishVisit`. The row keeps no `endedAt`, and `visitObserver` — the holdout accounting — never fires for it. Left alone because the fix changes holdout semantics, and `optimize/holdout.ts` deserves its own read first rather than a change made in passing. `visitDelta` filters on `endedAt`, so these loads are currently invisible to the comparison rather than wrong in it.
2. **The optimizer never credits a rewrite on the parked path.** `creditRewrite` needs the body size, which a chunked response does not have when it is parked. Accepted rather than fixed: every host a pack rewrites is an image CDN and declares a `Content-Length`, and crediting later would mean an `await` on `reconcile`'s synchronous commit path. The record is now released explicitly so the omission is deliberate rather than a leak.
3. **`sizeModel.prune()` issues one transaction per evicted key, across awaits.** Correct arithmetic, but up to thousands of sequential transactions, and a concurrent `observe()` can have a fresh sample deleted. Relatedly `flush()` clears `dirty` before `putMany` resolves, so a quota rejection loses those observations for good.
4. **`db.ts` has two latent hazards.** `runTransaction` does not consume `settled` in readonly mode, which would be an unhandled rejection on an aborted read — no readonly caller does this today. And `db.onclose` nulls the module cache without checking ownership, so a stale handle can evict a live connection.
5. **Every expiry batch schedules a redundant empty flush.** `preFlush` → `record` → `flushSoon`, right after the timer was cleared. Writes nothing and keeps the worker awake two seconds longer. Self-terminating.
6. **A failed merge loses its swapped buffers.** `doFlush` reports the rejection and never re-queues the deltas.
7. **A mean of exactly zero is an absorbing state in the estimator.** `ceiling` and `floor` both become 0 and `count > 0` stops `estimate()` falling back to the per-type default. Unreachable today because header bytes are never zero and `settleTiming` guards `transferSize <= 0`.
8. **`hourKeysInDay` always emits 24 keys.** The non-existent spring-forward hour is a permanent empty bar, and two real fall-back hours collapse into one key. Cosmetic; daily rows are unaffected.
9. **The `?? 1970` / `?? 1` defaults in `addDaysTo` do not catch `NaN`.** `??` only fires on null and undefined, so a malformed key yields an Invalid Date and `"NaN-NaN-NaN"`. Latent — every call site passes `dayKey` output — but the defaults read as protection they do not provide.
10. **`sessionUsage()` hands out the live `sites` object.** All five callers copy before mutating, so it is latent, but one `addTotals(delta, …)` would corrupt the ledger in place.
11. **`Visit.saved` is never populated.** `addTabSaved` was the only writer, was never called from anywhere, and was removed rather than left as an invitation to reintroduce the 8.2 bug with a new signature. Either wire it up or drop the field.

12. **`describeSeries` joins its clauses with a literal `", "`.** Each clause is a whole message now (section 10), which is the part that matters, but the separator between them is still punctuation chosen in English. Most locales take a comma; the ones that do not can carry their own inside the clauses, which is why this was left rather than turned into a thirteenth message. Revisit it with the first non-English catalogue, not before.

13. **The first-run page has no narrow-viewport assertion.** Measured by hand at 390 px after `#pin-panel` was added: 380 against a 390 px viewport, so it does not scroll sideways. It is prose in a single column and nothing on it can widen a grid item, which is why the six checks in section 7 were not extended to a third surface. Re-measure if it ever grows a table, a wide control, or a row layout — rule 13 below is about exactly this.

## Recommended future improvements

### Priority 1: unit-test the rest of `src/track/`

`reconcile.ts` now has coverage. `ledger.ts`, `tabs.ts`, `stats.ts`, `requests.ts` and `db.ts` still have none, and between them they hold the flush/swap-buffer logic, the visit routing, every aggregation the UI reads and the IndexedDB read-modify-write paths. Three high-severity defects lived there and a clean typecheck plus 95 passing tests said nothing about any of them.

`tests/reconcile.test.mjs` shows the pattern that works: these modules can be imported in Node because none of them touches `chrome` or `indexedDB` at module scope, and the singletons can be stubbed on the instance. `tabs.ts` will need a `put` stub to get past `finishVisit`.

Mutation-test anything added. It is the only way to know the test would have caught the bug.

### Priority 2: decide whether system fonts deserves to remain

Current state is honest: Low impact, off by default, Advanced only.

Two valid directions:

1. Keep it for users on expensive or very constrained connections.
2. Remove it because a Low-impact option adds cognitive cost to a section intended for meaningful savings.

Do not promote it back to Medium/High without measured evidence.

### Priority 3: personalized impact estimates

The current bars are static product estimates. A stronger future design could use the person’s own browsing history to say which categories actually cost them data.

This is not a trivial UI-only change. It would require feature-specific instrumentation because the current aggregate savings report does not always identify how much each page-side optimization individually avoided. Preserve privacy and keep all analysis local.

Avoid fake numeric percentages. If measurement is incomplete, continue using relative language.

### Priority 4: direct Settings access from the popup

The popup currently has **Open dashboard**, and the contextual **Manage limits** action routes to Settings when shown.

A small dedicated Settings action may improve discoverability. Keep it visually secondary so the popup remains a quick usage view rather than another settings menu.

### Priority 5: expand UI-level browser checks

The smoke test now clicks the Settings Data Saver and appearance controls. Other behavior is well covered through extension messages, but these settings forms are not all directly driven through the UI:

- Add/remove a daily limit through the form
- Add/remove a website exception
- Toggle the toolbar badge
- Trigger CSV/JSON exports
- Confirm the delete-usage dialog path

Only add these if the maintenance cost is justified; the existing behavior-level smoke coverage is already broad.

### Priority 6: split the shared stylesheet

Dashboard and Settings currently both import `dashboard.css`. This was the lowest-risk way to preserve visual consistency during the structural split.

A maintainability refactor could create:

- shared page-shell styles
- reporting-only dashboard styles
- settings-only control styles

This is not user-visible and should rank below product improvements. Avoid changing visual behavior during the split.

Two things to carry across carefully if this is attempted: the `.page > *, .settings-stack > * { min-width: 0 }` rule belongs with the shared page shell, and the `#limits-table` card layout belongs with the settings-only styles. Run the narrow-viewport smoke checks after the split, not just the build.

### Priority 7: replace glyph symbols with custom SVG icons

Advanced currently uses compact glyphs for media, preloading, and fonts. They are lightweight and work, but custom SVG icons could improve cross-platform consistency and alignment.

Keep icons decorative (`aria-hidden`) because the text labels already name each setting.

### Priority 8: accessibility review

Current impact meters include visible text and `aria-label`, and segmented controls support keyboard navigation. A dedicated review could still cover:

- Narrow-screen focus order
- Closed Advanced disclosure keyboard behavior
- Contrast in dark mode
- Screen-reader output for switch labels and impact meters
- Focus state on Dashboard/Settings navigation

## Risks and constraints for future changes

1. **Do not confuse visibility with savings impact.** They are separate concepts.
2. **Do not reset Advanced settings from a master switch.** Save partial changes only.
3. **Do not claim guaranteed initial-media blocking.** Parser timing prevents that guarantee.
4. **Do not reintroduce the full optimizer matrix.** The user explicitly wants simplicity.
5. **Do not manually edit generated manifests or built output.** Edit source and rebuild.
6. **Do not assume a successful build proves browser behavior.** Run the Chromium smoke flow for extension/API changes.
7. **Do not add dependencies casually.** No new permanent dependency was added for this work.
8. **Do not create new test files without a reason.** Existing tests and smoke coverage were updated instead.
9. **Remember that content-script setting changes primarily affect new/reloaded pages.** The Settings copy should not imply every open page is live-reconfigured.
10. **Preserve privacy.** Usage and any future personalization should remain local unless the user explicitly requests otherwise.
11. **Do not undo any of the three narrow-viewport rules.** Each was measured to be necessary on its own; see section 7. In particular, a wrapper with `overflow-x: auto` does **not** stop a wide table's min-content from reaching the page grid, and `overflow-wrap: break-word` is not a substitute for `anywhere`.
12. **Keep `data-label` on the limit cells in step with the table headers.** Adding a column to `#limits-table` without a matching `data-label` leaves an unlabelled figure on a phone.
13. **A desktop screenshot does not validate a layout.** The sideways scroll fixed in section 7 was present in every previous build and invisible in every desktop capture.
14. **Bytes belong to a page load, not to a tab.** `CommitEntry.visitId` is captured when the request is priced and must stay that way. Resolving a tab's *current* visit at commit time is the section 8.2 defect, and it corrupts the one savings figure that does not rest on the extension's own estimates.
15. **Nothing may sit in the parked queue with no timer of its own.** It is module state in a worker that dies after thirty idle seconds. `scheduleSweep` and the `onSuspend` drain are both load-bearing; the maintenance alarm cannot substitute for either, because it wakes a fresh worker with an empty queue.
16. **Anything a `CLEAR_DATA` clears on disk must also be cleared in memory.** The worker holds long-lived copies — the session totals, the open visits, the size model — and every one of them has written deleted data straight back at least once. The size model in particular is keyed by hostname.
17. **A read in flight across a destructive action is the normal case, not an edge case.** `resetSession`'s epoch guard exists because of it. Any new cached read of user data needs the same treatment.
18. **Do not assert a network outcome for a DOM-level optimization.** A content script cannot beat Chrome's preload scanner. This has now cost the project twice — once for the image features (PLAN.md §5.2) and once for `dropHints` (section 8.6). Assert what the script did to the document; report what the network did.
19. **Mutation-test a new test before trusting it.** Break the fix, confirm the test fails, restore. Both new checks in this pass were verified that way, and one of them turned out to have a companion assertion that passed under the bug — which is how it became clear the two were measuring different things.

20. **An empty state is a state, and it is the one every user sees first.** Four of section 10's six findings were on a surface that had been reviewed a dozen times, and all four were invisible because every review and every screenshot had data behind it. Before shipping a change to any surface, load `dist/` into a Chromium with a fresh profile and look at it with nothing recorded. The four collapses in section 10 are conditional, not deletions: check that the panel comes *back*, which is what `outputs/dashboard.png` is for.

21. **Do not gate a disclosure.** The accuracy figure, the measured-versus-modelled split, the projection's basis, the scope admission and the privacy statement are free forever. See section 11.

22. **A paid ceiling limits what can be added or changed, never what already exists.** A lapse must leave every configured limit running and editable. The failure it prevents is a billing event silently deleting something a person relied on.

23. **A lock is the `disabled` attribute.** CSS may show a lock; it may not be one. `pointer-events: none` leaves Tab and Space working, and in a segmented control arrow keys activate as well as move.

24. **Retention is a deletion control and must stay free.** Gate the reporting window instead — `FREE_REPORT_DAYS` bounds what is drawn, never what is kept.

25. **Nothing outside the service worker may import `plus/gate.ts`.** It is the only module that can reach a network, and that is what makes the privacy claim checkable rather than promised.

26. **A test that runs without `chrome` asserts `t()`'s fallback unless you give it a catalogue.** `core/i18n.ts` returns the key when there is no `chrome.i18n`, by design, so an assertion against a translated string passes against `coreChartEverythingElse` just as happily as against "Everything else". `tests/chart.test.mjs` stubs the API over the real `i18n/core.json`. Any new test that asserts user-facing text needs the same, or it is pinning nothing.

## Suggested next-AI starting checklist

Before changing anything:

1. Read this document.
2. Inspect the current source files, not old screenshots in conversation history.
3. Open:
   - `outputs/dashboard.png`
   - `outputs/settings.png`
   - `outputs/settings-optimize.png`
   - `outputs/settings-narrow.png`
   - `outputs/settings-narrow-advanced.png`
4. Identify whether the new request concerns measurement, reporting, configuration, optimizer behavior, or limits. If it touches `src/track/`, read PLAN.md §1 and section 8 above first — the constraints there are not obvious from the code, and the defects found in that pass were all invisible from a green suite.
5. Keep Dashboard and Settings controllers separate.
6. After product changes, run the most relevant subset and then the full sequence when appropriate:

```powershell
npm run typecheck
npm run verify
npm run build:throttle
npm run smoke -- --shots
```

7. Inspect regenerated screenshots rather than relying only on exit codes.

## Repository and Git note

Earlier Git commands reported that this workspace is not a Git repository (`fatal: not a git repository`). Do not claim a commit or clean working tree unless Git is initialized later and verified. No commit was created during this work.

## Before shipping the paid tier

Three things are outside what code can do and none of them is optional:

1. **Keep the `byte-budget` ExtensionPay configuration aligned with the UI.** Its public
   plan endpoint currently reports CA$0.99/month and CA$7.99/year (CAD). `EXTENSION_ID`
   in `plus/provider.ts` names it. The prices in `plus/plans.ts` are display strings only,
   so check the code and provider dashboard together before every price change.
2. **Declare the paid tier in the Chrome Web Store listing**, host `PRIVACY_POLICY.md` at a stable direct URL, and put that URL in the Store Privacy practices field. The manifest intentionally has no product homepage.
3. **Give reviewers a trial or test subscription** and the steps in `STORE_LISTING.md`; the automated browser suite tests gates and UI, not a real charge.

## Final state in one sentence

Byte Budget has a focused report-only Dashboard, a dedicated Settings page whose Advanced section communicates High/Medium/Low impact honestly and holds together at a phone width; a tracking pipeline that no longer loses streamed requests when the worker sleeps, no longer charges them to the wrong page load, and no longer keeps a hostname-keyed model alive after the user has deleted it — and, since the first-run pass, a first morning that says what it does not know yet instead of stating it confidently, and tells you where to find the button everything else is behind.

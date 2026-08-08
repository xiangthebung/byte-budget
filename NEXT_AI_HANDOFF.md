# Byte Budget — Next AI Handoff

**Last updated:** July 31, 2026  
**Workspace:** `c:\Users\bing bong\Projects\Network data tracker`  
**Current status:** The Dashboard/Settings split, the visual Advanced impact indicators and the narrow-viewport layout fix are all implemented and validated. Since then a review pass over the **measurement pipeline** found and fixed three high-severity defects and several smaller ones, all of which were silent — the numbers were wrong or missing with nothing on screen to say so. See section 8. No required implementation work remains; section "Deferred findings" lists what was found and deliberately left.

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

The Settings page owns all configuration:

- Daily site limits
- Data Saver master switch
- Advanced Data Saver options
- Website exceptions
- Theme
- Toolbar usage badge
- CSV/JSON export
- Delete usage

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
- Popup **Manage limits** opens `settings.html#limits-panel`.
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

**Desktop is unchanged.** The limits table is still a six-column table with its header row, inline meter, status chip and inline actions. Compare `outputs/settings-limits.png` and `outputs/settings-optimize.png` against the narrow captures.

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
  - Limits, Data Saver, Advanced, exceptions, appearance, privacy/data

- `src/dashboard.css`
  - Currently shared by Dashboard and Settings
  - Contains shell, reporting, settings, limits, Data Saver, and impact-meter styles
  - Also owns the page-grid `min-width: 0` rule and the under-640 px limit card layout

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

Results:

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
- The stacked limit card labels its figures once the header row is gone.
- Advanced does not scroll sideways at 390 px.
- The impact cards stack to one column at 390 px.
- The impact meters still read High 3 / Medium 2 / Low 1 at 390 px, all on screen.

- Existing measurement, site drill-down, exports, limits, notices, optimizer rules, image rewriting, Save-Data behavior, prefetch blocking, savings reporting, and service-worker behavior remain functional.

The six narrow-viewport checks run on a plain `npm run smoke`, not only with `--shots`, because the defect they cover is invisible at a desktop width. They live where they do for a reason: the limits check needs a budget to exist for the table to have a row, and the Advanced check needs Data Saver on for the disclosure to be reachable. Both restore the 1280 px viewport afterwards, because the later checks and screenshots assume it.

The smoke log includes expected `net::ERR_BLOCKED_BY_CLIENT` messages when the extension intentionally blocks requests. Those are not regressions.

Playwright is expected to be installed out of tree for the smoke script. It is intentionally not a permanent extension dependency.

## Current screenshots

Authoritative current captures:

- `outputs/dashboard.png`
  - Report-only Dashboard
  - Two-item Dashboard/Settings navigation
  - No limit or setting controls

- `outputs/dashboard-dark.png`
  - Current report-only Dashboard in dark mode

- `outputs/settings.png`
  - Settings with Data Saver off and Advanced hidden

- `outputs/settings-optimize.png`
  - Settings with Data Saver on and Advanced open
  - Best screenshot for reviewing the High/Medium/Low visual meters

- `outputs/settings-limits.png`
  - Settings with an active daily limit
  - Desktop reference for the six-column limits table

- `outputs/settings-narrow.png`
  - Settings at 390 px with a limit over its allowance
  - Shows the stacked limit card: Limit / Used / Status / Resets labelled, meter over-limit, all three actions on screen

- `outputs/settings-narrow-advanced.png`
  - Settings at 390 px with Data Saver on and Advanced open
  - Shows the impact cards stacked to one column with their meters intact

- `outputs/popup.png`
- `outputs/popup-limit.png`
- `outputs/notice.png`

Obsolete captures were deleted:

- `outputs/dashboard-limits.png`
- `outputs/dashboard-optimize.png`

If an image in the conversation still shows Limits, Data Saver controls, Appearance, or Privacy at the bottom of the Dashboard, it is from the old design and should be ignored.

## Required work remaining

None.

Both builds, 105 unit tests, the full browser suite and the screenshots are green. Do not make further product changes solely to "finish" this handoff.

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

## Final state in one sentence

Byte Budget has a focused report-only Dashboard, a dedicated Settings page whose Advanced section communicates High/Medium/Low impact honestly and holds together at a phone width — and, since the measurement review, a tracking pipeline that no longer loses streamed requests when the worker sleeps, no longer charges them to the wrong page load, and no longer keeps a hostname-keyed model alive after the user has deleted it.

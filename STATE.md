# Byte Budget — state

What is true right now. Anything with a date on it lives here; design reasoning lives
in `ARCHITECTURE.md` and does not belong in this file.

**Last verified: 29 August 2026, against `master`.**

---

## Baselines

Every figure below was produced by running the command beside it on the date above. If
you change something, re-run and update the number — a count nobody regenerates is a
count that is wrong, and this project has carried five contradictory test totals at
once before.

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm test` | 288 tests, 288 pass |
| `npm run build` | both channels compile; store build 58 modules |
| `npm run build:throttle` | compiles; declares `debugger`, store channel does not |
| `npm run smoke` | all checks passed, real Chromium |

`npm run verify` is typecheck + lint + test + build. `npm run smoke` is the part
`verify` structurally cannot prove: that `chrome.webRequest` fires, that resource
timings reach the worker, that IndexedDB rows are written and read back, and that the
number on the dashboard matches what a local server actually served.

## What is built

All three phases are shipped and reachable from a surface. The audit finding that
mattered most in this project's history was fourteen implemented, in some cases tested,
features that no user could open — so "built" here means "a person can get to it".

| Area | State | Evidence |
| --- | --- | --- |
| Track | Done | `src/track/`, `npm run smoke` measures a known page and checks the total |
| Limit | Done | `src/limit/`, smoke drives a budget to enforcement with nothing set by hand |
| Optimize | Done | `src/optimize/`, smoke asserts a rewrite and a refused beacon against a real server |
| Plus (paid tier) | Done | `src/plus/`, `tests/{plus,gate,provider}.test.mjs` |
| Internationalization | Done | 774 messages across `i18n/*.json`, `_locales/` generated at build |
| CI | Done | `.github/workflows/ci.yml` — verify on Node 22 and 24, smoke, advisory lint |
| Documentation checks | Done | `tests/docs.test.mjs` |

The paid tier is complete rather than half-built: a free/Plus boundary in
`src/plus/tier.ts` that gates settings and reporting depth but never measurement or a
disclosure, an ExtensionPay client that keeps an opaque key and a reduced status, and a
lock affordance that is the `disabled` attribute. What is not done is outside the code
— see the release checklist below.

## Still open

Recorded so the next person inherits the list rather than rediscovering it. None is
currently producing a wrong user-facing number.

| # | Item | Why it is still open |
| --- | --- | --- |
| 1 | `sizeModel.prune()` issues one transaction per evicted key across awaits, and `flush()` clears `dirty` before `putMany` resolves — a quota rejection loses those observations. | Correct arithmetic; the cost is throughput and a narrow loss window. The fix is a batched eviction, which wants its own read of `core/db.ts`. |
| 2 | `core/db.ts`: `runTransaction` does not consume `settled` in readonly mode, and `db.onclose` nulls the module cache without checking ownership. | Both unreachable today — no readonly caller aborts, and no second handle is opened. Latent, not live. |
| 3 | Every expiry batch schedules a redundant empty flush. | Writes nothing; keeps the worker awake two seconds longer. Self-terminating. |
| 4 | A mean of exactly zero is an absorbing state in the estimator. | Unreachable: header bytes are never zero and `settleTiming` guards `transferSize <= 0`. |
| 5 | `hourKeysInDay` always emits 24 keys, so the non-existent spring-forward hour is a permanent empty bar and two fall-back hours collapse into one. | Cosmetic, twice a year, on the hourly chart only. Daily rows are unaffected. |
| 6 | `describeSeries` joins its clauses with a literal `", "`. | Each clause is a whole message, which is the part that matters. Revisit with the first non-English catalogue, not before. |
| 7 | The optimizer does not credit a rewrite on the parked path. | Accepted: every host a pack rewrites is an image CDN and declares a `Content-Length`. Crediting later would mean an `await` on `reconcile`'s synchronous commit path. |
| 8 | The first-run page has no narrow-viewport assertion. | Measured by hand at 390 px (380 content). It is prose in one column and nothing on it can widen a grid item. Re-measure if it grows a table or a row layout. |

### Closed since the last handoff

Kept rather than deleted, because the wrong version plus the correction stops the same
conclusion being reached again.

- **A tab that vanished while the worker slept never finished its visit.** Fixed:
  `ensureTabsReady` now calls `finishVisit` for records it reconciles away, so the load
  reaches `visitObserver` and the holdout comparison. Previously those loads were
  invisible to the comparison, and they are not distributed evenly across its two arms.
- **`sessionUsage()` handed out the live `sites` object.** Fixed: it returns a copy,
  `byType` included. All seven callers happened to copy before mutating, so this was
  latent — one `addTotals(delta, …)` against the returned map would have corrupted the
  ledger in place, and it would have looked like traffic rather than a bug.
- **A failed flush lost its swapped buffers.** Already fixed: rejected maps fold back
  into the live buffer and the failure surfaces as `lastFlushError` on the dashboard and
  in settings. An older handoff still listed this as open.
- **`Visit.saved` was never populated.** Already fixed: `src/track/ledger.ts` writes it.
- **The documentation claimed the project had no internationalization, no CI, and was
  not under version control.** All three were false. See below.

## Notes on the documentation

Four documents were consolidated into two on 29 August 2026. The files then named
AUDIT.md (78 KB), PLAN.md (60 KB) and NEXT_AI_HANDOFF.md (79 KB) were deleted; their
durable content is in `ARCHITECTURE.md` and their status content is in this file.
`git log` has the originals. They are written without backticks here because they are
no longer files anyone can open, and `tests/docs.test.mjs` treats a backticked name as
a path it should be able to find.

The reason was not length on its own. All three had drifted into stating things that
were no longer true — the plan said the project had no internationalization and no CI
while `i18n/` held 774 messages and `.github/workflows/ci.yml` was green; the handoff
said the workspace was not a Git repository. They also contradicted each other on
load-bearing behaviour: the parked-request TTL was documented as both 8 s and 15 s
(the code says 8), budgets as living in both `chrome.storage.sync` and `local` (the
code says local, and migrates), and one deferred defect as both open and fixed.

A document that is wrong about whether a feature exists is worse than no document,
because it reads exactly like a document that is right. Three files each claiming to be
the source of truth is how that happens.

`tests/docs.test.mjs` now checks what is mechanically checkable: that every file path
the documents name exists and is unambiguous, that every `npm run` they suggest is real,
that every manifest permission is justified in both the privacy policy and the store
listing, that the prices and the trial length agree with `src/plus/plans.ts`, that the
alert thresholds agree with `src/limit/alerts.ts`, that the retention options and the
image-rewrite hosts named in the policy are the ones in the code, and that every GitHub
link names this repository. Adding a tracked Markdown file that the test does not cover
fails the suite, which is what stops the next document drifting quietly.

What it does not check is prose. Whether an explanation is honest or a sentence is clear
still needs a person.

## Before submitting to the Chrome Web Store

Three things are outside what code can do, and none is optional.

1. **Publish `PRIVACY_POLICY.md` at a stable public URL** and put that direct URL in the
   Store's Privacy practices field. `STORE_LISTING.md` carries the GitHub blob URL for
   this; confirm it resolves before submitting. The manifest intentionally declares no
   `homepage_url` — a product homepage is not required for the policy link to work.
2. **Keep the `byte-budget` ExtensionPay configuration in step with the UI.**
   `PRICE_MONTHLY` and `PRICE_YEARLY` in `src/plus/plans.ts` are display strings; they
   cannot set a price. `EXTENSION_ID` in `src/plus/provider.ts` names the configuration.
   Check the code and the provider dashboard together before any price change.
3. **Give reviewers a trial or test subscription**, with the steps already written in
   `STORE_LISTING.md`. Put the credentials in the Store's Test instructions field, never
   in this repository. The browser suite tests the gates and the UI, not a real charge.

Everything else in the submission — the single purpose, the descriptions, the permission
justifications, the privacy-practices selections and the "no remote code" answer — is
written out in `STORE_LISTING.md`.

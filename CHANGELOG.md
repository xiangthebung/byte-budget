# Changelog

Notable changes to Byte Budget, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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
  is installed out of tree, like Playwright, and runs as an advisory CI job
  rather than a gating one.
- `.editorconfig` records what the tree already contains — LF, UTF-8, two-space
  indent, no tabs — so an editor with different defaults cannot turn a two-line
  change into a whole-file diff.

### Pre-release history

The audit that shaped this release is in `AUDIT.md`; each of the four
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

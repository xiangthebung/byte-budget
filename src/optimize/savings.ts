/**
 * What the optimizer saved, and how much of that is a measurement.
 *
 * Three sources, and they are not equally trustworthy. Reporting one number for all
 * three would drag the good one down to the credibility of the weakest, so they are
 * kept apart everywhere — in the ledger, in the messages, and on screen.
 *
 * 1. **A refused request** has no size. The figure is the estimator's guess at what it
 *    would have weighed. Modelled, always.
 * 2. **A rewritten request** does have a size, and so did the original — if the
 *    original variant has ever been observed. Then the saving is subtraction, and it is
 *    measured. Until then it is modelled from the pack's expected ratio.
 * 3. **The difference between page loads** with the optimizer on and off, from a
 *    deliberate holdout. Measured, and the only one that survives the objection "you
 *    are adding up your own guesses". It is the headline wherever there are enough
 *    samples.
 *
 * The baseline store is what makes (2) improve over time. Every time a URL a pack
 * *would* rewrite is fetched un-rewritten — because the pack was off, or because that
 * load was a control — its size is recorded. From then on the saving on that URL is
 * arithmetic rather than a model.
 */

import { countRows, get, put, putMany, runTransaction, STORES } from "../core/db";
import { startOfDay } from "../core/period";
import { getSettings } from "../core/settings";
import { asResourceType, type ResourceType, type Visit, type VisitReason } from "../core/types";
import { getAllFromIndex } from "../core/db";
/**
 * `./apply` and `./holdout` both import this module, so both of these close a cycle.
 *
 * Safe, and deliberately so rather than by luck: every binding involved is a hoisted
 * function declaration, and no module body here calls into either at load time. What
 * would break it is a top-level call — `const x = optimizeSettings()` at module scope
 * would read `null` or throw depending on which module the bundler evaluated first.
 * The alternative was the injection hook `track/tabs.ts` uses, which is there because
 * that cycle crosses a layer boundary; this one does not leave `optimize/`.
 */
import { optimizeSettings } from "./apply";
import { optimizes } from "./features";
import { isHoldoutTab } from "./holdout";
import { PACKS, PACKS_BY_ID, type Pack } from "./packs";

interface Baseline {
  /**
   * SHA-256 hex digest of the URL, not the URL.
   *
   * The field is still called `url` because the object store's `keyPath` is, and
   * changing that needs a `DB_VERSION` bump in `core/db.ts`. What it holds is a digest:
   * these rows are third-party image URLs — `pbs.twimg.com/media/<mediaId>`,
   * `res.cloudinary.com/<cloudName>/…` — and `readBaseline` only ever does an exact-key
   * `get`, so the plaintext was stored for years and read never. Storing it made a
   * browsing-history table out of a size cache.
   *
   * Rows written by an earlier build are keyed on plaintext, so they miss and are
   * rewritten the next time that URL is observed un-rewritten. Accepted: migrating them
   * would mean reading every stored URL back, which is the thing this change exists to
   * stop doing.
   */
  url: string;
  bytes: number;
  updatedAt: number;
}

/** Cap on remembered original sizes. LRU beyond this. */
const MAX_BASELINES = 3000;

/**
 * Oldest observation worth keeping.
 *
 * `pruneBaselines` used to cap by row count alone, and `pruneOldRows` does not touch
 * this store, so a baseline written once survived every retention setting — including
 * the shortest one — for as long as the row count stayed under the cap. A CDN's variant
 * sizes drift anyway, so an observation this old is not evidence of much. Bounded by
 * the person's own retention setting as well, because the privacy policy says retention
 * covers everything recorded.
 */
const MAX_BASELINE_AGE_DAYS = 60;

const DAY_MS = 86_400_000;

/** In-flight rewrites, keyed by `requestId`. */
const rewrites = new Map<string, { original: string; packId: string }>();
const MAX_REWRITES = 2000;

const baselineCache = new Map<string, number>();

/**
 * Records that a request was redirected by one of our packs.
 *
 * Called from `webRequest.onBeforeRedirect`, which is the only place a
 * `declarativeNetRequest` rewrite is observable: the rule itself is applied inside the
 * network stack without telling anyone, and by `onCompleted` the request wears its new
 * URL as though it had always had it.
 */
export function noteRewrite(requestId: string, originalUrl: string, packId: string): void {
  if (rewrites.size >= MAX_REWRITES) {
    const oldest = rewrites.keys().next();
    if (!oldest.done) rewrites.delete(oldest.value);
  }
  rewrites.set(requestId, { original: originalUrl, packId });
}

/**
 * Drops a noted rewrite that will never be priced.
 *
 * The LRU cap above would evict it eventually, which is not the same thing: until
 * then the record is live, and a record that cannot be credited should not be
 * sitting in the map looking as though it can.
 */
export function forgetRewrite(requestId: string): void {
  rewrites.delete(requestId);
}

export interface RewriteCredit {
  saved: number;
  /** How much of `saved` came from a real observation of the original. */
  measured: number;
  pack: Pack;
}

/**
 * Prices a completed rewrite, and forgets it.
 *
 * `null` when the request was not one of ours, which is the common case and must be
 * cheap — this runs for every completed request in the browser.
 */
export async function creditRewrite(
  requestId: string,
  actualBytes: number,
): Promise<RewriteCredit | null> {
  const record = rewrites.get(requestId);
  if (!record) return null;
  rewrites.delete(requestId);

  const pack = PACKS_BY_ID.get(record.packId);
  if (!pack || actualBytes <= 0) return null;

  const baseline = await readBaseline(record.original);
  if (baseline !== null) {
    return { saved: Math.max(0, baseline - actualBytes), measured: Math.max(0, baseline - actualBytes), pack };
  }
  // Modelled: the pack states what fraction of the original the rewritten variant is
  // expected to be, so the original is the actual divided by that fraction.
  const ratio = pack.expectedRatio > 0 && pack.expectedRatio < 1 ? pack.expectedRatio : 0.5;
  const modelled = actualBytes / ratio;
  return { saved: Math.max(0, modelled - actualBytes), measured: 0, pack };
}

/**
 * Compiled once, at module scope.
 *
 * `isRewritable` runs for every completed request in the browser, and it used to build
 * five `RegExp` objects each time to answer "no" — which is the answer for all but a
 * handful of hosts. Nothing was wrong with the answer; the allocation was on the
 * hottest path in the extension.
 */
const REWRITABLE_PATTERNS: readonly RegExp[] = PACKS.map((pack) => new RegExp(pack.regexFilter));

/**
 * `https://<host>/` for every host a pack declares, as a cheap gate in front of them.
 *
 * Sound only while every pack's `regexFilter` is anchored to `^https://` followed by
 * one of that pack's own `hosts` — which is true of all five and is the same invariant
 * the exclusion check already relies on. A pack added with a scheme-agnostic pattern,
 * or with `hosts` that do not match what its pattern accepts, would silently stop
 * banking baselines for itself: no error, just savings that stay modelled forever.
 */
const REWRITABLE_PREFIXES: readonly string[] = [
  ...new Set(PACKS.flatMap((pack) => pack.hosts)),
].map((host) => `https://${host}/`);

/** True when a URL is one a pack would rewrite, so its size is worth remembering. */
export function isRewritable(url: string): boolean {
  let onPackHost = false;
  for (const prefix of REWRITABLE_PREFIXES) {
    if (url.startsWith(prefix)) {
      onPackHost = true;
      break;
    }
  }
  if (!onPackHost) return false;
  for (const pattern of REWRITABLE_PATTERNS) {
    if (pattern.test(url)) return true;
  }
  return false;
}

const encoder = new TextEncoder();

/**
 * The store key for a URL: its SHA-256 digest, hex.
 *
 * `crypto.subtle` is available in the worker. Asynchronous, which is why
 * `observeBaseline` stays synchronous and buffers by plaintext URL — the hashing
 * happens once per row at flush time rather than once per observed image on the
 * request path.
 */
async function baselineKey(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(url));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readBaseline(url: string): Promise<number | null> {
  // Keyed on the plaintext URL, unlike the store. This is memory the request path
  // already holds the URL in, and hashing on every read would buy nothing.
  const cached = baselineCache.get(url);
  if (cached !== undefined) return cached;
  try {
    const row = await get<Baseline>(STORES.baselines, await baselineKey(url));
    if (!row || typeof row.bytes !== "number") return null;
    baselineCache.set(url, row.bytes);
    return row.bytes;
  } catch {
    return null;
  }
}

const pendingBaselines = new Map<string, number>();

/**
 * Remembers what an un-rewritten variant cost.
 *
 * Buffered and written with the ledger flush rather than one write per image: a
 * control page load can produce fifty of these at once.
 */
export function observeBaseline(url: string, bytes: number): void {
  if (bytes <= 0) return;
  pendingBaselines.set(url, bytes);
  baselineCache.set(url, bytes);
}

export async function flushBaselines(): Promise<void> {
  if (pendingBaselines.size === 0) return;
  const now = Date.now();
  const pending = [...pendingBaselines.entries()];
  pendingBaselines.clear();
  const rows: Baseline[] = await Promise.all(
    pending.map(async ([url, bytes]) => ({ url: await baselineKey(url), bytes, updatedAt: now })),
  );
  await putMany(STORES.baselines, rows);
}

/**
 * Bounds the baseline store by age first, then by row count.
 *
 * Age matters more than the cap did. `observeBaseline` runs whenever `isRewritable`
 * says yes, whether or not Data Saver is on, so every install accumulates these — and
 * a row-count cap alone means a profile that never reaches 3000 keeps its first
 * observation forever, outside every retention setting the privacy policy describes.
 */
export async function pruneBaselines(): Promise<void> {
  let maxAgeDays = MAX_BASELINE_AGE_DAYS;
  try {
    const { retentionDays } = await getSettings();
    if (retentionDays > 0) maxAgeDays = Math.min(retentionDays, MAX_BASELINE_AGE_DAYS);
  } catch {
    // Unreadable settings mean the shorter of the two bounds is unknown, not that
    // there is none. The default below is the stricter direction.
  }
  const cutoff = Date.now() - maxAgeDays * DAY_MS;
  await dropBaselines(
    await getAllFromIndex<Baseline>(
      STORES.baselines,
      "byUpdated",
      IDBKeyRange.upperBound(cutoff, true),
    ),
  );

  const total = await countRows(STORES.baselines);
  if (total <= MAX_BASELINES) return;
  // `byUpdated` yields in ascending `updatedAt`, so the first rows the index hands
  // back are exactly the least recently confirmed. Counting first and asking for only
  // the excess keeps this off the "materialise the whole store to take a length" path
  // the count below used to be on.
  await dropBaselines(
    await getAllFromIndex<Baseline>(STORES.baselines, "byUpdated", undefined, total - MAX_BASELINES),
  );
}

/** One transaction, not one per row: both prune paths used to pay a round trip each. */
async function dropBaselines(rows: readonly Baseline[]): Promise<void> {
  if (rows.length === 0) return;
  await runTransaction(STORES.baselines, "readwrite", (transaction) => {
    const store = transaction.objectStore(STORES.baselines);
    for (const row of rows) store.delete(row.url);
  });
  // The cache is keyed on plaintext URLs and the rows carry digests, so there is no
  // way to evict precisely. Clearing it costs re-reads and cannot serve a value for a
  // row that no longer exists, which is the direction that matters.
  baselineCache.clear();
}

export async function baselineCount(): Promise<number> {
  return countRows(STORES.baselines);
}

/** Used by tests and the first-run path. */
export async function seedBaseline(url: string, bytes: number): Promise<void> {
  baselineCache.set(url, bytes);
  await put(STORES.baselines, { url: await baselineKey(url), bytes, updatedAt: Date.now() });
}

/* ------------------------------------------------------------------ *
 * The visit delta
 * ------------------------------------------------------------------ */

/**
 * Minimum samples a side needs before the comparison is looked at.
 *
 * Three is not many. It is chosen because the alternative is reporting nothing for
 * weeks, and because the figure is shown with its sample counts next to it — a reader
 * can discount "3 loads vs 4" for themselves, which they cannot do with a bare number.
 *
 * It is a floor on *whether to look*, not a licence to report: at three a side the
 * interval is wide enough that most differences fail the test below and the row is not
 * shown at all. That is the intended behaviour and not a bug to tune around.
 */
export const MIN_VISIT_SAMPLES = 3;

export interface VisitDelta {
  site: string;
  optimizedCount: number;
  controlCount: number;
  /** Trimmed mean bytes per load, optimizer on. */
  optimizedMean: number;
  /** Trimmed mean bytes per load, optimizer deliberately off. */
  controlMean: number;
  /** Bytes per load avoided. Negative when optimized loads came out heavier. */
  savedPerVisit: number;
  /**
   * Half-width of the 95% interval around `savedPerVisit`, in bytes.
   *
   * Always smaller than `|savedPerVisit|` in a delta that exists at all — a row whose
   * interval covers zero is not returned. Shown so the reader gets "±" rather than a
   * bare number, which is what PLAN.md:386 asks the report to do.
   */
  savedPerVisitSpread: number;
  /** Total across the optimized loads in the window. */
  savedTotal: number;
}

/**
 * Fraction trimmed from each tail before the means are taken.
 *
 * Page weights are heavy-tailed: one video that autoplayed, one ad that loaded a 4 MB
 * creative, and a three-sample arm's raw mean is that outlier. Trimming both tails
 * symmetrically keeps the comparison between the loads a person actually has rather
 * than between two accidents.
 */
const TRIM = 0.2;

interface TrimmedArm {
  mean: number;
  /** Squared standard error of the trimmed mean (Yuen). */
  errorSquared: number;
  degreesOfFreedom: number;
}

/**
 * Trimmed mean, plus the standard error that goes with it.
 *
 * The variance is *winsorised*, not trimmed — the tails are pulled in to the trimming
 * points rather than dropped. That is not a refinement: the sample variance of the
 * trimmed values understates the trimmed mean's error, and using it would be a
 * confidence interval that is too narrow, which is the one direction this figure must
 * not be wrong in.
 *
 * Caller guarantees at least `MIN_VISIT_SAMPLES` values, and `g` is capped so at least
 * two survive the trim; both divisors below depend on that.
 */
function summarise(values: readonly number[]): TrimmedArm {
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const g = Math.min(Math.floor(count * TRIM), Math.floor((count - 2) / 2));
  const lower = sorted[g]!;
  const upper = sorted[count - 1 - g]!;

  const kept = sorted.slice(g, count - g);
  const mean = kept.reduce((sum, value) => sum + value, 0) / kept.length;

  const winsorised = sorted.map((value) => (value < lower ? lower : value > upper ? upper : value));
  const winsorisedMean = winsorised.reduce((sum, value) => sum + value, 0) / count;
  const variance =
    winsorised.reduce((sum, value) => sum + (value - winsorisedMean) ** 2, 0) / (count - 1);

  return {
    mean,
    errorSquared: ((count - 1) * variance) / (kept.length * (kept.length - 1)),
    degreesOfFreedom: kept.length - 1,
  };
}

/**
 * Two-sided 95% Student-t critical values, indexed by degrees of freedom minus one.
 *
 * A table rather than a formula because the samples here are tiny — three loads a side
 * is the floor — and at three degrees of freedom the multiplier is 3.18, not the 1.96
 * that a normal approximation would use. Using 1.96 would declare roughly a third of
 * the noise significant. Past the end of the table the value is held at 2.042 rather
 * than relaxed towards 1.96: slightly too wide, which suppresses a real saving now and
 * then, and never invents one.
 */
const T_95: readonly number[] = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16,
  2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052,
  2.048, 2.045, 2.042,
];

function criticalT(degreesOfFreedom: number): number {
  const index = Math.min(T_95.length, Math.max(1, Math.floor(degreesOfFreedom))) - 1;
  return T_95[index] ?? 2.042;
}

/** Yuen's interval for the difference of two trimmed means, with Welch's df. */
function intervalHalfWidth(a: TrimmedArm, b: TrimmedArm): number {
  const errorSquared = a.errorSquared + b.errorSquared;
  if (!(errorSquared > 0)) return 0;
  const degreesOfFreedom =
    errorSquared ** 2 /
    (a.errorSquared ** 2 / a.degreesOfFreedom + b.errorSquared ** 2 / b.degreesOfFreedom);
  return criticalT(degreesOfFreedom) * Math.sqrt(errorSquared);
}

/**
 * Bytes per finished load on one arm of the comparison.
 *
 * Keyed on `Visit.reason`, and only ever on an exact match. The old test was
 * `visit.optimized` as a boolean, which made a control out of every load that was not
 * optimized: every load from before Data Saver was switched on, every load on an
 * excluded site, and every load where the settings had not resolved yet. Turning the
 * feature on today then produced a "measured" saving that was really before-versus-
 * after-install. A row with no `reason` is a pre-migration row — `"unknown"` — and
 * belongs to neither arm, so an upgrade starts the comparison over rather than
 * inheriting a control group nobody chose.
 */
function armBytes(visits: readonly Visit[], reason: VisitReason): number[] {
  const bytes: number[] = [];
  for (const visit of visits) {
    if (visit.reason === reason) bytes.push(visit.down);
  }
  return bytes;
}

/**
 * The comparison for one site, from that site's visit rows.
 *
 * `null` when there are not enough samples on both sides, and `null` again when the
 * difference cannot be told apart from zero. The second one is the point: two raw
 * means of a heavy-tailed distribution will always differ, so a report that printed
 * whatever came out would be showing noise with a byte count attached — the exact move
 * this project exists to refuse. A significantly *negative* saving is still returned:
 * "the optimizer made this site heavier" is a real result, and hiding it would make the
 * measurement decorative.
 */
function computeDelta(site: string, visits: readonly Visit[]): VisitDelta | null {
  // Only finished loads: an in-flight one is a partial figure and would drag whichever
  // side it happens to be on.
  const finished = visits.filter((visit) => typeof visit.endedAt === "number" && visit.down > 0);
  const optimized = armBytes(finished, "optimized");
  const control = armBytes(finished, "holdout");
  if (optimized.length < MIN_VISIT_SAMPLES || control.length < MIN_VISIT_SAMPLES) return null;

  const treated = summarise(optimized);
  const untreated = summarise(control);
  const savedPerVisit = untreated.mean - treated.mean;
  const savedPerVisitSpread = intervalHalfWidth(treated, untreated);
  if (Math.abs(savedPerVisit) <= savedPerVisitSpread) return null;

  return {
    site,
    optimizedCount: optimized.length,
    controlCount: control.length,
    optimizedMean: treated.mean,
    controlMean: untreated.mean,
    savedPerVisit,
    savedPerVisitSpread,
    savedTotal: savedPerVisit * optimized.length,
  };
}

/** Mean bytes per page load, with the optimizer on versus off, for one site. */
export async function visitDelta(site: string, days = 30): Promise<VisitDelta | null> {
  const from = startOfDay(dayKeyDaysAgo(days)).getTime();
  const visits = await getAllFromIndex<Visit>(
    STORES.visits,
    "bySiteStart",
    IDBKeyRange.bound([site, from], [site, Date.now() + DAY_MS]),
  );
  return computeDelta(site, visits);
}

function dayKeyDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - Math.max(0, days - 1));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Every site with a saving the data can tell apart from zero, heaviest first.
 *
 * One ranged read over `byStart`, bucketed in JavaScript, rather than one indexed
 * query per site. The report is built for every site with a row in the window, so the
 * old shape opened a transaction per site on a store that is already being read
 * end-to-end — forty sites meant forty round trips for the same rows.
 */
export async function visitDeltas(sites: readonly string[], days = 30): Promise<VisitDelta[]> {
  if (sites.length === 0) return [];
  const from = startOfDay(dayKeyDaysAgo(days)).getTime();
  const wanted = new Set(sites);

  let visits: Visit[];
  try {
    visits = await getAllFromIndex<Visit>(STORES.visits, "byStart", IDBKeyRange.lowerBound(from));
  } catch {
    // No visits yet, or the store is unavailable. No comparison is the honest answer;
    // an empty table is what the dashboard already renders for it.
    return [];
  }

  const bySite = new Map<string, Visit[]>();
  for (const visit of visits) {
    if (!wanted.has(visit.site)) continue;
    const rows = bySite.get(visit.site);
    if (rows) rows.push(visit);
    else bySite.set(visit.site, [visit]);
  }

  const deltas: VisitDelta[] = [];
  for (const [site, rows] of bySite) {
    const delta = computeDelta(site, rows);
    if (delta) deltas.push(delta);
  }
  return deltas.sort((a, b) => b.savedTotal - a.savedTotal);
}

/** Resource types the optimizer refuses, for crediting a refusal as a saving. */
let refused: ReadonlySet<ResourceType> = new Set();

export function setRefusedTypes(types: ReadonlySet<ResourceType>): void {
  refused = types;
}

/**
 * Whether *this extension's optimizer* is why a request was refused.
 *
 * The type set alone is not an answer. `net::ERR_BLOCKED_BY_CLIENT` is what Chrome
 * reports for every extension's block, so a bare type test credited an ad blocker's
 * work — and the limiter's — to Data Saver, which is precisely what the comment beside
 * the call site in `track/requests.ts` says must not happen. Its sibling there,
 * `isEnforcedByUs`, has been site-scoped all along; this is the same question asked the
 * same way.
 *
 * The two extra tests are the two exclusions the rules themselves carry (see
 * `optimize/rules.ts`): no optimizer rule is installed for an excluded site, and none
 * for a holdout tab. Where no rule of ours exists, no refusal can be ours. The holdout
 * case is the one that would corrupt something rather than merely flatter it — a
 * control load is chosen to run *without* the optimizer, so crediting it with the
 * optimizer's savings would put treatment bytes in the control arm.
 *
 * `refusedTypes` returns an empty set while the master switch is off, so the first test
 * covers "Data Saver is off" without needing a fourth.
 */
export function isRefusedByOptimizer(
  site: string,
  type: ResourceType | string,
  tabId: number,
): boolean {
  if (!refused.has(asResourceType(String(type)))) return false;
  if (isHoldoutTab(tabId)) return false;
  const settings = optimizeSettings();
  return settings !== null && optimizes(settings, site);
}

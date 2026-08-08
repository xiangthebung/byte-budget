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

import { get, getAll, put, putMany, remove, STORES } from "../core/db";
import { startOfDay } from "../core/period";
import type { ResourceType, Visit } from "../core/types";
import { getAllFromIndex } from "../core/db";
import { PACKS, PACKS_BY_ID, type Pack } from "./packs";

interface Baseline {
  url: string;
  bytes: number;
  updatedAt: number;
}

/** Cap on remembered original sizes. LRU beyond this. */
const MAX_BASELINES = 3000;

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

/** True when a URL is one a pack would rewrite, so its size is worth remembering. */
export function isRewritable(url: string): boolean {
  for (const pack of PACKS) {
    if (new RegExp(pack.regexFilter).test(url)) return true;
  }
  return false;
}

async function readBaseline(url: string): Promise<number | null> {
  const cached = baselineCache.get(url);
  if (cached !== undefined) return cached;
  try {
    const row = await get<Baseline>(STORES.baselines, url);
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
  const rows: Baseline[] = [...pendingBaselines.entries()].map(([url, bytes]) => ({
    url,
    bytes,
    updatedAt: now,
  }));
  pendingBaselines.clear();
  await putMany(STORES.baselines, rows);
}

/** Caps the baseline store, dropping the least recently confirmed. */
export async function pruneBaselines(): Promise<void> {
  const rows = await getAll<Baseline>(STORES.baselines);
  if (rows.length <= MAX_BASELINES) return;
  const excess = rows
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
    .slice(0, rows.length - MAX_BASELINES);
  for (const row of excess) {
    baselineCache.delete(row.url);
    await remove(STORES.baselines, row.url);
  }
}

export async function baselineCount(): Promise<number> {
  return (await getAll<Baseline>(STORES.baselines)).length;
}

/** Used by tests and the first-run path. */
export async function seedBaseline(url: string, bytes: number): Promise<void> {
  baselineCache.set(url, bytes);
  await put(STORES.baselines, { url, bytes, updatedAt: Date.now() });
}

/* ------------------------------------------------------------------ *
 * The visit delta
 * ------------------------------------------------------------------ */

/**
 * Minimum samples a side needs before the comparison is reported.
 *
 * Three is not many. It is chosen because the alternative is reporting nothing for
 * weeks, and because the figure is shown with its sample counts next to it — a reader
 * can discount "3 loads vs 4" for themselves, which they cannot do with a bare number.
 */
export const MIN_VISIT_SAMPLES = 3;

export interface VisitDelta {
  site: string;
  optimizedCount: number;
  controlCount: number;
  optimizedMean: number;
  controlMean: number;
  /** Mean bytes per load avoided. Negative when optimized loads came out heavier. */
  savedPerVisit: number;
  /** Total across the optimized loads in the window. */
  savedTotal: number;
}

/**
 * Mean bytes per page load, with the optimizer on versus off, for one site.
 *
 * `null` until both sides have samples. Deliberately reports a negative saving rather
 * than clamping: if optimized loads are heavier, that is the interesting result and
 * hiding it would make the whole measurement decorative.
 */
export async function visitDelta(site: string, days = 30): Promise<VisitDelta | null> {
  const from = startOfDay(dayKeyDaysAgo(days)).getTime();
  const visits = await getAllFromIndex<Visit>(
    STORES.visits,
    "bySiteStart",
    IDBKeyRange.bound([site, from], [site, Date.now() + 86_400_000]),
  );
  // Only finished loads: an in-flight one is a partial figure and would drag whichever
  // side it happens to be on.
  const finished = visits.filter((visit) => typeof visit.endedAt === "number" && visit.down > 0);
  const optimized = finished.filter((visit) => visit.optimized);
  const control = finished.filter((visit) => !visit.optimized);
  if (optimized.length < MIN_VISIT_SAMPLES || control.length < MIN_VISIT_SAMPLES) return null;

  const mean = (rows: Visit[]) => rows.reduce((sum, row) => sum + row.down, 0) / rows.length;
  const optimizedMean = mean(optimized);
  const controlMean = mean(control);
  const savedPerVisit = controlMean - optimizedMean;

  return {
    site,
    optimizedCount: optimized.length,
    controlCount: control.length,
    optimizedMean,
    controlMean,
    savedPerVisit,
    savedTotal: savedPerVisit * optimized.length,
  };
}

function dayKeyDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - Math.max(0, days - 1));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Every site with enough samples on both sides, heaviest saving first. */
export async function visitDeltas(sites: readonly string[], days = 30): Promise<VisitDelta[]> {
  const results = await Promise.all(sites.map((site) => visitDelta(site, days)));
  return results
    .filter((delta): delta is VisitDelta => delta !== null)
    .sort((a, b) => b.savedTotal - a.savedTotal);
}

/** Resource types the optimizer refuses, for crediting a refusal as a saving. */
let refused: ReadonlySet<ResourceType> = new Set();

export function setRefusedTypes(types: ReadonlySet<ResourceType>): void {
  refused = types;
}

export function isRefusedByOptimizer(type: ResourceType): boolean {
  return refused.has(type);
}

/**
 * The control group.
 *
 * A savings figure with nothing to compare against is the sum of the extension's own
 * guesses about requests it prevented. To make it a measurement, some page loads have
 * to be left alone — and then "with the optimizer" and "without it" are two
 * populations of real loads of the same site, and the difference between their means is
 * an answer rather than an assertion.
 *
 * Three constraints shape how it is done:
 *
 * 1. **The decision has to be synchronous.** It is made in `onBeforeNavigate`, before
 *    the document request goes out, so the rules can be updated while the document is
 *    still in flight. A database read there would be too late and the first
 *    subresources would already be optimized, which would quietly corrupt the control
 *    sample rather than fail. So the counts live in memory and are refreshed on the
 *    maintenance alarm.
 * 2. **It has to be rare and cheap.** A control load is a heavier load, and it is not
 *    something anyone asked for. So: never before a site has five optimized loads to
 *    compare against, never more than once a day per site, and once three controls
 *    exist it drops to the configured rate.
 * 3. **It has to be disclosable.** The rate is a setting, zero is one of the options,
 *    and the dashboard says what it is for.
 */

import { getAllFromIndex, STORES } from "../core/db";
import { dayKey, dayKeyFromMs, startOfDay } from "../core/period";
import type { Visit } from "../core/types";
import type { OptimizeSettings } from "./features";
import { MIN_VISIT_SAMPLES } from "./savings";

/** A site needs this many optimized loads before one is spent on a control. */
const MIN_OPTIMIZED_BEFORE_CONTROL = 5;

/** How far back the sample counts look. Matches the visit-delta window. */
const WINDOW_DAYS = 30;

interface SiteStats {
  optimized: number;
  control: number;
  /** `YYYY-MM-DD` of the most recent control load, or `""`. */
  lastControlDay: string;
}

const stats = new Map<string, SiteStats>();
const holdoutTabs = new Set<number>();
let ready: Promise<void> | null = null;

function statsFor(site: string): SiteStats {
  const existing = stats.get(site);
  if (existing) return existing;
  const created: SiteStats = { optimized: 0, control: 0, lastControlDay: "" };
  stats.set(site, created);
  return created;
}

/**
 * Rebuilds the counts from the visits store.
 *
 * One ranged read over the window rather than one per site: the index is on
 * `[site, startedAt]`, so there is no way to range over "every site since a date", and
 * a scan of thirty days of visits is a few thousand small rows.
 */
export function refreshHoldoutStats(): Promise<void> {
  ready = (async () => {
    const from = startOfDay(dayKeyDaysAgo(WINDOW_DAYS)).getTime();
    let visits: Visit[] = [];
    try {
      visits = await getAllFromIndex<Visit>(
        STORES.visits,
        "byStart",
        IDBKeyRange.lowerBound(from),
      );
    } catch {
      // No visits yet, or the store is unavailable. An empty picture means no holdouts,
      // which is the safe direction: it under-samples rather than over-burdening.
      visits = [];
    }

    stats.clear();
    for (const visit of visits) {
      if (!visit.site || visit.site.startsWith("#")) continue;
      if (typeof visit.endedAt !== "number" || visit.down <= 0) continue;
      const entry = statsFor(visit.site);
      if (visit.optimized) {
        entry.optimized += 1;
      } else {
        entry.control += 1;
        const day = dayKeyFromMs(visit.startedAt);
        if (day > entry.lastControlDay) entry.lastControlDay = day;
      }
    }
  })();
  return ready;
}

export function ensureHoldoutReady(): Promise<void> {
  if (!ready) return refreshHoldoutStats();
  return ready;
}

function dayKeyDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - Math.max(0, days - 1));
  return dayKey(date);
}

export interface HoldoutDecision {
  hold: boolean;
  /** Why, for the dashboard to explain itself rather than looking arbitrary. */
  reason:
    | "off"
    | "excluded"
    | "too-few-optimized"
    | "already-today"
    | "needs-control"
    | "sampled"
    | "not-sampled";
}

/**
 * Whether this page load should be left unoptimized. Synchronous by design.
 *
 * `random` is injectable so the sampling branch can be tested without flakiness.
 */
export function decideHoldout(
  site: string,
  settings: OptimizeSettings,
  now: Date = new Date(),
  random: () => number = Math.random,
): HoldoutDecision {
  if (!settings.enabled || settings.holdoutPercent <= 0) return { hold: false, reason: "off" };
  if (!site || site.startsWith("#")) return { hold: false, reason: "excluded" };
  if (settings.exclusions.includes(site)) return { hold: false, reason: "excluded" };

  const entry = stats.get(site);
  const optimized = entry?.optimized ?? 0;
  const control = entry?.control ?? 0;

  // Nothing to compare against yet: a control load now would be one sample against
  // none, and it would cost someone a slow page for no information.
  if (optimized < MIN_OPTIMIZED_BEFORE_CONTROL) {
    return { hold: false, reason: "too-few-optimized" };
  }
  if (entry?.lastControlDay === dayKey(now)) return { hold: false, reason: "already-today" };

  // Below the minimum, take the sample deterministically. Waiting for a 10% coin to
  // land three times would leave the figure unavailable for weeks on a site visited
  // twice a day.
  if (control < MIN_VISIT_SAMPLES) return { hold: true, reason: "needs-control" };

  return random() * 100 < settings.holdoutPercent
    ? { hold: true, reason: "sampled" }
    : { hold: false, reason: "not-sampled" };
}

/**
 * Records how a load turned out, so the next decision does not need a database read.
 *
 * Called when a visit ends. The counts are rebuilt from disk periodically anyway; this
 * keeps them right in between, which is what stops a site being held out twice in a
 * row before the alarm next fires.
 */
export function noteVisitOutcome(site: string, optimized: boolean, at = Date.now()): void {
  if (!site || site.startsWith("#")) return;
  const entry = statsFor(site);
  if (optimized) {
    entry.optimized += 1;
    return;
  }
  entry.control += 1;
  const day = dayKeyFromMs(at);
  if (day > entry.lastControlDay) entry.lastControlDay = day;
}

/* ------------------------------------------------------------------ *
 * The tab set
 * ------------------------------------------------------------------ */

/**
 * Marks or unmarks a tab as a control load.
 *
 * Returns whether the set changed, so the caller only reinstalls network rules when
 * there is something to change — which is almost never, since almost no load is a
 * control.
 */
export function setTabHoldout(tabId: number, hold: boolean): boolean {
  if (tabId < 0) return false;
  if (hold) return !holdoutTabs.has(tabId) && Boolean(holdoutTabs.add(tabId));
  return holdoutTabs.delete(tabId);
}

export function isHoldoutTab(tabId: number): boolean {
  return holdoutTabs.has(tabId);
}

export function holdoutTabIds(): number[] {
  return [...holdoutTabs].sort((a, b) => a - b);
}

/** Sample counts for the dashboard, so the figure can show its own workings. */
export function holdoutStats(site: string): { optimized: number; control: number } {
  const entry = stats.get(site);
  return { optimized: entry?.optimized ?? 0, control: entry?.control ?? 0 };
}

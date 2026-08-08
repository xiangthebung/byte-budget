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

import { openDb, STORES } from "../core/db";
import { dayKey, dayKeyFromMs, startOfDay } from "../core/period";
import type { Visit } from "../core/types";
import { getOptimizeSettings, type OptimizeSettings } from "./features";
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
  /** `YYYY-MM-DD` the ordinal below belongs to. */
  day: string;
  /** Eligible loads seen today, so the control can be spread across the day. */
  loadsToday: number;
}

const stats = new Map<string, SiteStats>();
const holdoutTabs = new Set<number>();
let ready: Promise<void> | null = null;

function statsFor(site: string): SiteStats {
  const existing = stats.get(site);
  if (existing) return existing;
  const created: SiteStats = {
    optimized: 0,
    control: 0,
    lastControlDay: "",
    day: "",
    loadsToday: 0,
  };
  stats.set(site, created);
  return created;
}

/**
 * Streams every visit since `from` through a callback, one row at a time.
 *
 * A cursor rather than `getAll` because this runs on every worker wake *and* on the
 * one-minute maintenance alarm, and `getAll` materialises thirty days of visit rows —
 * the whole window — into an array that is read once and dropped. The cursor holds one
 * row.
 */
async function eachVisitSince(from: number, visit: (row: Visit) => void): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const request = db
      .transaction(STORES.visits, "readonly")
      .objectStore(STORES.visits)
      .index("byStart")
      .openCursor(IDBKeyRange.lowerBound(from));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      visit(cursor.value as Visit);
      cursor.continue();
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Could not read the visit history."));
  });
}

/**
 * Rebuilds the counts from the visits store.
 *
 * Skipped entirely unless a holdout could actually be taken. Nothing reads these counts
 * while the master switch is off or the rate is zero — `decideHoldout` returns `off`
 * before it looks at them — so the scan was thirty days of rows read on every wake and
 * every minute to populate a map nobody would consult. The counts are left in place
 * rather than cleared on the skip: `noteVisitOutcome` keeps them live, and the person
 * who turns the rate back on gets a correct picture at the next refresh.
 */
export function refreshHoldoutStats(): Promise<void> {
  ready = (async () => {
    await restoreHoldoutTabs();

    let settings: OptimizeSettings;
    try {
      settings = await getOptimizeSettings();
    } catch {
      return;
    }
    if (!settings.enabled || settings.holdoutPercent <= 0) return;

    const from = startOfDay(dayKeyDaysAgo(WINDOW_DAYS)).getTime();
    const today = dayKey();
    const rebuilt = new Map<string, SiteStats>();
    const entryFor = (site: string): SiteStats => {
      const existing = rebuilt.get(site);
      if (existing) return existing;
      const created: SiteStats = {
        optimized: 0,
        control: 0,
        lastControlDay: "",
        day: today,
        loadsToday: 0,
      };
      rebuilt.set(site, created);
      return created;
    };

    try {
      await eachVisitSince(from, (visit) => {
        if (!visit.site || visit.site.startsWith("#")) return;
        /**
         * Classified by `reason`, never by the `optimized` boolean.
         *
         * The boolean was false for a control load *and* for every load on an excluded
         * site, every load taken before Data Saver was switched on, and every load
         * where the settings had not resolved yet. Counting those as controls made a
         * site look like it already had its samples, so the bootstrap below never fired
         * and the one figure that needs a real control group never got one. Rows with
         * no `reason` are pre-migration and count towards neither side.
         */
        const reason = visit.reason;
        if (reason !== "optimized" && reason !== "holdout") return;

        const entry = entryFor(visit.site);
        // Counted before the finished filter: an in-flight load is still a load that
        // happened today, and the ordinal below is about position within the day.
        if (dayKeyFromMs(visit.startedAt) === today) entry.loadsToday += 1;

        if (typeof visit.endedAt !== "number" || visit.down <= 0) return;
        if (reason === "optimized") {
          entry.optimized += 1;
          return;
        }
        entry.control += 1;
        const day = dayKeyFromMs(visit.startedAt);
        if (day > entry.lastControlDay) entry.lastControlDay = day;
      });
    } catch {
      // No visits yet, or the store is unavailable. Keeping the counts we have beats
      // clearing them: an empty picture reads as "this site has never been optimized",
      // which restarts the five-load wait every time a read fails.
      return;
    }

    for (const [site, entry] of rebuilt) {
      // A load decided in this worker but not yet written back has no row to be found,
      // so the rebuilt ordinal can only ever be too low. Taking the higher of the two
      // is what stops a rebuild handing the same day a second run at the low ordinals,
      // where the bootstrap chance is smallest and the bias being fixed lives.
      const previous = stats.get(site);
      if (previous?.day === today && previous.loadsToday > entry.loadsToday) {
        entry.loadsToday = previous.loadsToday;
      }
    }
    stats.clear();
    for (const [site, entry] of rebuilt) stats.set(site, entry);
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
 * Loads across which a bootstrap control is drawn, uniformly.
 *
 * `1 / (SPREAD - seen)` is the standard "choose one of N uniformly from a stream":
 * a quarter at the first eligible load of the day, a third at the second, a half at
 * the third, certainty at the fourth. So the control is equally likely to be any of
 * the first four loads of the day, and on a day with only one or two loads there is
 * still a fair chance of taking one.
 */
const BOOTSTRAP_SPREAD = 4;

function bootstrapChance(ordinal: number): number {
  return 1 / Math.max(1, BOOTSTRAP_SPREAD - (ordinal - 1));
}

/**
 * Counts an eligible load and returns its position in today's sequence.
 *
 * Rebuilt from the visits store on every refresh rather than kept only here, because a
 * worker that is torn down every thirty idle seconds would otherwise start each wake at
 * ordinal one — which is the bias below, reintroduced through the back door.
 */
function noteEligibleLoad(site: string, day: string): number {
  const entry = statsFor(site);
  if (entry.day !== day) {
    entry.day = day;
    entry.loadsToday = 0;
  }
  entry.loadsToday += 1;
  return entry.loadsToday;
}

/**
 * Whether this page load should be left unoptimized. Synchronous by design.
 *
 * Not a pure function: an eligible load is counted, so the next call the same day sees
 * a higher ordinal. That is what makes the draw below spread across the day.
 *
 * `random` is injectable so the sampling branches can be tested without flakiness.
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
  const today = dayKey(now);
  if (entry?.lastControlDay === today) return { hold: false, reason: "already-today" };

  const ordinal = noteEligibleLoad(site, today);

  /**
   * Below the minimum, sample harder — but sample.
   *
   * This used to hold out deterministically, which meant the first three controls a
   * site ever produced were its first eligible load of three different days: cold HTTP
   * cache, cold service worker, an authentication bootstrap. Those loads are heavier
   * for reasons the optimizer had nothing to do with, and since the first load of the
   * day was always spent on the control, the treatment arm was left with the cheap
   * remainder. The comparison then reported the shape of the day as a saving. Drawing
   * the control from anywhere in the first few loads puts first-of-day loads on both
   * sides in proportion, at the cost of a day or two longer to the first figure.
   */
  if (control < MIN_VISIT_SAMPLES) {
    return random() < bootstrapChance(ordinal)
      ? { hold: true, reason: "needs-control" }
      : { hold: false, reason: "not-sampled" };
  }

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
  /**
   * A boolean is coarser than the `reason` the rebuild uses, and knowingly so.
   *
   * "Not optimized" here also covers a load on a site the optimizer had not resolved
   * settings for yet, which is not a control. Booking it as one blocks a real control
   * for the rest of the day — under-sampling, which is the direction this module errs
   * in everywhere else — and the next rebuild from the visits store, which reads
   * `reason`, corrects both counters and this day marker.
   */
  entry.control += 1;
  const day = dayKeyFromMs(at);
  if (day > entry.lastControlDay) entry.lastControlDay = day;
}

/* ------------------------------------------------------------------ *
 * The tab set
 * ------------------------------------------------------------------ */

const SESSION_KEY = "holdoutTabs";

let restored: Promise<void> | null = null;

/**
 * Brings the control tab set back after a worker teardown.
 *
 * Mirrored for the same reason the tab map in `track/tabs.ts` and the decision map in
 * `limit/enforce.ts` are. A control tab outlives the worker; the next wake republishes
 * the optimizer rules from module memory, and an empty `holdoutTabIds()` means the
 * rules carry no `excludedTabIds` — so the tab is quietly optimized while the visit it
 * belongs to still records itself as a control. Nothing fails, no error is logged, and
 * the bias runs one way only: it pulls `controlMean` towards `optimizedMean` and
 * understates the saving, which is the one number the README stakes its case on.
 *
 * ORDERING: this has to have resolved before the first `applyOptimize()` of a wake, or
 * the rules are published without the restored ids and the restore fixes nothing until
 * something else happens to change the set. `ensureHoldoutReady()` is what resolves it;
 * the caller in `background.ts` must await it alongside `ensureEnforcementReady()`
 * rather than fire it off beside the publish.
 */
function restoreHoldoutTabs(): Promise<void> {
  if (restored) return restored;
  restored = (async () => {
    let ids: unknown;
    try {
      const stored = await chrome.storage.session.get(SESSION_KEY);
      ids = stored[SESSION_KEY];
    } catch {
      // No session store, or no `chrome` at all under the test harness. An empty set
      // costs a control load its control status; it cannot cause one to be taken.
      return;
    }
    if (!Array.isArray(ids) || ids.length === 0) return;

    /**
     * Reconciled against the tabs that exist, the way `track/tabs.ts` reconciles its
     * own mirror. Chrome reuses tab ids, so a control tab closed while the worker was
     * asleep leaves an id nothing will ever clear — and whichever tab is handed that id
     * next would be left unoptimized for its whole life while every visit on it records
     * itself as a treatment load. Same contamination as the bug this mirror fixes,
     * pointed the other way.
     */
    let live: Set<number> | null = null;
    try {
      const open = await chrome.tabs.query({});
      live = new Set(
        open.map((tab) => tab.id).filter((id): id is number => typeof id === "number"),
      );
    } catch {
      // No `tabs` access, or the browser is shutting down. Restoring unreconciled beats
      // restoring nothing: a stale id costs one tab its optimization, a dropped one puts
      // an optimized load into the control arm.
      live = null;
    }

    for (const id of ids) {
      if (typeof id !== "number" || id < 0) continue;
      if (live && !live.has(id)) continue;
      holdoutTabs.add(id);
    }
    persistHoldoutTabs();
  })();
  return restored;
}

function persistHoldoutTabs(): void {
  try {
    void chrome.storage.session
      .set({ [SESSION_KEY]: [...holdoutTabs] })
      .catch(() => undefined);
  } catch {
    // The `try` is for a missing `chrome` under the test harness; the `catch` on the
    // promise is for a failed write. Neither is worth surfacing: losing the mirror
    // costs accuracy after the next teardown, not enforcement now, and there is no
    // surface that could act on the report.
  }
}

/**
 * Marks or unmarks a tab as a control load.
 *
 * Returns whether the set changed, so the caller only reinstalls network rules when
 * there is something to change — which is almost never, since almost no load is a
 * control. The mirror is written on exactly those changes, for the same reason.
 */
export function setTabHoldout(tabId: number, hold: boolean): boolean {
  if (tabId < 0) return false;
  const changed = hold
    ? !holdoutTabs.has(tabId) && Boolean(holdoutTabs.add(tabId))
    : holdoutTabs.delete(tabId);
  if (changed) persistHoldoutTabs();
  return changed;
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

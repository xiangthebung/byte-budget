/**
 * The governor: watches usage against the budgets and installs the rules.
 *
 * The counters here are deliberately *not* read from the database. A budget check
 * happens on the path that records every request, and a database read there would
 * be a promise per request; worse, the rows lag the traffic by up to the flush
 * debounce, so a check against them would let a site sail past its cap for two
 * seconds. So each budgeted site keeps a live byte count in memory, primed from the
 * database once and incremented synchronously afterwards.
 *
 * Only budgeted sites are counted. A browser with no limits set does no work here
 * beyond a `Map.get` miss per request.
 */

import { bucketRange, getAll, STORES } from "../core/db";
import { getSettings } from "../core/settings";
import type { Settings, UsageRow } from "../core/types";
import { ledger } from "../track/ledger";
import { tabIdsForSite } from "../track/tabs";
import type { BudgetStatus, TabNotice } from "../core/messages";
import { announce, noticeFor } from "./notify";
import {
  allowanceOf,
  getBudgets,
  isSnoozed,
  periodKeyFor,
  periodDaysFor,
  periodResetsAt,
  tierFor,
  type Budget,
} from "./budgets";
import { enforcementFor, setEnforcement } from "./enforce";
import { applyThrottleToTabs, clearAllThrottles } from "./throttle";

interface Live {
  budget: Budget;
  periodKey: string;
  used: number;
  /** False until the database has been read for this window. */
  primed: boolean;
}

const live = new Map<string, Live>();
let settings: Settings | null = null;
let ready: Promise<void> | null = null;
/** Coalesces the enforcement writes that a burst of requests would otherwise cause. */
let syncQueued = false;

export function budgetedSites(): string[] {
  return [...live.keys()];
}

/**
 * Reloads the budgets and re-primes every live counter.
 *
 * Called at startup, after a budget changes, and at period rollover. Priming is a
 * ranged index read per budgeted site — a handful of reads, not one per request.
 */
export async function reloadBudgets(): Promise<void> {
  settings = await getSettings();
  const budgets = await getBudgets();
  const seen = new Set<string>();

  for (const budget of budgets) {
    seen.add(budget.site);
    const periodKey = periodKeyFor(budget.period, settings.weekStart);
    const existing = live.get(budget.site);
    if (existing && existing.periodKey === periodKey && existing.primed) {
      existing.budget = budget;
      continue;
    }
    live.set(budget.site, { budget, periodKey, used: 0, primed: false });
  }

  for (const site of [...live.keys()]) {
    if (!seen.has(site)) live.delete(site);
  }

  await Promise.all([...live.values()].filter((entry) => !entry.primed).map(prime));
  await syncEnforcement();
}

function ensureReady(): Promise<void> {
  if (!ready) ready = reloadBudgets();
  return ready;
}

/** Reads the window's usage so far out of the ledger. */
async function prime(entry: Live): Promise<void> {
  const weekStart = settings?.weekStart ?? 1;
  const days = periodDaysFor(entry.budget.period, weekStart);
  let used = 0;

  if (!days) {
    const session = await ledger.sessionUsage();
    const delta = session.sites[entry.budget.site];
    used = delta ? delta.down + delta.up : 0;
  } else {
    // Flush first: the rows have to include everything recorded so far, or the
    // primed figure starts low and the site gets a free debounce interval.
    await ledger.flush();
    const rows = await getAll<UsageRow>(STORES.daily, bucketRange(days.from, days.to));
    for (const row of rows) {
      if (row.site === entry.budget.site) used += row.down + row.up;
    }
  }

  entry.used = used;
  entry.primed = true;
}

/**
 * Counts bytes against a site's budget.
 *
 * Synchronous and cheap: called from `ledger.record` for every request. Returns
 * without touching anything when the site has no budget, which is the common case.
 */
export function noteUsage(site: string, bytes: number): void {
  const entry = live.get(site);
  if (!entry || bytes <= 0) return;
  entry.used += bytes;

  const allowance = allowanceOf(entry.budget, entry.periodKey);
  const wanted = isSnoozed(entry.budget) ? "off" : tierFor(entry.budget, entry.used, allowance);
  if (wanted === enforcementFor(site)) return;

  // A burst of requests can cross a threshold many times in one turn of the event
  // loop; one rule installation is enough for all of them.
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    void syncEnforcement();
  });
}

/**
 * Brings the installed rules in line with what the numbers say.
 *
 * Also drives the throttle channel's per-tab speed cap, which is a no-op in the
 * store build — that build has no `debugger` permission and no API that can pace a
 * request.
 */
export async function syncEnforcement(): Promise<void> {
  const units = settings?.units ?? "si";
  for (const [site, entry] of live) {
    const tabIds = tabIdsForSite(site);
    const allowance = allowanceOf(entry.budget, entry.periodKey);
    const wanted = isSnoozed(entry.budget) ? "off" : tierFor(entry.budget, entry.used, allowance);

    if (wanted !== enforcementFor(site)) {
      await setEnforcement(site, wanted, tabIds);
      // The banner is updated from the same place the rules are, so it can never
      // claim a limit that has just been lifted or miss one that has just landed.
      const status: BudgetStatus = {
        budget: entry.budget,
        used: entry.used,
        allowance,
        share: allowance > 0 ? entry.used / allowance : 0,
        tier: wanted,
        wouldBe: tierFor(entry.budget, entry.used, allowance),
        snoozed: isSnoozed(entry.budget),
        periodKey: entry.periodKey,
        resetsAt: periodResetsAt(entry.budget.period, settings?.weekStart ?? 1),
      };
      await announce(tabIds, noticeFor(status, units));
    }

    await applyThrottleToTabs(site, entry.budget.kbps ?? null, tabIds);
  }
}

/** The banner text for one tab, for the banner script to ask for on load. */
export async function noticeForTab(site: string): Promise<TabNotice | null> {
  const status = await budgetStatusFor(site);
  if (!status) return null;
  return noticeFor(status, settings?.units ?? "si");
}

/**
 * Rolls windows over and re-evaluates.
 *
 * Called from the one-minute maintenance alarm, which is also what makes a snooze
 * expire and a grant evaporate at midnight without either needing its own timer.
 */
export async function refreshWindows(): Promise<void> {
  await ensureReady();
  settings = await getSettings();
  let rolled = false;
  for (const entry of live.values()) {
    const periodKey = periodKeyFor(entry.budget.period, settings.weekStart);
    if (periodKey === entry.periodKey) continue;
    entry.periodKey = periodKey;
    entry.used = 0;
    entry.primed = false;
    rolled = true;
  }
  if (rolled) {
    await Promise.all([...live.values()].filter((entry) => !entry.primed).map(prime));
  }
  // Even without a rollover: a snooze may have expired since the last pass.
  await syncEnforcement();
}

export async function budgetStatuses(): Promise<BudgetStatus[]> {
  await ensureReady();
  const weekStart = settings?.weekStart ?? 1;
  return [...live.values()].map((entry) => {
    const allowance = allowanceOf(entry.budget, entry.periodKey);
    return {
      budget: entry.budget,
      used: entry.used,
      allowance,
      share: allowance > 0 ? entry.used / allowance : 0,
      tier: enforcementFor(entry.budget.site),
      wouldBe: tierFor(entry.budget, entry.used, allowance),
      snoozed: isSnoozed(entry.budget),
      periodKey: entry.periodKey,
      resetsAt: periodResetsAt(entry.budget.period, weekStart),
    };
  });
}

export async function budgetStatusFor(site: string): Promise<BudgetStatus | null> {
  const all = await budgetStatuses();
  return all.find((status) => status.budget.site === site) ?? null;
}

/** The current window key for a site, for granting extra bytes to it. */
export async function currentPeriodKey(site: string): Promise<string> {
  await ensureReady();
  return live.get(site)?.periodKey ?? "session";
}

/** Called after any change to the stored budgets. */
export async function budgetsChanged(): Promise<void> {
  ready = reloadBudgets();
  await ready;
}

/** Called when all usage is deleted: the windows restart from zero. */
export async function resetCounters(): Promise<void> {
  for (const entry of live.values()) {
    entry.used = 0;
    entry.primed = true;
  }
  await clearAllThrottles();
  await syncEnforcement();
}

export function startGovernor(): void {
  void ensureReady();
}

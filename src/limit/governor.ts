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
import type { Tier } from "./tiers";
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

  // Carried into `syncEnforcement` rather than just dropped. Once a site leaves
  // `live` nothing iterates it again, so `setEnforcement(site, "off")` would never
  // run — and the `initiatorDomains` half of an enforcement rule needs no open tab,
  // so it would outlive the budget it came from and only die at browser restart.
  // The Remove button is the escape hatch from a site that looks broken; pressing it
  // has to actually unbreak it.
  const dropped: string[] = [];
  for (const site of [...live.keys()]) {
    if (!seen.has(site)) {
      live.delete(site);
      dropped.push(site);
    }
  }

  await Promise.all([...live.values()].filter((entry) => !entry.primed).map(prime));
  await syncEnforcement(dropped);
}

function ensureReady(): Promise<void> {
  if (ready) return ready;
  const attempt = reloadBudgets().catch((error: unknown) => {
    // Clearing the memo is the whole point. `budgetStatuses`, `refreshWindows` and
    // `currentPeriodKey` all await this, so one rejected rule install would otherwise
    // make all three throw for the rest of the worker's life — for a failure whose
    // retry was a minute away and would very likely have worked.
    ready = null;
    console.error("Byte Budget: could not load the budgets", error);
  });
  ready = attempt;
  return attempt;
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
 * Which tabs have been told about a site's limit, and which tier they were told.
 *
 * The banner is not a manifest content script — it is in a page only because
 * `announce` injected it there, so it dies with the document that carried it.
 * Announcing only when the *tier* changed therefore explained the limit to exactly
 * one document per site, ever: a reload, or a second tab, found the tier unchanged
 * and got a page whose images and scripts are all refused with nothing on it saying
 * why. That is precisely the "reads as a broken website" failure the banner exists
 * to prevent, and `strict` is where it is worst.
 *
 * The tier is held alongside the tab set because a tier change makes every banner
 * already on screen wrong rather than merely absent. Records are dropped when a site
 * falls back to `off`, when its budget goes away, and — driven from `background.ts` —
 * when a tab navigates or closes.
 */
const announced = new Map<string, { tier: Tier; tabIds: Set<number> }>();

/**
 * Forgets that a tab was told, so the next pass tells it again.
 *
 * Called on navigation as well as on close: a tab id survives a navigation, but the
 * document that was carrying the banner does not.
 */
export function forgetAnnouncedTab(tabId: number): void {
  if (announced.size === 0) return;
  for (const record of announced.values()) record.tabIds.delete(tabId);
}

/**
 * The tabs showing `site` that have not been told about `tier`, marked as told.
 *
 * Marked before the message goes out rather than after it succeeds. `announce`
 * swallows its failures — a restricted origin cannot host the banner at all — and
 * retrying one every sixty seconds forever would buy nothing. The record is cleared
 * on the tab's next navigation, which is the only point at which it could work.
 */
function claimNotice(site: string, tier: Tier, tabIds: readonly number[]): number[] {
  const record = announced.get(site);
  if (!record || record.tier !== tier) {
    announced.set(site, { tier, tabIds: new Set(tabIds) });
    return [...tabIds];
  }
  const pending = tabIds.filter((tabId) => !record.tabIds.has(tabId));
  for (const tabId of pending) record.tabIds.add(tabId);
  return pending;
}

/**
 * Brings the installed rules in line with what the numbers say.
 *
 * `dropped` names sites that have just lost their budget: they are no longer in
 * `live`, so nothing else will ever reach them again.
 *
 * Also drives the throttle channel's per-tab speed cap, which is a no-op in the
 * store build — that build has no `debugger` permission and no API that can pace a
 * request.
 */
export async function syncEnforcement(dropped: readonly string[] = []): Promise<void> {
  const units = settings?.units ?? "si";

  for (const site of dropped) {
    try {
      const tabIds = tabIdsForSite(site);
      await setEnforcement(site, "off", []);
      announced.delete(site);
      await announce(tabIds, null);
      await applyThrottleToTabs(site, null, tabIds);
    } catch (error) {
      console.error("Byte Budget: could not lift enforcement for", site, error);
    }
  }

  for (const [site, entry] of live) {
    // Guarded per site. The loop used to be unguarded, so a single rejected rule
    // install aborted it and every site after this one in iteration order went
    // unevaluated — including sites that were over budget and enforcing nothing.
    try {
      const tabIds = tabIdsForSite(site);
      const allowance = allowanceOf(entry.budget, entry.periodKey);
      const wanted = isSnoozed(entry.budget)
        ? "off"
        : tierFor(entry.budget, entry.used, allowance);
      const previous = enforcementFor(site);

      if (wanted !== previous) await setEnforcement(site, wanted, tabIds);

      if (wanted === "off") {
        announced.delete(site);
        // Withdrawn only on the transition. Pushing a null notice every pass would
        // message every tab of every under-budget site once a minute, to remove a
        // banner that is not there.
        if (previous !== "off") await announce(tabIds, null);
      } else {
        const pending = claimNotice(site, wanted, tabIds);
        if (pending.length > 0) {
          // Composed from the same numbers that just installed the rules, so the
          // banner can never claim a limit that has been lifted or miss one that has
          // just landed.
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
          await announce(pending, noticeFor(status, units));
        }
      }

      await applyThrottleToTabs(site, entry.budget.kbps ?? null, tabIds);
    } catch (error) {
      console.error("Byte Budget: could not enforce the budget for", site, error);
    }
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
  const attempt = reloadBudgets();
  // The memo is what everything else awaits, and it must not be left holding a
  // rejected promise; the caller is a user action and does get the failure, because
  // "the limit was saved" and "the limit is being enforced" are different claims.
  ready = attempt.catch(() => {
    ready = null;
  });
  await attempt;
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

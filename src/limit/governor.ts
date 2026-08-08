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
 * Only budgeted sites are counted, plus the budget over everything if one is set —
 * that one is credited with every site's bytes, including the reserved buckets no
 * per-site limit can name. A browser with no limits set does no work here beyond a
 * `Map.get` miss per request.
 */

import { bucketRange, getAll, getAllFromIndex, STORES } from "../core/db";
import { getSettings } from "../core/settings";
import { ALL_SITES, type Settings, type UsageRow } from "../core/types";
import { ledger } from "../track/ledger";
import { openTabRecords, tabIdsForSite } from "../track/tabs";
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
  type BudgetPeriod,
} from "./budgets";
import { checkAllowanceAlerts, type AllowanceReading } from "./alerts";
import { enforcementFor, setEnforcement } from "./enforce";
import { TIERS, type Tier } from "./tiers";
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

/**
 * When the browser session the session-scoped windows belong to began.
 *
 * `ledger` keeps the session total in `chrome.storage.session`, which Chrome clears
 * when the browser closes, so its start time is the only value that identifies "this
 * session" to both the counter and the budget checked against it. Zero until a
 * session budget exists to need it — reading it costs a promise, and the common case
 * is a browser with no session budget at all.
 */
let sessionStart = 0;

async function refreshSessionStart(periods: Iterable<BudgetPeriod>): Promise<void> {
  for (const period of periods) {
    if (period !== "session") continue;
    sessionStart = (await ledger.sessionUsage()).startedAt;
    return;
  }
}

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
  await refreshSessionStart(budgets.map((budget) => budget.period));
  const seen = new Set<string>();

  for (const budget of budgets) {
    seen.add(budget.site);
    const periodKey = periodKeyFor(budget.period, settings.weekStart, new Date(), sessionStart);
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
  const site = entry.budget.site;
  const total = site === ALL_SITES;
  let used = 0;

  if (!days) {
    const session = await ledger.sessionUsage();
    if (total) {
      for (const delta of Object.values(session.sites)) used += delta.down + delta.up;
    } else {
      const delta = session.sites[site];
      used = delta ? delta.down + delta.up : 0;
    }
  } else {
    // Flush first: the rows have to include everything recorded so far, or the
    // primed figure starts low and the site gets a free debounce interval.
    await ledger.flush();
    if (total) {
      // The one budget that legitimately reads every site's rows: its number *is* the
      // sum over all of them, reserved buckets included, so there is no index that
      // narrows the work. `bucketRange` still bounds it to the window.
      const rows = await getAll<UsageRow>(STORES.daily, bucketRange(days.from, days.to));
      for (const row of rows) used += row.down + row.up;
    } else {
      // "This site, over this range" is exactly what the compound index is for. This
      // used to read every site's rows for the window and filter in JS, so priming one
      // budget cost a scan proportional to how many sites the browser had ever
      // visited — on the path a budget change and every window rollover waits behind.
      const rows = await getAllFromIndex<UsageRow>(
        STORES.daily,
        "bySiteBucket",
        IDBKeyRange.bound([site, days.from], [site, days.to]),
      );
      for (const row of rows) used += row.down + row.up;
    }
  }

  entry.used = used;
  entry.primed = true;
}

/**
 * Adds bytes to one live counter, and says whether the installed tier is now wrong.
 */
function charge(entry: Live, site: string, bytes: number): boolean {
  entry.used += bytes;
  const allowance = allowanceOf(entry.budget, entry.periodKey);
  const wanted = isSnoozed(entry.budget) ? "off" : tierFor(entry.budget, entry.used, allowance);
  return wanted !== enforcementFor(site);
}

/**
 * Counts bytes against the budgets that cover them.
 *
 * Synchronous and cheap: called from `ledger.record` for every request. Returns
 * without touching anything when nothing budgets that site, which is the common case.
 *
 * Two counters can be owed the same bytes — the site's own budget and the budget over
 * everything — and the total is credited whatever the site key is, reserved buckets
 * included. `#background` is other extensions, service workers and browser services:
 * real traffic on the same plan, with no origin of its own, and leaving it out would
 * make the one budget that claims to cover everything the only one that cannot see it.
 */
export function noteUsage(site: string, bytes: number): void {
  if (bytes <= 0) return;
  let crossed = false;

  const own = live.get(site);
  if (own) crossed = charge(own, site, bytes);

  // Guarded, so a request that somehow arrives keyed `#all` is counted once.
  if (site !== ALL_SITES) {
    const total = live.get(ALL_SITES);
    if (total) crossed = charge(total, ALL_SITES, bytes) || crossed;
  }

  if (!crossed) return;

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
 * What each tab has been told, and which budget told it.
 *
 * The banner is not a manifest content script — it is in a page only because
 * `announce` injected it there, so it dies with the document that carried it.
 * Announcing only when the *tier* changed therefore explained the limit to exactly
 * one document per site, ever: a reload, or a second tab, found the tier unchanged
 * and got a page whose images and scripts are all refused with nothing on it saying
 * why. That is precisely the "reads as a broken website" failure the banner exists
 * to prevent, and `strict` is where it is worst.
 *
 * Keyed by tab rather than by site because a tab can be inside two limits at once —
 * its own site's and the one over everything — and it has one banner to say so with.
 * The claim that is doing the cutting is the one recorded, so a change of *which*
 * limit is biting re-announces exactly like a change of tier. Records are dropped
 * when nothing claims the tab any more and — driven from `background.ts` — when a tab
 * navigates or closes.
 */
const announced = new Map<number, { site: string; tier: Tier }>();

/**
 * Forgets that a tab was told, so the next pass tells it again.
 *
 * Called on navigation as well as on close: a tab id survives a navigation, but the
 * document that was carrying the banner does not.
 */
export function forgetAnnouncedTab(tabId: number): void {
  announced.delete(tabId);
}

/** One budget's claim on one tab's banner. */
interface Claim {
  site: string;
  tier: Tier;
  notice: TabNotice;
}

/**
 * The claim that is doing the cutting, of two that both are.
 *
 * The stricter tier wins because every tier's refused set is a prefix of the same
 * shed order, so the deeper one is a superset: its sentence describes what the reader
 * is actually seeing, and the other's would understate it. A tie goes to the per-site
 * budget, because "example.com has used up its data limit" names something the reader
 * can act on and "everything has" does not.
 */
function strongest(current: Claim | undefined, next: Claim): Claim {
  if (!current) return next;
  const deeper = TIERS.indexOf(next.tier) - TIERS.indexOf(current.tier);
  if (deeper > 0) return next;
  if (deeper === 0 && current.site === ALL_SITES && next.site !== ALL_SITES) return next;
  return current;
}

/**
 * Every tab the extension knows about, for a limit that is biting in all of them.
 *
 * A per-site limit explains itself in the tabs showing that site. The total limit has
 * no site, so `tabIdsForSite` finds nothing for it by construction — routed the same
 * way it would refuse a page's images and video and put the explanation nowhere.
 */
function announceableTabs(): number[] {
  return openTabRecords()
    .map((record) => record.tabId)
    .sort((a, b) => a - b);
}

/**
 * Headlines for the budget that is on no site.
 *
 * `notify.ts` builds every headline around the site the limit is on, which is the
 * right sentence for four budgets out of five and reads as "#all has used up its data
 * limit" for the fifth. Only the subject changes here: the figures and the reset line
 * are the same sentence either way, so they stay composed in one place.
 *
 * The notice keeps `ALL_SITES` as its site, which is what the banner's Pause button
 * sends back — pausing the total limit, rather than the page's own.
 */
const TOTAL_HEADLINES: Record<string, string> = {
  trim: "Video and audio are being skipped to stay inside your total data limit",
  lean: "Images and video are being skipped to stay inside your total data limit",
  strict: "Your total data limit is used up",
};

function noticeFrom(status: BudgetStatus, units: Settings["units"]): TabNotice | null {
  const notice = noticeFor(status, units);
  if (!notice || status.budget.site !== ALL_SITES) return notice;
  return { ...notice, headline: TOTAL_HEADLINES[status.tier] ?? notice.headline };
}

/** A live counter as the UI and the banner see it, at a given installed tier. */
function statusOf(entry: Live, tier: Tier): BudgetStatus {
  const allowance = allowanceOf(entry.budget, entry.periodKey);
  return {
    budget: entry.budget,
    used: entry.used,
    allowance,
    share: allowance > 0 ? entry.used / allowance : 0,
    tier,
    wouldBe: tierFor(entry.budget, entry.used, allowance),
    snoozed: isSnoozed(entry.budget),
    periodKey: entry.periodKey,
    resetsAt: periodResetsAt(entry.budget.period, settings?.weekStart ?? 1),
  };
}

/**
 * Brings each tab's banner in line with the claims on it.
 *
 * Tabs are marked as told before the message goes out rather than after it succeeds.
 * `announce` swallows its failures — a restricted origin cannot host the banner at
 * all — and retrying one every sixty seconds forever would buy nothing. The record is
 * cleared on the tab's next navigation, which is the only point at which it could
 * start working.
 */
async function publishNotices(claims: ReadonlyMap<number, Claim>): Promise<void> {
  const withdraw: number[] = [];
  for (const tabId of [...announced.keys()]) {
    if (claims.has(tabId)) continue;
    announced.delete(tabId);
    withdraw.push(tabId);
  }

  // Grouped by the notice they share, so a limit biting in forty tabs is still one
  // message per tab and not one per tab per budget.
  const updates = new Map<TabNotice, number[]>();
  for (const [tabId, claim] of claims) {
    const told = announced.get(tabId);
    if (told && told.site === claim.site && told.tier === claim.tier) continue;
    announced.set(tabId, { site: claim.site, tier: claim.tier });
    const group = updates.get(claim.notice);
    if (group) group.push(tabId);
    else updates.set(claim.notice, [tabId]);
  }

  const sent: Promise<void>[] = [...updates].map(([notice, tabIds]) => announce(tabIds, notice));
  // Withdrawn only from tabs that were actually told. Pushing a null notice every pass
  // would message every tab of every under-budget site once a minute, to remove a
  // banner that is not there.
  if (withdraw.length > 0) sent.push(announce(withdraw, null));
  await Promise.all(sent);
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
      await setEnforcement(site, "off", []);
      // No tabs: with no cap left to apply, the empty set is the retraction, and the
      // withdrawal of its banner falls out of the claims pass below.
      await applyThrottleToTabs(site, null, []);
    } catch (error) {
      console.error("Byte Budget: could not lift enforcement for", site, error);
    }
  }

  /** The banner each tab should be showing once this pass is done. */
  const claims = new Map<number, Claim>();

  /**
   * What each allowance stands at, for the alerting pass below.
   *
   * Collected here rather than computed again because this is the one place that
   * already holds every live budget with its window primed. Gathered unconditionally —
   * regardless of tier, and regardless of a snooze — because an alert is about the
   * number, not about the enforcement. Someone who paused a limit still wants to know
   * they have spent 90% of it; that is most of why they paused it.
   */
  const readings: AllowanceReading[] = [];

  for (const [site, entry] of live) {
    // Guarded per site. The loop used to be unguarded, so a single rejected rule
    // install aborted it and every site after this one in iteration order went
    // unevaluated — including sites that were over budget and enforcing nothing.
    try {
      const total = site === ALL_SITES;
      const tabIds = total ? announceableTabs() : tabIdsForSite(site);
      const allowance = allowanceOf(entry.budget, entry.periodKey);
      const wanted = isSnoozed(entry.budget) ? "off" : tierFor(entry.budget, entry.used, allowance);

      readings.push({
        site,
        used: entry.used,
        allowance,
        periodKey: entry.periodKey,
        resetsAt: periodResetsAt(entry.budget.period, settings?.weekStart ?? 1),
      });

      // The total budget's rule is unscoped, so it is given no tabs to be scoped by.
      // Handing it the tabs its banner goes to would make every tab that opens or
      // closes look like a rule change to `refreshEnforcementTabs`, which would
      // republish the whole session set to install a byte-identical rule.
      if (wanted !== enforcementFor(site)) {
        await setEnforcement(site, wanted, total ? [] : tabIds);
      }

      if (wanted !== "off") {
        // Composed from the same numbers that just installed the rules, so the banner
        // can never claim a limit that has been lifted or miss one that has just
        // landed.
        const notice = noticeFrom(statusOf(entry, wanted), units);
        if (notice) {
          for (const tabId of tabIds) {
            claims.set(tabId, strongest(claims.get(tabId), { site, tier: wanted, notice }));
          }
        }
      }

      await applyThrottleToTabs(site, entry.budget.kbps ?? null, tabIds);
    } catch (error) {
      console.error("Byte Budget: could not enforce the budget for", site, error);
    }
  }

  await publishNotices(claims);

  // One call for the whole pass, not one per site: it does a single storage read and
  // write, and it dedupes across the set so a browser with a plan budget and six site
  // budgets cannot produce seven notifications in one minute. It never rejects, so it
  // needs no guard of its own.
  await checkAllowanceAlerts(readings, units);
}

/**
 * The banner text for one tab, for the banner script to ask for on load.
 *
 * Both the site's own limit and the limit over everything can be biting on the page,
 * so this arbitrates the same way `syncEnforcement` does — a banner that named the
 * weaker of the two would describe less than the reader can see being refused.
 */
export async function noticeForTab(site: string): Promise<TabNotice | null> {
  await ensureReady();
  const units = settings?.units ?? "si";
  let best: Claim | undefined;
  for (const key of site === ALL_SITES ? [ALL_SITES] : [site, ALL_SITES]) {
    const entry = live.get(key);
    const tier = enforcementFor(key);
    if (!entry || tier === "off") continue;
    const notice = noticeFrom(statusOf(entry, tier), units);
    if (notice) best = strongest(best, { site: key, tier, notice });
  }
  return best?.notice ?? null;
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
  await refreshSessionStart([...live.values()].map((entry) => entry.budget.period));
  let rolled = false;
  for (const entry of live.values()) {
    const periodKey = periodKeyFor(
      entry.budget.period,
      settings.weekStart,
      new Date(),
      sessionStart,
    );
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
  return [...live.values()].map((entry) => statusOf(entry, enforcementFor(entry.budget.site)));
}

export async function budgetStatusFor(site: string): Promise<BudgetStatus | null> {
  const all = await budgetStatuses();
  return all.find((status) => status.budget.site === site) ?? null;
}

/**
 * The current window key for a site, for granting extra bytes to it.
 *
 * The fallback is a key no window is filed under, deliberately: a grant against a
 * site with no budget is refused by `grantBytes` anyway, and a key that happened to
 * match a real window would credit the wrong one if that ever stopped being true.
 */
export async function currentPeriodKey(site: string): Promise<string> {
  await ensureReady();
  return live.get(site)?.periodKey ?? "";
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

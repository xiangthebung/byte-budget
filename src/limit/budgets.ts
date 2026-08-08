/**
 * The budget model: what a limit is, and what tier a given amount of use implies.
 *
 * Pure and storage, no enforcement. `governor.ts` owns the live counters and
 * installs the rules; keeping the arithmetic here means the interesting decisions —
 * when to start shedding, how much to arm early, what a period even is — can be
 * asserted in a test rather than watched in a browser.
 */

import { addDays, cycleResetsAt, dayKey, startOfCycle, startOfWeek } from "../core/period";
import { ALL_SITES, type Settings } from "../core/types";
import type { Tier } from "./tiers";

/**
 * What the three window functions below need in order to place a window.
 *
 * An object rather than the bare `weekStart` they used to take, because a `month`
 * budget is not a calendar month. Anchoring it to the 1st while the plan, the
 * projection and the "resets in N days" line all counted from `cycleStartDay` meant a
 * person who told us their plan resets on the 17th got an allowance that rolled over on
 * the 1st — so the 100% alert fired against a window nothing else in the product
 * agreed with, and the figure on screen never matched the figure on the bill. Passing
 * both together is what stops the two drifting apart again: there is no signature here
 * that can place a monthly window without being told which day it starts on.
 */
export type BudgetWindow = Pick<Settings, "weekStart" | "cycleStartDay">;

export const BUDGET_PERIODS = ["session", "day", "week", "month"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const BUDGET_PERIOD_LABELS: Record<BudgetPeriod, string> = {
  session: "per session",
  day: "per day",
  week: "per week",
  month: "per month",
};

/**
 * How a budget sheds weight as it fills.
 *
 * `progressive` is the default because it is the one that keeps a site usable: the
 * page still works at 90% of its budget, it just stops streaming video. `hard` is
 * what people expect a cap to mean, so it is offered rather than argued with.
 */
export const BUDGET_SHAPES = ["progressive", "hard"] as const;
export type BudgetShape = (typeof BUDGET_SHAPES)[number];

export const BUDGET_SHAPE_LABELS: Record<BudgetShape, string> = {
  progressive: "Shed weight as it fills",
  hard: "Nothing until it runs out",
};

export interface Budget {
  /**
   * The site the limit is on, or `ALL_SITES` for a limit over everything.
   *
   * `ALL_SITES` is the only reserved key a budget may carry, and it is not a
   * convenience: "stop me at 10 GB across everything" is what a person on a metered
   * plan actually asks for, and it is the only way the `#background` bucket — other
   * extensions, service workers, browser services — can be held to a limit at all,
   * since those requests have no origin to scope a per-site rule against.
   */
  site: string;
  /** Bytes allowed per period, before any grant. */
  bytes: number;
  period: BudgetPeriod;
  shape: BudgetShape;
  createdAt: number;
  /** Enforcement is suspended until this timestamp. */
  snoozedUntil?: number;
  /** Extra bytes granted for one period only. */
  grantedBytes?: number;
  /** The period key the grant belongs to, so it evaporates at rollover. */
  grantedFor?: string;
  /**
   * Throttle channel only: a download cap in kilobits per second. Ignored by the
   * store build, which has no API that can pace a request.
   */
  kbps?: number;
}

/**
 * A limit you can overshoot is not a limit.
 *
 * Requests already in flight when a threshold is crossed cannot be recalled, and
 * installing rules takes a moment, so enforcement arms slightly early. The band is
 * nominally 2% of the allowance, floored at 250 kB so a small budget still has one,
 * and capped at 4 MB so a large one does not give away a meaningful slice. Four
 * megabytes is roughly one 1080p video segment, which is the unit the overshoot
 * actually arrives in.
 */
export function guardBytes(allowance: number): number {
  if (allowance <= 0) return 0;
  // Never more than a tenth of the allowance. The 250 kB floor exists so a small
  // budget still has a band at all, but applied unconditionally it would eat 43% of
  // a 600 kB budget and enforce almost immediately — a guard band that swallows the
  // budget is not a guard band.
  const ceiling = Math.min(4_000_000, allowance * 0.1);
  return Math.min(Math.max(allowance * 0.02, 256_000), ceiling);
}

/**
 * Where each tier engages, as a fraction of the allowance.
 *
 * Chosen so the first thing a person notices is video quality dropping, well before
 * anything breaks — and so that by the time images go, the number on screen is
 * clearly close to the limit they set.
 */
export const PROGRESSIVE_THRESHOLDS: readonly { at: number; tier: Tier }[] = [
  { at: 1, tier: "strict" },
  { at: 0.85, tier: "lean" },
  { at: 0.6, tier: "trim" },
];

/**
 * The grant still standing for `periodKey`, in bytes.
 *
 * A grant is filed under the window it was made for, so it expires by no longer
 * matching rather than by being cleaned up — nothing has to run at midnight for
 * "+25 MB today" to stop applying tomorrow. Which makes the window key the whole of
 * the mechanism, and a key that never changes a grant that never expires.
 */
export function grantFor(budget: Budget, periodKey: string): number {
  return budget.grantedFor === periodKey ? Math.max(0, budget.grantedBytes ?? 0) : 0;
}

export function allowanceOf(budget: Budget, periodKey: string): number {
  return Math.max(0, budget.bytes + grantFor(budget, periodKey));
}

/**
 * The tier a given amount of use implies.
 *
 * `used` is compared with the guard band added, so the tier engages before the
 * boundary rather than after it. The share the UI displays is the honest
 * `used / allowance`; this is the one that decides.
 */
export function tierFor(budget: Budget, used: number, allowance: number): Tier {
  if (allowance <= 0) return "off";
  const armed = (used + guardBytes(allowance)) / allowance;
  if (budget.shape === "hard") return armed >= 1 ? "strict" : "off";
  for (const threshold of PROGRESSIVE_THRESHOLDS) {
    if (armed >= threshold.at) return threshold.tier;
  }
  return "off";
}

/**
 * The period key a budget's current window is identified by.
 *
 * `sessionStartedAt` is when the browser session began — `ledger` keeps the session
 * total in `chrome.storage.session`, which Chrome clears when the browser closes, so
 * its start time is what "this session" means to both. It is a parameter because
 * this function has to stay pure and synchronous; the governor holds the value.
 *
 * The session key used to be the constant `"session"`, and a key that can never
 * change is a window that can never roll: `refreshWindows` never reset the counter,
 * and every grant found the previous one still filed under the same key and added to
 * it, so a session budget's allowance only ever grew — across browser restarts,
 * forever. Nothing could reach it while both `PUT_BUDGET` call sites hardcoded
 * `"day"`; exposing period selection is what arms it.
 */
export function periodKeyFor(
  period: BudgetPeriod,
  window: BudgetWindow,
  now: Date = new Date(),
  sessionStartedAt = 0,
): string {
  const today = dayKey(now);
  switch (period) {
    case "session":
      return `session:${sessionStartedAt}`;
    case "day":
      return today;
    case "week":
      return startOfWeek(today, window.weekStart);
    case "month":
      return dayKey(startOfCycle(window, now));
  }
}

/**
 * The inclusive day range a budget's current window covers.
 *
 * `null` for `session`, which does not line up with midnight and is read from the
 * session totals instead.
 */
export function periodDaysFor(
  period: BudgetPeriod,
  window: BudgetWindow,
  now: Date = new Date(),
): { from: string; to: string } | null {
  const today = dayKey(now);
  switch (period) {
    case "session":
      return null;
    case "day":
      return { from: today, to: today };
    case "week":
      return { from: startOfWeek(today, window.weekStart), to: today };
    case "month":
      return { from: dayKey(startOfCycle(window, now)), to: today };
  }
}

/** When the current window ends, for "resets in 4 hours". */
export function periodResetsAt(
  period: BudgetPeriod,
  window: BudgetWindow,
  now: Date = new Date(),
): number | null {
  const today = dayKey(now);
  switch (period) {
    case "session":
      return null;
    case "day":
      return startOfDayMs(addDays(today, 1));
    case "week":
      return startOfDayMs(addDays(startOfWeek(today, window.weekStart), 7));
    case "month":
      // The same function the plan headline and the projection call, so "resets in 9
      // days" means one date across the whole product rather than three.
      return cycleResetsAt(window, now);
  }
}

function startOfDayMs(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).getTime();
}

export function isSnoozed(budget: Budget, now = Date.now()): boolean {
  return typeof budget.snoozedUntil === "number" && budget.snoozedUntil > now;
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

/**
 * Budgets live in `chrome.storage.local`, and this file used to argue the opposite.
 *
 * The old argument was that a limit set on one machine should apply on the others,
 * because that is the whole point of a monthly data cap. It is a good argument and it
 * loses to a simpler fact: every budget carries a `site`, so a synced list is a list
 * of the domains someone cared enough about to cap — the most opinionated slice of a
 * person's browsing there is — handed to Chrome sync, while PRIVACY_POLICY.md says
 * that transfer "carries no browsing data".
 *
 * The trade, stated plainly so nobody reverses it by accident: cross-device limits are
 * gone. Set a cap on the laptop and the desktop does not know about it. What is bought
 * is that no site name leaves the profile. The loss is smaller than it reads, because
 * the usage a budget is checked against never synced either — a synced 5 GB cap was
 * always two independent 5 GB caps rather than one shared one.
 */
const BUDGETS_KEY = "budgets";

/**
 * Cap on how many budgets can exist.
 *
 * No longer a storage ceiling — `chrome.storage.local` has none worth speaking of at
 * this size — but a cost one. Every budgeted site is a ranged index read each time the
 * governor primes and a session rule each time it enforces, both per site, and both sit
 * on the path a request waits behind.
 */
export const MAX_BUDGETS = 30;

let migration: Promise<void> | null = null;

/**
 * Moves a list left behind by a build that synced budgets into local storage, once.
 *
 * The ordering is the whole of it. Local is authoritative the moment it holds a value,
 * *including an empty array*: `[]` is exactly what "I removed my last limit" looks
 * like, and treating it as "nothing stored here yet" would let Chrome push the old
 * synced copy back and resurrect every budget the user deleted. The sync key is dropped
 * whether or not anything was adopted, because leaving it would leave the site names
 * sitting in sync forever, which is the only reason this function exists.
 */
async function migrateFromSync(): Promise<void> {
  const stored = await chrome.storage.sync.get(BUDGETS_KEY);
  const inherited = stored[BUDGETS_KEY];
  if (inherited === undefined) return;
  const local = await chrome.storage.local.get(BUDGETS_KEY);
  if (local[BUDGETS_KEY] === undefined && Array.isArray(inherited)) {
    await chrome.storage.local.set({ [BUDGETS_KEY]: inherited });
  }
  await chrome.storage.sync.remove(BUDGETS_KEY);
}

/**
 * Memoized per worker, and it clears the memo on failure rather than caching it.
 *
 * A cached rejection would make every later `getBudgets` throw, and `getBudgets` is
 * what the governor primes from — one transient storage error at wake would leave the
 * browser with no limits at all until the worker died, which is the failure mode
 * `governor.ts` already has once and does not need twice. Retrying next wake costs one
 * `sync.get` that returns nothing.
 */
function ensureMigrated(): Promise<void> {
  if (!migration) {
    migration = migrateFromSync().catch((error: unknown) => {
      migration = null;
      console.error("Byte Budget: could not move budgets out of sync storage", error);
    });
  }
  return migration;
}

function normalize(value: unknown): Budget | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Budget>;
  if (typeof raw.site !== "string" || !raw.site) return null;
  const bytes = Number(raw.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const period = (BUDGET_PERIODS as readonly string[]).includes(String(raw.period))
    ? (raw.period as BudgetPeriod)
    : "day";
  const shape = (BUDGET_SHAPES as readonly string[]).includes(String(raw.shape))
    ? (raw.shape as BudgetShape)
    : "progressive";
  return {
    site: raw.site,
    bytes: Math.round(bytes),
    period,
    shape,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    ...(typeof raw.snoozedUntil === "number" ? { snoozedUntil: raw.snoozedUntil } : {}),
    ...(typeof raw.grantedBytes === "number" ? { grantedBytes: raw.grantedBytes } : {}),
    ...(typeof raw.grantedFor === "string" ? { grantedFor: raw.grantedFor } : {}),
    ...(typeof raw.kbps === "number" && raw.kbps > 0 ? { kbps: Math.round(raw.kbps) } : {}),
  };
}

export async function getBudgets(): Promise<Budget[]> {
  // Every read goes through the migration, not just the first one: this is the only
  // entry point the writers share, so gating here is what makes "adopt, then clear"
  // impossible to race with a `putBudget` that arrives during a cold start.
  await ensureMigrated();
  const stored = await chrome.storage.local.get(BUDGETS_KEY);
  const raw = stored[BUDGETS_KEY];
  if (!Array.isArray(raw)) return [];
  const bySite = new Map<string, Budget>();
  for (const entry of raw) {
    const budget = normalize(entry);
    // One budget per site. Two would mean two answers to "how much is left".
    if (budget && !bySite.has(budget.site)) bySite.set(budget.site, budget);
  }
  return [...bySite.values()].sort((a, b) => a.site.localeCompare(b.site));
}

async function writeBudgets(budgets: readonly Budget[]): Promise<Budget[]> {
  const ordered = [...budgets].sort((a, b) => a.site.localeCompare(b.site));
  await chrome.storage.local.set({ [BUDGETS_KEY]: ordered });
  return ordered;
}

export interface BudgetInput {
  site: string;
  bytes: number;
  period: BudgetPeriod;
  shape?: BudgetShape;
  kbps?: number;
}

export async function putBudget(input: BudgetInput): Promise<Budget[]> {
  // `ALL_SITES` is a budget; every other reserved key is a ledger bucket. No rule can
  // be built from one — `rules.ts` skips them, and `initiatorDomains: ["#background"]`
  // is a condition Chrome rejects, which fails the whole atomic install and takes
  // every other site's rules with it. Saving one would create a limit that can never
  // fire and a row that reads 0% forever.
  if (input.site.startsWith("#") && input.site !== ALL_SITES) {
    throw new Error("That is not a site a limit can be set on.");
  }
  const budgets = await getBudgets();
  const existing = budgets.find((budget) => budget.site === input.site);
  if (!existing && budgets.length >= MAX_BUDGETS) {
    throw new Error(`You can set up to ${MAX_BUDGETS} limits.`);
  }
  const next: Budget = {
    site: input.site,
    bytes: Math.round(input.bytes),
    period: input.period,
    shape: input.shape ?? existing?.shape ?? "progressive",
    createdAt: existing?.createdAt ?? Date.now(),
    ...(input.kbps && input.kbps > 0 ? { kbps: Math.round(input.kbps) } : {}),
  };
  return writeBudgets([...budgets.filter((budget) => budget.site !== input.site), next]);
}

export async function removeBudget(site: string): Promise<Budget[]> {
  const budgets = await getBudgets();
  return writeBudgets(budgets.filter((budget) => budget.site !== site));
}

async function patchBudget(site: string, patch: Partial<Budget>): Promise<Budget[]> {
  const budgets = await getBudgets();
  const existing = budgets.find((budget) => budget.site === site);
  if (!existing) throw new Error("There is no limit on that site.");
  return writeBudgets([
    ...budgets.filter((budget) => budget.site !== site),
    { ...existing, ...patch },
  ]);
}

export function snoozeBudget(site: string, minutes: number): Promise<Budget[]> {
  return patchBudget(site, { snoozedUntil: Date.now() + minutes * 60_000 });
}

export function resumeBudget(site: string): Promise<Budget[]> {
  return patchBudget(site, { snoozedUntil: 0 });
}

/**
 * Adds bytes to the current period only.
 *
 * A grant rather than a larger budget, because "I need a bit more today" and "my
 * limit was wrong" are different statements and only one of them should survive
 * until tomorrow.
 */
export function grantBytes(site: string, bytes: number, periodKey: string): Promise<Budget[]> {
  return getBudgets().then((budgets) => {
    const existing = budgets.find((budget) => budget.site === site);
    if (!existing) throw new Error("There is no limit on that site.");
    // Grants inside one window add up, because pressing "+25 MB" twice means 50 MB
    // today. `grantFor` is the whole of what stops that accumulation crossing into
    // the next window, so it is read here rather than the field being trusted.
    return patchBudget(site, {
      grantedBytes: grantFor(existing, periodKey) + Math.max(0, Math.round(bytes)),
      grantedFor: periodKey,
    });
  });
}

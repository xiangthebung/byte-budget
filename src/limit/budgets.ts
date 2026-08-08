/**
 * The budget model: what a limit is, and what tier a given amount of use implies.
 *
 * Pure and storage, no enforcement. `governor.ts` owns the live counters and
 * installs the rules; keeping the arithmetic here means the interesting decisions —
 * when to start shedding, how much to arm early, what a period even is — can be
 * asserted in a test rather than watched in a browser.
 */

import { addDays, dayKey, startOfMonth, startOfWeek } from "../core/period";
import type { Settings } from "../core/types";
import type { Tier } from "./tiers";

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

export function allowanceOf(budget: Budget, periodKey: string): number {
  const granted = budget.grantedFor === periodKey ? (budget.grantedBytes ?? 0) : 0;
  return Math.max(0, budget.bytes + granted);
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

/** The period key a budget's current window is identified by. */
export function periodKeyFor(
  period: BudgetPeriod,
  weekStart: Settings["weekStart"],
  now: Date = new Date(),
): string {
  const today = dayKey(now);
  switch (period) {
    case "session":
      return "session";
    case "day":
      return today;
    case "week":
      return startOfWeek(today, weekStart);
    case "month":
      return startOfMonth(today);
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
  weekStart: Settings["weekStart"],
  now: Date = new Date(),
): { from: string; to: string } | null {
  const today = dayKey(now);
  switch (period) {
    case "session":
      return null;
    case "day":
      return { from: today, to: today };
    case "week":
      return { from: startOfWeek(today, weekStart), to: today };
    case "month":
      return { from: startOfMonth(today), to: today };
  }
}

/** When the current window ends, for "resets in 4 hours". */
export function periodResetsAt(
  period: BudgetPeriod,
  weekStart: Settings["weekStart"],
  now: Date = new Date(),
): number | null {
  const today = dayKey(now);
  switch (period) {
    case "session":
      return null;
    case "day":
      return startOfDayMs(addDays(today, 1));
    case "week":
      return startOfDayMs(addDays(startOfWeek(today, weekStart), 7));
    case "month": {
      const [year, month] = today.split("-").map(Number);
      return new Date((year ?? 1970) + (month === 12 ? 1 : 0), month === 12 ? 0 : (month ?? 1), 1).getTime();
    }
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

const BUDGETS_KEY = "budgets";

/**
 * Cap on how many budgets can exist.
 *
 * `chrome.storage.sync` allows 8 kB per item and budgets share one item, so this is
 * a real ceiling rather than a nannying one. Sync rather than local because a limit
 * set on one machine should apply on the others — that is the whole point of a
 * monthly data cap.
 */
export const MAX_BUDGETS = 30;

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
  const stored = await chrome.storage.sync.get(BUDGETS_KEY);
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
  await chrome.storage.sync.set({ [BUDGETS_KEY]: ordered });
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
    const carried = existing.grantedFor === periodKey ? (existing.grantedBytes ?? 0) : 0;
    return patchBudget(site, {
      grantedBytes: carried + Math.max(0, Math.round(bytes)),
      grantedFor: periodKey,
    });
  });
}

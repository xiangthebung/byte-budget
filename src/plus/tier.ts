/**
 * What the free tier allows, and what Plus unlocks.
 *
 * Deliberately free of any dependency on ExtensionPay, so every surface can import it
 * to *ask* a question without any of them being able to *answer* one. The answer comes
 * from `plus/gate.ts`, which runs in the service worker and is the only thing that
 * talks to a payment provider. Splitting it this way is what keeps a locked control in
 * the settings page from dragging a network client into the settings bundle.
 *
 * Three rules shape everything below, and each is the answer to a way this could go
 * wrong for a person who has paid nothing, or who paid once and stopped.
 *
 * 1. **A ceiling limits what you can change, never what you already have.** Someone who
 *    subscribes, sets eight site limits and a custom Data Saver selection, then lets the
 *    subscription lapse, keeps all of it — running, enforcing, exactly as configured.
 *    What they lose is the ability to add a ninth or edit the selection. The alternative
 *    is a product that silently deletes a limit somebody was relying on because a card
 *    expired, which is the same failure class as `ARCHITECTURE.md`'s invariant 9: a
 *    setting must survive a switch it has nothing to do with.
 *
 * 2. **Nothing here may gate a disclosure.** The measured share, the measured-versus-
 *    modelled split on Data Saved, the projection's basis, the privacy statement and the
 *    scope admission are all free forever. A figure a person cannot audit is not a
 *    teaser for a better figure; it is a worse figure, and this project's entire
 *    argument is that it does not ship those.
 *
 * 3. **Nothing here may gate measurement.** Everything is recorded for everyone, at full
 *    resolution, whether or not anyone is paying. `FREE_REPORT_DAYS` bounds what a free
 *    surface will *draw*, not what the ledger keeps — see the comment on it, because the
 *    difference is the whole reason retention is not a paid setting.
 */

import type { Period } from "../core/types";
import type { BudgetPeriod } from "../limit/budgets";

/* ------------------------------------------------------------------ *
 * The status a surface reads
 * ------------------------------------------------------------------ */

/**
 * Why the current answer is the current answer.
 *
 * Carried alongside `plus` rather than collapsed into it, because the three ways of
 * being unpaid are not interchangeable on screen: someone who has never subscribed
 * gets an offer, someone mid-trial gets a countdown, and someone whose card just
 * failed gets a fix-it link rather than a sales pitch. `unknown` is the one that
 * matters most and is easiest to forget — see `PlusStatus.stale`.
 */
export type PlusReason =
  | "paid"
  | "trial"
  | "never"
  | "expired"
  | "past_due"
  /** No check has ever succeeded on this install. Treated as free, said as unknown. */
  | "unknown";

export interface PlusStatus {
  /** The only field a gate should branch on. */
  plus: boolean;
  reason: PlusReason;
  /** Present once a trial has been started, so a surface can count down. */
  trialEndsAt: number | null;
  /** Whether a trial is still available to start. */
  trialAvailable: boolean;
  /** `month` or `year` once subscribed, for the manage screen. */
  interval: "month" | "year" | "once" | null;
  /** When the answer below was last confirmed against the payment provider. */
  checkedAt: number;
  /**
   * Whether this answer is older than a successful check should be.
   *
   * The surfaces do not act on it — a stale `plus: true` still unlocks, which is the
   * fail-open rule — but the Plus settings section says so, because "we could not reach
   * the subscription service" is a different sentence from "you are subscribed", and a
   * person whose payment silently stopped working deserves the first one.
   */
  stale: boolean;
}

/** What an install with no successful check yet is treated as. */
export function unknownStatus(): PlusStatus {
  return {
    plus: false,
    reason: "unknown",
    trialEndsAt: null,
    trialAvailable: true,
    interval: null,
    checkedAt: 0,
    stale: true,
  };
}

/* ------------------------------------------------------------------ *
 * The ceilings
 * ------------------------------------------------------------------ */

/**
 * Site limits a free install may create, not counting the one over Everything.
 *
 * The `ALL_SITES` limit is deliberately outside the count. It is the one a data plan
 * creates for you, it is what every alert is checked against, and it is the whole of
 * "stop me before I blow my plan" — charging for it would be charging for the feature
 * the product is named after.
 *
 * Three rather than one because at a dollar a month there is nothing to be gained by
 * being stingy, and a person who has capped three sites has already learned what a
 * limit does. The fourth is where the ask lands, and by then it is an ask they can
 * answer from experience rather than from a screenshot.
 */
export const FREE_SITE_LIMITS = 3;

/**
 * The windows a free limit may run on.
 *
 * Daily only. A weekly or monthly cap is the same feature with a longer memory, and it
 * is the one that needs the rollover, the grant expiry and the calendar rules to be
 * right — which is to say it is the one worth paying for. A day is also the window a
 * person can reason about without any of that being explained to them, which is the
 * simplifier half of this doing its job.
 */
export const FREE_BUDGET_PERIODS: readonly BudgetPeriod[] = ["day"];

/**
 * How far back a free surface will report.
 *
 * Seven days, and this is a **drawing** ceiling rather than a retention one. The ledger
 * still keeps whatever `Settings.retentionDays` says — 400 days by default — for
 * everyone, paying or not.
 *
 * That distinction is load-bearing and was the whole reason retention itself is not the
 * paid setting. Retention is a *deletion* control: gating it would mean a lapsed
 * subscriber's history starts being destroyed, permanently, as a side effect of a
 * billing event. Gating the *view* costs nobody anything they cannot get back — the
 * data is still on disk, and the day someone subscribes it is all simply there, which
 * is a far better thing to unlock than an empty chart that starts filling from today.
 */
export const FREE_REPORT_DAYS = 7;

/**
 * The periods a free install may select.
 *
 * `month` is the one that goes, because it is the only one of the four that reaches
 * past `FREE_REPORT_DAYS`. `week` is exactly seven days on the rolling setting that
 * ships by default; on the calendar setting it is at most seven, so it can never
 * exceed the ceiling either.
 */
export const FREE_PERIODS: readonly Period[] = ["session", "today", "week"];

export function periodAllowed(period: Period, status: Pick<PlusStatus, "plus">): boolean {
  return status.plus || FREE_PERIODS.includes(period);
}

export function budgetPeriodAllowed(
  period: BudgetPeriod,
  status: Pick<PlusStatus, "plus">,
): boolean {
  return status.plus || FREE_BUDGET_PERIODS.includes(period);
}

/**
 * The reporting window a surface should ask for, in days.
 *
 * Applied to the dashboard's daily chart and to the export range. **Not** applied to
 * the plan cycle, and that exemption is the single most important line in this file.
 *
 * The popup's headline, the plan meter and the projection all read the cycle to date,
 * which on a plan resetting on the 3rd is up to 31 days. Clipping those to seven would
 * not make the free tier smaller; it would make it wrong — the headline would read
 * "2.1 of 15 GB" against a cycle that has actually spent 11 GB, and the projection
 * would forecast from a fifth of the evidence. A free tier that answers "will I make it
 * to the reset date" incorrectly is worse than one that does not answer it at all, and
 * this product exists to answer it. So: free tells you where you are now, at full
 * accuracy, and Plus is what lets you look back. `cycleDays` is never passed through
 * here.
 */
export function reportDays(days: number, status: Pick<PlusStatus, "plus">): number {
  return status.plus ? days : Math.min(days, FREE_REPORT_DAYS);
}

/* ------------------------------------------------------------------ *
 * The gated capabilities, named
 * ------------------------------------------------------------------ */

/**
 * Everything Plus unlocks, as one list.
 *
 * Named rather than left as seven scattered `if (plus)` checks, because the set is a
 * product decision that someone will want to read off in one place — and because each
 * lock on screen needs a stable key to label itself with, which is what
 * `settingsPlusLock<Capability>` in the catalogue is keyed on.
 */
export const PLUS_CAPABILITIES = [
  /** The eight individual Data Saver switches, the six image services, the holdout rate. */
  "saverAdvanced",
  /** Site limits past `FREE_SITE_LIMITS`, and windows other than a day. */
  "moreLimits",
  /** Units, and the calendar-versus-rolling week and month rules. */
  "appearanceAdvanced",
  /**
   * Reporting and exporting past `FREE_REPORT_DAYS`.
   *
   * Export used to be a capability of its own here and was folded into this one, because
   * once the free tier can export its seven days the two are the same lock with two
   * labels — and two names for one ceiling is how the copy on them drifts apart.
   */
  "history",
  /** The third-party host table in the site drill-down. */
  "hostBreakdown",
  /** The per-site with/without comparison under Data Saver results. */
  "savingsCompare",
] as const;

export type PlusCapability = (typeof PLUS_CAPABILITIES)[number];

/**
 * The three hosted pages a surface can ask the worker to open.
 *
 * Declared here rather than beside the code that opens them, so that `core/messages.ts`
 * can name it in the request union without importing `plus/gate.ts`. That import would
 * be erased at compile time and would still be a mistake to write: it puts the module
 * that bundles a payment client one careless `import type` → `import` away from every
 * surface, and the thing that keeps this extension's network surface at one request is
 * that only the worker can make it.
 */
export type PlusPage = "payment" | "trial" | "login";

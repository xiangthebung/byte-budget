/**
 * Assembling the savings report.
 *
 * Reads the ledger for the credited totals and the visits store for the page-load
 * comparison, and hands back both without merging them. The merge is what a reader
 * would want and what would make the figure indefensible: one of these numbers is
 * arithmetic on two observed sizes, and one is the estimator's opinion about requests
 * that never happened.
 */

import { bucketRange, getAll, STORES } from "../core/db";
import type { SavingsReport } from "../core/messages";
import { addDays, dayKey, dayKeysInRange } from "../core/period";
import { getSettings } from "../core/settings";
import type { UsageRow } from "../core/types";
import { getOptimizeSettings } from "./features";
import { baselineCount, visitDeltas } from "./savings";

/**
 * The report, with the modelled half named instead of left to be subtracted.
 *
 * `saved` is both halves added together and `savedMeasured` is the part resting on an
 * observed original size, so the modelled part was always derivable — and the shipped
 * dashboard did not derive it. It rendered `saved` alone, one figure merging a
 * subtraction of two real sizes with the estimator's opinion about requests that never
 * happened, which is the merge README.md:133-141 exists to forbid. A UI cannot render
 * one number by accident when both are handed to it under their own names.
 *
 * `savedModelled` is now a named field on `SavingsReport` itself, so every surface
 * reading `GET_SAVINGS` sees all three under their own names and none of them has to
 * remember a subtraction. A subtraction a caller has to remember is one a caller will
 * forget, and the failure is silent: a modelled number arriving wearing a measured
 * number's confidence.
 */
export async function savingsReport(days: number): Promise<SavingsReport> {
  const to = dayKey();
  const span = Math.max(1, days);
  // `addDays` from `core/period`, not a fourth local copy of "shift YYYY-MM-DD by N".
  // There were four; this one was a verbatim duplicate of the one in `track/stats.ts`,
  // and the tested implementation is the one in `core/period.ts`.
  const from = addDays(to, -(span - 1));

  const rows = await getAll<UsageRow>(STORES.daily, bucketRange(from, to));
  let saved = 0;
  let savedMeasured = 0;
  let blocked = 0;
  let rewritten = 0;
  const sites = new Set<string>();
  for (const row of rows) {
    saved += row.saved ?? 0;
    savedMeasured += row.savedMeasured ?? 0;
    blocked += row.blocked ?? 0;
    rewritten += row.rewritten ?? 0;
    if (row.site && !row.site.startsWith("#")) sites.add(row.site);
  }

  const deltas = await visitDeltas([...sites], span);
  // Only sites whose saving can be told apart from zero appear in `deltas` at all, so
  // this is a sum over differences that survived their own confidence interval — not
  // over every site that happened to have samples on both sides.
  const deltaTotal = deltas.reduce((total, delta) => total + delta.savedTotal, 0);

  return {
    from,
    to,
    saved,
    savedMeasured,
    // Clamped rather than trusted to be non-negative. `savedMeasured` is accumulated as
    // a share of `saved` row by row, so the two can only disagree through a defect
    // upstream — and the visible symptom of that would be a negative byte count in the
    // "Estimated" tile, which reads as a broken tool rather than as the bug it is.
    savedModelled: Math.max(0, saved - savedMeasured),
    blocked,
    rewritten,
    // Passed through unmapped, which is what carries `savedPerVisitSpread` to the view:
    // `VisitDelta` and `VisitDeltaView` are the same shape and the compiler checks it
    // here, so a field added to one and forgotten in the other fails the build rather
    // than silently arriving as `undefined` beside a "±" in the dashboard.
    deltas,
    deltaTotal,
    baselines: await baselineCount(),
    settings: await getSettings(),
    optimize: await getOptimizeSettings(),
  };
}

/** Exported for the dashboard's chart, which wants the same window. */
export function reportDays(from: string, to: string): string[] {
  return dayKeysInRange(from, to);
}

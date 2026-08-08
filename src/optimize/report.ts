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
    blocked,
    rewritten,
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

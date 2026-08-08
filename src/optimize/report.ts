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
import { dayKey, dayKeysInRange, startOfDay } from "../core/period";
import { getSettings } from "../core/settings";
import type { UsageRow } from "../core/types";
import { getOptimizeSettings } from "./features";
import { baselineCount, visitDeltas } from "./savings";

export async function savingsReport(days: number): Promise<SavingsReport> {
  const to = dayKey();
  const span = Math.max(1, days);
  const from = shiftDay(to, -(span - 1));

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

function shiftDay(day: string, offset: number): string {
  const date = startOfDay(day);
  date.setDate(date.getDate() + offset);
  return dayKey(date);
}

/** Exported for the dashboard's chart, which wants the same window. */
export function reportDays(from: string, to: string): string[] {
  return dayKeysInRange(from, to);
}

/**
 * Tests for the budget arithmetic in `src/limit/budgets.ts`.
 *
 * This module decides when someone's connection to a site starts being cut back, so
 * the two things worth pinning are that it engages *before* the boundary rather than
 * after it, and that the band it uses to do so never grows large enough to swallow
 * the budget it is protecting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  allowanceOf,
  BUDGET_PERIODS,
  BUDGET_PERIOD_LABELS,
  BUDGET_SHAPES,
  BUDGET_SHAPE_LABELS,
  guardBytes,
  isSnoozed,
  periodDaysFor,
  periodKeyFor,
  periodResetsAt,
  PROGRESSIVE_THRESHOLDS,
  tierFor,
} from "../src/limit/budgets.ts";

const budget = (bytes, extra = {}) => ({
  site: "example.com",
  bytes,
  period: "day",
  shape: "progressive",
  createdAt: 0,
  ...extra,
});

test("the guard band is a fraction of the allowance, never a slice of it", () => {
  // A 250 kB floor applied unconditionally would be 43% of a 600 kB budget.
  assert.equal(guardBytes(600_000), 60_000, "capped at a tenth");
  assert.equal(guardBytes(1_000_000), 100_000);
  assert.equal(guardBytes(50_000_000), 1_000_000, "2% once that clears the floor");
  assert.equal(guardBytes(1_000_000_000), 4_000_000, "capped in absolute terms too");
  assert.equal(guardBytes(0), 0);

  for (const allowance of [1000, 100_000, 600_000, 5_000_000, 2_000_000_000]) {
    const guard = guardBytes(allowance);
    assert.ok(guard <= allowance * 0.1 + 1, `guard is ${guard} of ${allowance}`);
    assert.ok(guard >= 0);
  }
});

test("enforcement arms before the boundary, not after it", () => {
  // 1 MB budget, so the band is 100 kB and strict engages at 900 kB used.
  const daily = budget(1_000_000);
  assert.equal(tierFor(daily, 0, 1_000_000), "off");
  assert.equal(tierFor(daily, 400_000, 1_000_000), "off");
  assert.equal(tierFor(daily, 500_000, 1_000_000), "trim", "60% with the band");
  assert.equal(tierFor(daily, 750_000, 1_000_000), "lean", "85% with the band");
  assert.equal(tierFor(daily, 900_000, 1_000_000), "strict", "100% with the band");
  assert.equal(tierFor(daily, 5_000_000, 1_000_000), "strict", "and stays there");
});

test("the tiers a progressive budget walks through are ordered", () => {
  const daily = budget(100_000_000);
  const seen = [];
  for (let used = 0; used <= 110_000_000; used += 1_000_000) {
    const tier = tierFor(daily, used, 100_000_000);
    if (seen[seen.length - 1] !== tier) seen.push(tier);
  }
  assert.deepEqual(seen, ["off", "trim", "lean", "strict"], `walked ${seen.join(" -> ")}`);
});

test("a hard budget does nothing until it runs out", () => {
  const hard = budget(10_000_000, { shape: "hard" });
  assert.equal(tierFor(hard, 0, 10_000_000), "off");
  assert.equal(tierFor(hard, 9_000_000, 10_000_000), "off", "90% is still off");
  // The band still applies, so it engages just before the boundary.
  assert.equal(tierFor(hard, 10_000_000 - guardBytes(10_000_000), 10_000_000), "strict");
});

test("a zero allowance enforces nothing rather than everything", () => {
  // Reachable through a corrupt synced value. Blocking a site because its budget
  // failed to parse would be the worst possible reading of "no allowance".
  assert.equal(tierFor(budget(1000), 500, 0), "off");
});

test("a grant applies to one window and then evaporates", () => {
  const granted = budget(50_000_000, { grantedBytes: 25_000_000, grantedFor: "2026-07-31" });
  assert.equal(allowanceOf(granted, "2026-07-31"), 75_000_000);
  assert.equal(allowanceOf(granted, "2026-08-01"), 50_000_000, "not the next day");
  assert.equal(allowanceOf(budget(50_000_000), "2026-07-31"), 50_000_000);

  // And the grant is what relaxes enforcement: the same usage that was over the
  // original allowance is comfortably inside the granted one.
  assert.equal(tierFor(granted, 49_500_000, 50_000_000), "strict");
  assert.equal(tierFor(granted, 49_500_000, 75_000_000), "trim");
  assert.equal(tierFor(granted, 40_000_000, 50_000_000), "trim");
  assert.equal(tierFor(granted, 40_000_000, 75_000_000), "off");
});

test("window keys identify the window, and change when it rolls", () => {
  const friday = new Date(2026, 6, 31, 14, 0);
  const saturday = new Date(2026, 7, 1, 0, 30);

  assert.equal(periodKeyFor("session", 1, friday), "session");
  assert.equal(periodKeyFor("day", 1, friday), "2026-07-31");
  assert.notEqual(periodKeyFor("day", 1, friday), periodKeyFor("day", 1, saturday));

  assert.equal(periodKeyFor("week", 1, friday), "2026-07-27", "Monday start");
  assert.equal(periodKeyFor("week", 0, friday), "2026-07-26", "Sunday start");
  assert.equal(periodKeyFor("week", 1, saturday), "2026-07-27", "same week, next day");
  assert.equal(periodKeyFor("month", 1, friday), "2026-07-01");
  assert.notEqual(periodKeyFor("month", 1, friday), periodKeyFor("month", 1, saturday));
});

test("the day range matches the window key", () => {
  const friday = new Date(2026, 6, 31, 14, 0);
  assert.equal(periodDaysFor("session", 1, friday), null, "read from session totals instead");
  assert.deepEqual(periodDaysFor("day", 1, friday), { from: "2026-07-31", to: "2026-07-31" });
  assert.deepEqual(periodDaysFor("week", 1, friday), { from: "2026-07-27", to: "2026-07-31" });
  assert.deepEqual(periodDaysFor("month", 1, friday), { from: "2026-07-01", to: "2026-07-31" });
});

test("a window resets in the future, never in the past", () => {
  const friday = new Date(2026, 6, 31, 14, 0);
  assert.equal(periodResetsAt("session", 1, friday), null);
  for (const period of ["day", "week", "month"]) {
    const at = periodResetsAt(period, 1, friday);
    assert.ok(at > friday.getTime(), `${period} resets at ${new Date(at).toISOString()}`);
  }
  // A December month must roll into January of the next year.
  const december = new Date(2026, 11, 20, 9, 0);
  const rollover = new Date(periodResetsAt("month", 1, december));
  assert.equal(rollover.getFullYear(), 2027);
  assert.equal(rollover.getMonth(), 0);
  assert.equal(rollover.getDate(), 1);
});

test("a snooze expires", () => {
  const now = 1_000_000;
  assert.equal(isSnoozed(budget(1000, { snoozedUntil: now + 60_000 }), now), true);
  assert.equal(isSnoozed(budget(1000, { snoozedUntil: now - 1 }), now), false);
  assert.equal(isSnoozed(budget(1000), now), false);
});

test("every period and shape has a label, and the thresholds descend", () => {
  for (const period of BUDGET_PERIODS) assert.ok(BUDGET_PERIOD_LABELS[period]);
  for (const shape of BUDGET_SHAPES) assert.ok(BUDGET_SHAPE_LABELS[shape]);
  // Evaluated in order and the first match wins, so they must be highest-first.
  for (let index = 1; index < PROGRESSIVE_THRESHOLDS.length; index++) {
    assert.ok(
      PROGRESSIVE_THRESHOLDS[index].at < PROGRESSIVE_THRESHOLDS[index - 1].at,
      "thresholds must descend or the wrong tier wins",
    );
  }
});

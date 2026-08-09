/**
 * Tests for the free/paid ceilings.
 *
 * A new file rather than an addition to an existing one, because the properties here
 * are not about measurement or optimization: they are about a tier boundary, and every
 * one of them fails *silently* if it breaks. A ceiling that is accidentally too low
 * takes something away from someone who paid for it; one that is accidentally too high
 * gives it away. Neither throws, and neither is visible in a screenshot.
 *
 * `plus/gate.ts` is deliberately not imported. It owns worker cache state and has no
 * pure logic worth asserting here; the provider boundary has its own focused test file.
 * What is tested below is `plus/tier.ts`, which is the half that
 * decides what a given answer *means* — and which every surface imports.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  FREE_BUDGET_PERIODS,
  FREE_PERIODS,
  FREE_REPORT_DAYS,
  FREE_SITE_LIMITS,
  budgetPeriodAllowed,
  periodAllowed,
  reportDays,
  unknownStatus,
} from "../src/plus/tier.ts";
import { PERIODS } from "../src/core/types.ts";
import { BUDGET_PERIODS } from "../src/limit/budgets.ts";

const free = { plus: false };
const paid = { plus: true };

/* ------------------------------------------------------------------ *
 * The unknown state
 * ------------------------------------------------------------------ */

test("an install with no successful check is free, not paid", () => {
  // The asymmetry the gate is built on: a check that cannot be made never *grants*
  // access, and separately never *removes* it. This is the granting half.
  const status = unknownStatus();
  assert.equal(status.plus, false);
  assert.equal(status.reason, "unknown");
  assert.equal(status.checkedAt, 0);
});

test("the unknown state reports itself as stale", () => {
  // So the Plus section can say "we have not been able to check" rather than
  // "you are not subscribed", which are different claims and only one is known.
  assert.equal(unknownStatus().stale, true);
});

/* ------------------------------------------------------------------ *
 * Reporting window
 * ------------------------------------------------------------------ */

test("a free install's reporting is clamped to the free window", () => {
  assert.equal(reportDays(400, free), FREE_REPORT_DAYS);
  assert.equal(reportDays(30, free), FREE_REPORT_DAYS);
});

test("a request already inside the window is not widened", () => {
  // `reportDays` clamps; it must never hand back more than was asked for. A popup
  // asking for 1 day getting 7 would be a chart showing a week under a heading
  // saying today.
  assert.equal(reportDays(1, free), 1);
  assert.equal(reportDays(FREE_REPORT_DAYS, free), FREE_REPORT_DAYS);
});

test("a subscriber's reporting passes through untouched", () => {
  assert.equal(reportDays(400, paid), 400);
  assert.equal(reportDays(1, paid), 1);
});

/* ------------------------------------------------------------------ *
 * Periods
 * ------------------------------------------------------------------ */

test("the free periods are a subset of the periods that exist", () => {
  // The drift guard. `FREE_PERIODS` is a second list naming values from `PERIODS`,
  // and the failure when they disagree is silent in the direction that matters: a
  // period renamed in `core/types.ts` and forgotten here would stop matching, so a
  // free install would silently lose a tab it is entitled to.
  for (const period of FREE_PERIODS) {
    assert.ok(PERIODS.includes(period), `${period} is not a real period`);
  }
});

test("a free install keeps every period except the month", () => {
  assert.equal(periodAllowed("session", free), true);
  assert.equal(periodAllowed("today", free), true);
  assert.equal(periodAllowed("week", free), true);
  assert.equal(periodAllowed("month", free), false);
});

test("a subscriber may choose any period", () => {
  for (const period of PERIODS) {
    assert.equal(periodAllowed(period, paid), true);
  }
});

test("the free window is wide enough for every period the free tier offers", () => {
  // The invariant that ties the two constants together, and the one nothing else
  // states. `week` is seven days on the rolling setting that ships by default, so a
  // `FREE_REPORT_DAYS` below 7 would leave a tab a free install can select and
  // cannot fill — a period control that draws a truncated week with nothing saying
  // why. Lowering the window means dropping `week` from `FREE_PERIODS` too.
  if (FREE_PERIODS.includes("week")) {
    assert.ok(
      FREE_REPORT_DAYS >= 7,
      `week is a free period but the free window is only ${FREE_REPORT_DAYS} days`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * Budget windows
 * ------------------------------------------------------------------ */

test("the free budget periods are a subset of the budget periods that exist", () => {
  for (const period of FREE_BUDGET_PERIODS) {
    assert.ok(BUDGET_PERIODS.includes(period), `${period} is not a real budget period`);
  }
});

test("a free install may set a daily limit and nothing longer", () => {
  assert.equal(budgetPeriodAllowed("day", free), true);
  assert.equal(budgetPeriodAllowed("week", free), false);
  assert.equal(budgetPeriodAllowed("month", free), false);
  assert.equal(budgetPeriodAllowed("session", free), false);
});

test("a subscriber may set a limit on any window", () => {
  for (const period of BUDGET_PERIODS) {
    assert.equal(budgetPeriodAllowed(period, paid), true);
  }
});

/* ------------------------------------------------------------------ *
 * The limit ceiling
 * ------------------------------------------------------------------ */

test("the free limit ceiling leaves room for more than one limit", () => {
  // Not a style preference. The popup's ceiling message tells someone to "remove one
  // to set another", which is only a real answer if they have a choice about which —
  // and a ceiling of 1 makes every site limit an upgrade prompt, which is not the
  // product this tier is meant to be.
  assert.ok(Number.isInteger(FREE_SITE_LIMITS));
  assert.ok(FREE_SITE_LIMITS >= 2, "a ceiling below 2 makes the free tier a demo");
});

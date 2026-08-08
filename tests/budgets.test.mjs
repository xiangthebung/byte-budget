/**
 * Tests for the budget arithmetic in `src/limit/budgets.ts`.
 *
 * This module decides when someone's connection to a site starts being cut back, so
 * the two things worth pinning are that it engages *before* the boundary rather than
 * after it, and that the band it uses to do so never grows large enough to swallow
 * the budget it is protecting.
 *
 * Two later properties join them, and both reach into `src/limit/rules.ts` because
 * that is where they become observable: a budget over `ALL_SITES` refuses requests
 * everywhere without a second mechanism, and a total and a per-site limit biting at
 * once compose rather than compete. And a window key has to be able to *change*, or
 * the grant filed under it never expires — which is what a session budget did.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  allowanceOf,
  BUDGET_PERIODS,
  BUDGET_PERIOD_LABELS,
  BUDGET_SHAPES,
  BUDGET_SHAPE_LABELS,
  grantFor,
  guardBytes,
  isSnoozed,
  periodDaysFor,
  periodKeyFor,
  periodResetsAt,
  PROGRESSIVE_THRESHOLDS,
  tierFor,
} from "../src/limit/budgets.ts";
import { enforcementRules } from "../src/limit/rules.ts";
import { blockedTypes } from "../src/limit/tiers.ts";
import { ALL_SITES } from "../src/core/types.ts";

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

/**
 * The window placement a budget is measured in.
 *
 * An object rather than the bare `weekStart` these functions used to take, because a
 * `month` budget is the plan's cycle and not the calendar month. `cycleStartDay: 0`
 * means "the calendar month", which is the default and what every pre-existing
 * assertion below was written against.
 */
const MONDAY = { weekStart: 1, cycleStartDay: 0 };
const SUNDAY = { weekStart: 0, cycleStartDay: 0 };
const ON_17TH = { weekStart: 1, cycleStartDay: 17 };

test("window keys identify the window, and change when it rolls", () => {
  const friday = new Date(2026, 6, 31, 14, 0);
  const saturday = new Date(2026, 7, 1, 0, 30);

  // A session window is identified by when the browser session began rather than by
  // the clock, so its key changes on a restart and at no other time.
  assert.equal(periodKeyFor("session", MONDAY, friday, 1_700_000_000_000), "session:1700000000000");
  assert.equal(
    periodKeyFor("session", MONDAY, saturday, 1_700_000_000_000),
    periodKeyFor("session", MONDAY, friday, 1_700_000_000_000),
    "midnight does not end a browser session",
  );
  assert.equal(periodKeyFor("day", MONDAY, friday), "2026-07-31");
  assert.notEqual(periodKeyFor("day", MONDAY, friday), periodKeyFor("day", MONDAY, saturday));

  assert.equal(periodKeyFor("week", MONDAY, friday), "2026-07-27", "Monday start");
  assert.equal(periodKeyFor("week", SUNDAY, friday), "2026-07-26", "Sunday start");
  assert.equal(periodKeyFor("week", MONDAY, saturday), "2026-07-27", "same week, next day");
  assert.equal(periodKeyFor("month", MONDAY, friday), "2026-07-01");
  assert.notEqual(periodKeyFor("month", MONDAY, friday), periodKeyFor("month", MONDAY, saturday));
});

test("a monthly window follows the plan cycle, not the calendar", () => {
  // The defect this pins: a monthly allowance used to anchor to the 1st while the
  // headline, the projection and "resets in N days" all counted from the reset day. So
  // someone whose plan resets on the 17th got a 100% alert against a window nothing
  // else in the product agreed with, and a figure that never matched the bill.
  const beforeReset = new Date(2026, 6, 16, 23, 0);
  const onReset = new Date(2026, 6, 17, 0, 0);
  const afterReset = new Date(2026, 6, 20, 9, 0);

  assert.equal(periodKeyFor("month", ON_17TH, beforeReset), "2026-06-17");
  assert.equal(periodKeyFor("month", ON_17TH, onReset), "2026-07-17");
  assert.equal(
    periodKeyFor("month", ON_17TH, afterReset),
    periodKeyFor("month", ON_17TH, onReset),
    "the window does not roll again until the next 17th",
  );

  assert.deepEqual(periodDaysFor("month", ON_17TH, afterReset), {
    from: "2026-07-17",
    to: "2026-07-20",
  });

  const resets = new Date(periodResetsAt("month", ON_17TH, afterReset));
  assert.equal(resets.getMonth(), 7, "August");
  assert.equal(resets.getDate(), 17);

  // A calendar cycle still behaves exactly as it always did, so nobody who never sets
  // a reset day sees a change.
  assert.equal(periodKeyFor("month", MONDAY, afterReset), "2026-07-01");
});

test("the day range matches the window key", () => {
  const friday = new Date(2026, 6, 31, 14, 0);
  assert.equal(periodDaysFor("session", MONDAY, friday), null, "read from session totals instead");
  assert.deepEqual(periodDaysFor("day", MONDAY, friday), { from: "2026-07-31", to: "2026-07-31" });
  assert.deepEqual(periodDaysFor("week", MONDAY, friday), { from: "2026-07-27", to: "2026-07-31" });
  assert.deepEqual(periodDaysFor("month", MONDAY, friday), { from: "2026-07-01", to: "2026-07-31" });
});

test("a window resets in the future, never in the past", () => {
  const friday = new Date(2026, 6, 31, 14, 0);
  assert.equal(periodResetsAt("session", MONDAY, friday), null);
  for (const period of ["day", "week", "month"]) {
    const at = periodResetsAt(period, MONDAY, friday);
    assert.ok(at > friday.getTime(), `${period} resets at ${new Date(at).toISOString()}`);
  }
  // A December month must roll into January of the next year.
  const december = new Date(2026, 11, 20, 9, 0);
  const rollover = new Date(periodResetsAt("month", MONDAY, december));
  assert.equal(rollover.getFullYear(), 2027);
  assert.equal(rollover.getMonth(), 0);
  assert.equal(rollover.getDate(), 1);

  // And so must an anchored one.
  const anchored = new Date(periodResetsAt("month", ON_17TH, december));
  assert.equal(anchored.getFullYear(), 2027);
  assert.equal(anchored.getMonth(), 0);
  assert.equal(anchored.getDate(), 17);
});

test("a snooze expires", () => {
  const now = 1_000_000;
  assert.equal(isSnoozed(budget(1000, { snoozedUntil: now + 60_000 }), now), true);
  assert.equal(isSnoozed(budget(1000, { snoozedUntil: now - 1 }), now), false);
  assert.equal(isSnoozed(budget(1000), now), false);
});

test("a session grant belongs to the session it was made in", () => {
  const friday = new Date(2026, 6, 31, 14, 0);
  const first = periodKeyFor("session", MONDAY, friday, 1_000);
  const second = periodKeyFor("session", MONDAY, friday, 2_000);
  assert.notEqual(first, second, "a new browser session has to be a new window");

  const session = budget(100_000_000, { period: "session" });
  // "+25 MB", twice, inside one session: the second grant reads the first and adds to
  // it, which is what makes two taps mean fifty megabytes rather than twenty-five.
  const once = {
    ...session,
    grantedBytes: grantFor(session, first) + 25_000_000,
    grantedFor: first,
  };
  const twice = { ...once, grantedBytes: grantFor(once, first) + 25_000_000, grantedFor: first };
  assert.equal(allowanceOf(twice, first), 150_000_000, "two grants in one session add up");

  // And the session after it starts from the budget again. While the key was the
  // constant "session" nothing here could ever stop matching, so the carried grant was
  // read back on every browser start and every later grant added to it — an allowance
  // that only grew, and a limit that quietly stopped being one.
  assert.equal(allowanceOf(twice, second), 100_000_000);
  assert.equal(grantFor(twice, second), 0, "the grant does not follow the restart");
});

test("a budget over everything walks the same ladder, scoped to nothing", () => {
  // 10 GB a month, so the guard band is at its 4 MB ceiling and the thresholds land
  // where the fractions say.
  const plan = budget(10_000_000_000, { site: ALL_SITES, period: "month" });
  assert.equal(tierFor(plan, 5_000_000_000, 10_000_000_000), "off");
  assert.equal(tierFor(plan, 6_000_000_000, 10_000_000_000), "trim");
  assert.equal(tierFor(plan, 8_500_000_000, 10_000_000_000), "lean");
  assert.equal(tierFor(plan, 10_000_000_000, 10_000_000_000), "strict");

  for (const tier of ["trim", "lean", "strict"]) {
    // Tabs are passed in and deliberately ignored: a rule scoped to the tabs the
    // extension happens to know about would be a total limit with holes in it.
    const rules = enforcementRules([{ site: ALL_SITES, tier, tabIds: [7, 9] }]);
    assert.equal(rules.length, 1, `${tier} should be one unscoped rule`);
    const [rule] = rules;
    assert.equal(rule.action.type, "block");
    assert.deepEqual(rule.condition.resourceTypes, blockedTypes(tier));
    assert.equal(rule.condition.initiatorDomains, undefined, "a total limit names no domain");
    assert.equal(rule.condition.tabIds, undefined, "and no tab");
  }

  assert.deepEqual(enforcementRules([{ site: ALL_SITES, tier: "off", tabIds: [] }]), []);
  // The sentinel is the one reserved key a rule can be built from. The buckets are not
  // domains, and `initiatorDomains: ["#background"]` is rejected by Chrome — which
  // fails the install atomically and takes every real site's rules down with it.
  assert.deepEqual(enforcementRules([{ site: "#background", tier: "strict", tabIds: [1] }]), []);
});

test("a total limit and a per-site limit compose instead of competing", () => {
  const rules = enforcementRules([
    { site: ALL_SITES, tier: "trim", tabIds: [] },
    { site: "example.com", tier: "strict", tabIds: [7] },
  ]);

  // Every rule is a block, and all of them sit at one priority. Chrome refuses a
  // request that any block rule matches, so two rule sets over the same traffic cannot
  // disagree: the effect is the union of the two type sets. And because each tier's
  // set is a prefix of the same shed order, that union is exactly the stricter tier —
  // there is nothing here that needs to arbitrate, which is the point.
  assert.ok(rules.every((rule) => rule.action.type === "block"));
  assert.equal(new Set(rules.map((rule) => rule.priority)).size, 1, "one priority");

  const ids = rules.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate rule id");

  const everywhere = rules.find((rule) => !rule.condition.initiatorDomains);
  const onSite = rules.filter((rule) => rule.condition.initiatorDomains?.[0] === "example.com");
  assert.equal(onSite.length, 2, "tab-scoped and origin-scoped, as for any other site");

  const union = new Set([
    ...everywhere.condition.resourceTypes,
    ...onSite[0].condition.resourceTypes,
  ]);
  assert.deepEqual([...union].sort(), [...blockedTypes("strict")].sort());

  // The other way round: a gentler per-site limit cannot loosen the total one, because
  // no rule here allows anything.
  const reversed = enforcementRules([
    { site: ALL_SITES, tier: "strict", tabIds: [] },
    { site: "example.com", tier: "trim", tabIds: [] },
  ]);
  const unscoped = reversed.find((rule) => !rule.condition.initiatorDomains);
  assert.deepEqual(unscoped.condition.resourceTypes, blockedTypes("strict"));
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

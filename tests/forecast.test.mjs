/**
 * Tests for `src/core/forecast.ts`.
 *
 * A projection is the only number this extension prints that is not derived from
 * something that happened, so the tests are mostly about the ways it is allowed to
 * refuse. The arithmetic is the easy half: what has to hold is that too little data
 * produces `null` or `confident: false` rather than a plausible-looking figure, that
 * one enormous day cannot set the pace, that the sentence explaining the number is
 * always there and always names the rate, and that the whole thing is a function of
 * its arguments and not of when it ran.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { forecast, MIN_RATE_DAYS, neededDaysFor } from "../src/core/forecast.ts";

const GB = 1_000_000_000;
const DAY_MS = 86_400_000;
/** 1 August 2026, local midnight. The cycle start every case below is anchored to. */
const CYCLE_START = new Date(2026, 7, 1).getTime();

/** `count` days of `bytes` each, then a partial today. */
function series(count, bytes, today = bytes) {
  return [...Array.from({ length: count }, () => bytes), today];
}

/** Whole days between the cycle start and a timestamp, immune to the local zone. */
function dayOffset(timestamp) {
  return (timestamp - CYCLE_START) / DAY_MS;
}

test("no plan means no projection", () => {
  assert.equal(forecast(series(9, GB), 10, 31, null, CYCLE_START), null);
  assert.equal(forecast(series(9, GB), 10, 31, 0, CYCLE_START), null);
  assert.equal(forecast(series(9, GB), 10, 31, -1, CYCLE_START), null);
});

test("a cycle with no finished day in it says so rather than projecting nothing", () => {
  // Day one. One number, a few hours old. The honest sentence is "too early, and here
  // is how many days that takes" — which used to be `null`, and a surface handed
  // `null` on the first day showed no card at all, indistinguishable from a feature
  // that does not exist. This replaced the test that pinned the `null`.
  const first = forecast([2 * GB], 1, 31, 15 * GB, CYCLE_START);
  assert.ok(first, "day one still answers");
  assert.equal(first.confident, false);
  assert.equal(first.recordedDays, 0);
  assert.equal(first.neededDays, neededDaysFor(31));
  assert.match(first.basis, /too early/i);
  assert.match(first.basis, /0 days/);
  assert.match(first.basis, /7 days are needed/);

  const empty = forecast([], 0, 31, 15 * GB, CYCLE_START);
  assert.ok(empty);
  assert.equal(empty.confident, false);
  assert.equal(empty.projected, 0);
  // A cycle with no length is not a window to project over.
  assert.equal(forecast(series(9, GB), 10, 0, 15 * GB, CYCLE_START), null);
});

test("the days needed are the larger of the sample floor and a fifth of the cycle", () => {
  assert.equal(neededDaysFor(7), MIN_RATE_DAYS);
  assert.equal(neededDaysFor(30), 6);
  assert.equal(neededDaysFor(31), 7);
  assert.equal(neededDaysFor(28), 6);
  // And `confident` flips exactly there, so the count a surface prints is the count
  // that matters rather than an approximation of it.
  const needed = neededDaysFor(30);
  assert.equal(forecast(series(needed - 1, GB), needed, 30, 15 * GB, CYCLE_START).confident, false);
  assert.equal(forecast(series(needed, GB), needed + 1, 30, 15 * GB, CYCLE_START).confident, true);
});

test("days before recording began are unknown, not zero", () => {
  // Installed on the twelfth day of a 31-day cycle. The eleven days before are read
  // by the ledger as zero — there are simply no rows — and used to be fed in as
  // eleven measured days of nothing: the rate was "established" after one page load
  // and a confident month was printed from it.
  const days = [...Array(11).fill(0), ...Array(9).fill(GB), GB];
  const projection = forecast(days, 21, 31, 15 * GB, CYCLE_START, 11);

  assert.equal(projection.unknownDays, 11);
  assert.equal(projection.recordedDays, 9, "the finished days since the install");
  assert.equal(projection.confident, true, "nine recorded days clear a 31-day cycle's floor");
  // 9 recorded days + today + 10 to come, at 1 GB. The unknown days add nothing:
  // they are not carried as zero into the total, and they are not modelled either.
  assert.equal(projection.projected, 9 * GB + GB + 10 * GB);
  assert.match(projection.basis, /first 11 days of this cycle passed before Byte Budget was counting/);
  assert.match(projection.basis, /9 days of this cycle are measured/);

  // Without the parameter the same series reads as twenty measured days at 0.55 GB,
  // which is the defect: the rate is wrong and the confidence is unearned.
  const naive = forecast(days, 21, 31, 15 * GB, CYCLE_START);
  assert.equal(naive.recordedDays, 20);
  assert.ok(naive.projected < projection.projected);
});

test("the unknown days keep the rate from being established too early", () => {
  // Three recorded days after an eleven-day gap: fourteen elapsed, three known.
  const days = [...Array(11).fill(0), GB, GB, GB, GB];
  const projection = forecast(days, 15, 31, 15 * GB, CYCLE_START, 11);
  assert.equal(projection.recordedDays, 3);
  assert.equal(projection.confident, false);
  assert.match(projection.basis, /3 days of this 31-day cycle have finished since Byte Budget started counting/);
});

test("the exhaustion date is placed on the recorded days, not the unknown ones", () => {
  // 5 GB a day from day 12 against a 12 GB plan: the crossing is four fifths of the
  // way through the third recorded day, which is day 14 of the cycle.
  const days = [...Array(11).fill(0), ...Array(5).fill(5 * GB), 5 * GB];
  const projection = forecast(days, 17, 30, 12 * GB, CYCLE_START, 11);
  assert.equal(dayOffset(projection.exhaustedOn), 11 + 2.4);
});

test("unknown days are clamped to the cycle so far", () => {
  // More unknown days than elapsed days cannot happen, but a bad `recordingSince`
  // could ask for it; the answer is "nothing recorded" rather than a negative slice.
  const projection = forecast(series(3, GB), 4, 30, 15 * GB, CYCLE_START, 40);
  assert.equal(projection.unknownDays, 4);
  assert.equal(projection.recordedDays, 0);
  assert.equal(projection.confident, false);
});

test("too few finished days is answered with confident: false, not a guess", () => {
  // Three finished days of a thirty-day cycle. Both floors fail: under five days the
  // tails are not pulled in at all, and three days of thirty is a tenfold reach.
  const early = forecast(series(3, GB), 4, 30, 15 * GB, CYCLE_START);
  assert.ok(early, "a figure is still returned so the caller can say why it is silent");
  assert.equal(early.confident, false);
  assert.match(early.basis, /too early/i);
  assert.match(early.basis, /3 days/);

  // Five finished days clears the sample floor but not a fifth of thirty days.
  assert.equal(forecast(series(5, GB), 6, 30, 15 * GB, CYCLE_START).confident, false);
  // Six clears both.
  assert.equal(forecast(series(6, GB), 7, 30, 15 * GB, CYCLE_START).confident, true);
  // A short cycle reaches confidence on the sample floor alone.
  assert.equal(forecast(series(5, GB), 6, 7, 3 * GB, CYCLE_START).confident, true);
});

test("the projection is the measured days plus a modelled rest", () => {
  // Nine finished days at 1 GB, today at 1 GB, 31 in the cycle: 9 measured + today +
  // 21 days still to come.
  const projection = forecast(series(9, GB), 10, 31, 15 * GB, CYCLE_START);
  assert.equal(projection.projected, 31 * GB);
  assert.equal(projection.planBytes, 15 * GB);
  assert.equal(projection.overBy, 16 * GB);
  assert.equal(projection.confident, true);
});

test("a projection is never below what has already been spent", () => {
  // Today has already cost eight times a typical day. The model must not average that
  // away and hand back a figure lower than the ledger.
  const projection = forecast([...Array(9).fill(GB), 8 * GB], 10, 31, 15 * GB, CYCLE_START);
  const spent = 9 * GB + 8 * GB;
  assert.ok(projection.projected >= spent, "projected below measured is not a projection");
  assert.equal(projection.projected, spent + 21 * GB);
});

test("one enormous day does not project the user into bankruptcy", () => {
  // Twelve ordinary days and one 8 GB evening. A naive total/elapsed rate is 1.54 GB a
  // day and puts the month at 47 GB; the pace people actually keep is 1 GB.
  const days = [GB, GB, GB, GB, GB, GB, 8 * GB, GB, GB, GB, GB, GB, GB, GB];
  const projection = forecast(days, 14, 31, 15 * GB, CYCLE_START);

  const finished = days.slice(0, -1);
  const naiveRate = finished.reduce((sum, value) => sum + value, 0) / finished.length;
  const naive = naiveRate * 31;
  assert.ok(projection.projected < naive * 0.85, `${projection.projected} vs naive ${naive}`);
  // The heavy evening is pulled in to its neighbour, not deleted: the rate is still a
  // mean over every day, so the figure stays above the median day.
  assert.ok(projection.projected >= 31 * GB);
});

test("the basis names the rate and the window it came from", () => {
  const projection = forecast(series(9, GB), 10, 31, 15 * GB, CYCLE_START);
  assert.match(projection.basis, /1\.0 GB/, "the assumed rate has to be in the sentence");
  assert.match(projection.basis, /9 days/, "and the window it was taken over");
  assert.match(projection.basis, /measured/);
  assert.match(projection.basis, /modelled/);

  for (const confident of [true, false]) {
    const sample = confident ? series(9, GB) : series(3, GB);
    const text = forecast(sample, sample.length, 31, 15 * GB, CYCLE_START).basis;
    assert.ok(text.length > 0);
    assert.doesNotMatch(text, /undefined|NaN|Infinity|\[object/);
  }
});

test("the rate is taken over recent days only", () => {
  // Twenty finished days: the first six at 5 GB, the last fourteen at 1 GB. Only the
  // recent fortnight should be paying for the days ahead.
  const days = [...Array(6).fill(5 * GB), ...Array(14).fill(GB), GB];
  const projection = forecast(days, 21, 31, 60 * GB, CYCLE_START);
  const measured = 6 * 5 * GB + 14 * GB;
  // 20 measured days + today at 1 GB + ten days at the recent rate of 1 GB.
  assert.equal(projection.projected, measured + GB + 10 * GB);
});

test("the exhaustion date is measured once the plan has already gone", () => {
  // 5 GB a day against a 12 GB plan: the crossing is four fifths of the way through
  // day three, and it is on file rather than being extrapolated to.
  const projection = forecast(series(7, 5 * GB), 8, 30, 12 * GB, CYCLE_START);
  assert.equal(dayOffset(projection.exhaustedOn), 2.4);
  assert.ok(projection.overBy > 0);
});

test("the exhaustion date is projected while the plan still holds", () => {
  // 1 GB a day, 10 GB spent of 15 GB, five days of allowance left after today.
  const projection = forecast(series(9, GB), 10, 31, 15 * GB, CYCLE_START);
  assert.equal(dayOffset(projection.exhaustedOn), 15);
});

test("a plan that is not expected to run out says so", () => {
  const projection = forecast(series(9, GB), 10, 31, 100 * GB, CYCLE_START);
  assert.equal(projection.exhaustedOn, null);
  assert.equal(projection.overBy, 0);
  assert.ok(projection.projected < 100 * GB);

  // Nothing being used at all is not a plan running out either.
  const idle = forecast(series(9, 0), 10, 31, 15 * GB, CYCLE_START);
  assert.equal(idle.exhaustedOn, null);
  assert.equal(idle.projected, 0);
});

test("the forecast reads no clock", () => {
  // The whole point of taking the cycle start as an argument. A forecast that reaches
  // for `Date.now()` cannot be tested without waiting, and its output stops being a
  // function of the ledger.
  const real = Date.now;
  Date.now = () => {
    throw new Error("forecast must not read the clock");
  };
  try {
    const projection = forecast(series(9, GB), 10, 31, 15 * GB, CYCLE_START);
    assert.equal(projection.projected, 31 * GB);
  } finally {
    Date.now = real;
  }
});

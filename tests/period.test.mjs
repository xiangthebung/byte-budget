/**
 * Tests for `src/core/period.ts`.
 *
 * Bucket keys are text, and the reason is that a lexicographic range over
 * `from|` … `to|\uffff` has to be the same set as a date comparison. If the key
 * format ever stops being fixed-width, every ranged read in the extension quietly
 * returns the wrong rows, so the format itself is pinned here.
 *
 * The day arithmetic is tested across a daylight-saving boundary because that is
 * where a naive "divide milliseconds by 86400000" is off by an hour and rounds a
 * seven-day week down to six.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  addDays,
  dayKey,
  dayKeysInRange,
  dayOfBucket,
  daysBetween,
  describePeriod,
  hourKey,
  hourKeysInDay,
  periodRange,
  retentionCutoff,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "../src/core/period.ts";

const SETTINGS = { weekMode: "rolling", monthMode: "calendar", weekStart: 1 };

test("keys are fixed width and sort chronologically as text", () => {
  const early = dayKey(new Date(2026, 0, 5));
  const late = dayKey(new Date(2026, 10, 30));
  assert.equal(early, "2026-01-05");
  assert.equal(late, "2026-11-30");
  assert.ok(early < late, "text order must match date order");

  assert.equal(hourKey(new Date(2026, 6, 31, 9, 45)), "2026-07-31T09");
  assert.equal(hourKey(new Date(2026, 6, 31, 0, 0)), "2026-07-31T00");
  assert.ok("2026-07-31T09" < "2026-07-31T10");
  assert.equal(dayOfBucket("2026-07-31T09"), "2026-07-31");
  assert.equal(dayOfBucket("2026-07-31"), "2026-07-31");
});

test("a key round-trips through local midnight", () => {
  const date = startOfDay("2026-07-31");
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 6);
  assert.equal(date.getDate(), 31);
  assert.equal(date.getHours(), 0);
  assert.equal(dayKey(date), "2026-07-31");
});

test("day arithmetic crosses month and year ends", () => {
  assert.equal(addDays("2026-07-31", 1), "2026-08-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29", "2024 is a leap year");
  assert.equal(daysBetween("2026-07-25", "2026-07-31"), 6);
  assert.equal(daysBetween("2026-07-31", "2026-07-25"), -6);
  assert.equal(daysBetween("2026-07-31", "2026-07-31"), 0);
});

test("day arithmetic survives a daylight-saving change", () => {
  // In most northern-hemisphere zones one of these ranges contains a 23-hour day
  // and the other a 25-hour one. Both must still be seven days.
  assert.equal(daysBetween("2026-03-05", "2026-03-12"), 7);
  assert.equal(daysBetween("2026-10-29", "2026-11-05"), 7);
  assert.equal(dayKeysInRange("2026-03-05", "2026-03-12").length, 8);
});

test("ranges are inclusive at both ends", () => {
  assert.deepEqual(dayKeysInRange("2026-07-30", "2026-08-01"), [
    "2026-07-30",
    "2026-07-31",
    "2026-08-01",
  ]);
  assert.deepEqual(dayKeysInRange("2026-07-30", "2026-07-30"), ["2026-07-30"]);
  assert.deepEqual(dayKeysInRange("2026-07-30", "2026-07-29"), []);
  assert.equal(hourKeysInDay("2026-07-31").length, 24);
  assert.equal(hourKeysInDay("2026-07-31")[0], "2026-07-31T00");
  assert.equal(hourKeysInDay("2026-07-31")[23], "2026-07-31T23");
});

test("calendar week starts on the configured day", () => {
  // 2026-07-31 is a Friday.
  assert.equal(startOfWeek("2026-07-31", 1), "2026-07-27", "Monday start");
  assert.equal(startOfWeek("2026-07-31", 0), "2026-07-26", "Sunday start");
  // A day that is already the first day of its week does not move.
  assert.equal(startOfWeek("2026-07-27", 1), "2026-07-27");
  assert.equal(startOfMonth("2026-07-31"), "2026-07-01");
});

test("each period covers what its name claims", () => {
  const now = new Date(2026, 6, 31, 14, 0);

  assert.equal(periodRange("session", SETTINGS, now), null, "session is not a day range");
  assert.deepEqual(periodRange("today", SETTINGS, now), { from: "2026-07-31", to: "2026-07-31" });

  assert.deepEqual(periodRange("week", { ...SETTINGS, weekMode: "rolling" }, now), {
    from: "2026-07-25",
    to: "2026-07-31",
  });
  assert.deepEqual(periodRange("week", { ...SETTINGS, weekMode: "calendar" }, now), {
    from: "2026-07-27",
    to: "2026-07-31",
  });

  assert.deepEqual(periodRange("month", { ...SETTINGS, monthMode: "calendar" }, now), {
    from: "2026-07-01",
    to: "2026-07-31",
  });
  assert.deepEqual(periodRange("month", { ...SETTINGS, monthMode: "rolling" }, now), {
    from: "2026-07-02",
    to: "2026-07-31",
  });

  // A rolling week is seven days including today, not eight.
  const rolling = periodRange("week", { ...SETTINGS, weekMode: "rolling" }, now);
  assert.equal(daysBetween(rolling.from, rolling.to) + 1, 7);
});

test("a period description says what it covers and never reads as undefined", () => {
  const now = new Date(2026, 6, 31, 14, 0);
  for (const period of ["session", "today", "week", "month"]) {
    const text = describePeriod(period, SETTINGS, now);
    assert.ok(text.length > 0);
    assert.doesNotMatch(text, /undefined|NaN|Invalid/);
  }
  assert.match(describePeriod("session", SETTINGS, now), /browser/i);
});

test("retention keeps exactly the number of days asked for", () => {
  const now = new Date(2026, 6, 31);
  assert.equal(retentionCutoff(1, now), "2026-07-31", "one day means today only");
  assert.equal(retentionCutoff(30, now), "2026-07-02");
  assert.equal(daysBetween(retentionCutoff(30, now), "2026-07-31") + 1, 30);
  assert.equal(retentionCutoff(0, now), null, "zero means keep everything");
});

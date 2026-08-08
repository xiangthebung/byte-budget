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
 *
 * The cycle tests at the bottom are held to a higher standard than the rest, because
 * they are the only numbers here a person checks against a paper bill. A period the
 * user is browsing can be a day out and cost nothing; a cycle that is a day out
 * reports last month's usage as this month's, which is the failure this product is
 * supposed to be the cure for.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  addDays,
  cycleElapsed,
  cycleRange,
  cycleResetsAt,
  dayKey,
  dayKeysInRange,
  dayOfBucket,
  daysBetween,
  formatPeriodDescription,
  periodDescription,
  hourKey,
  hourKeysInDay,
  periodRange,
  retentionCutoff,
  startOfCycle,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "../src/core/period.ts";

const SETTINGS = { weekMode: "rolling", monthMode: "calendar", weekStart: 1 };

/** A carrier cycle that resets on the 15th, and one that follows the calendar month. */
const MID_MONTH = { cycleStartDay: 15 };
const CALENDAR = { cycleStartDay: 0 };

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
  /*
   * Two functions now, not one. The worker computes the SHAPE and the surface turns it
   * into words, because a sentence composed in the worker has already fixed its word
   * order and no translation can move it afterwards.
   *
   * This asserts on the shape rather than on English. `formatPeriodDescription` calls
   * `t()`, and under `node --test` there is no `chrome.i18n`, so it returns catalogue
   * keys — asserting on the wording here would be asserting on key names. What must
   * hold is that every period yields a described window, and that nothing reaches the
   * formatter as undefined.
   */
  const now = new Date(2026, 6, 31, 14, 0);
  for (const period of ["session", "today", "week", "month"]) {
    const described = periodDescription(period, SETTINGS, now);
    assert.ok(described.kind, `${period} has no kind`);
    assert.equal(typeof described.days, "number");
    assert.ok(Number.isFinite(described.days), `${period} has a non-finite day count`);

    const text = formatPeriodDescription(described);
    assert.ok(text.length > 0);
    assert.doesNotMatch(text, /undefined|NaN|Invalid/);
  }

  // Session is the one with no day range at all: its totals come from
  // `chrome.storage.session`, not from a span of days, and `from`/`to` being null is
  // what tells the formatter to say so rather than printing an empty range.
  const session = periodDescription("session", SETTINGS, now);
  assert.equal(session.kind, "session");
  assert.equal(session.from, null);
  assert.equal(session.to, null);

  // And a dated period really does carry its span, since that is the whole reason the
  // structured form exists.
  const month = periodDescription("month", SETTINGS, now);
  assert.equal(month.kind, "calendarMonth");
  assert.equal(month.from, "2026-07-01");
  assert.equal(month.to, "2026-07-31");
});

test("retention keeps exactly the number of days asked for", () => {
  const now = new Date(2026, 6, 31);
  assert.equal(retentionCutoff(1, now), "2026-07-31", "one day means today only");
  assert.equal(retentionCutoff(30, now), "2026-07-02");
  assert.equal(daysBetween(retentionCutoff(30, now), "2026-07-31") + 1, 30);
  assert.equal(retentionCutoff(0, now), null, "zero means keep everything");
});

test("a cycle starts on its anchor day, this month or last", () => {
  // On and after the anchor, the running cycle is this month's.
  assert.equal(dayKey(startOfCycle(MID_MONTH, new Date(2026, 6, 20, 9, 0))), "2026-07-15");
  assert.equal(dayKey(startOfCycle(MID_MONTH, new Date(2026, 6, 15, 9, 0))), "2026-07-15");
  // Before it, the cycle the user is *in* began last month. This is the whole defect:
  // anchoring to the 1st puts these two days in different months than the bill does.
  assert.equal(dayKey(startOfCycle(MID_MONTH, new Date(2026, 6, 14, 23, 0))), "2026-06-15");
  assert.equal(dayKey(startOfCycle(MID_MONTH, new Date(2026, 6, 1, 0, 30))), "2026-06-15");

  const start = startOfCycle(MID_MONTH, new Date(2026, 6, 20, 9, 0));
  assert.equal(start.getHours(), 0, "a cycle begins at local midnight, not at 'now'");
  assert.equal(start.getMinutes(), 0);
  assert.equal(start.getSeconds() + start.getMilliseconds(), 0);
});

test("a cycle wraps from December into January", () => {
  const january = new Date(2026, 0, 10, 12, 0);
  assert.equal(dayKey(startOfCycle(MID_MONTH, january)), "2025-12-15", "and back a year");
  assert.equal(dayKey(new Date(cycleResetsAt(MID_MONTH, january))), "2026-01-15");
  assert.deepEqual(cycleRange(MID_MONTH, january), { from: "2025-12-15", to: "2026-01-10" });
  assert.deepEqual(cycleElapsed(MID_MONTH, january), { elapsedDays: 27, totalDays: 31 });

  const december = new Date(2025, 11, 20, 12, 0);
  assert.equal(dayKey(startOfCycle(MID_MONTH, december)), "2025-12-15");
  assert.equal(dayKey(new Date(cycleResetsAt(MID_MONTH, december))), "2026-01-15");
});

test("no cycle can be anchored to a day that some month lacks", () => {
  // 28 is the largest anchor allowed, and the largest one every month has.
  const february = new Date(2026, 1, 28, 12, 0);
  assert.equal(dayKey(startOfCycle({ cycleStartDay: 28 }, february)), "2026-02-28");
  assert.equal(cycleElapsed({ cycleStartDay: 28 }, february).totalDays, 28, "Feb 28 to Mar 28");
  assert.equal(cycleElapsed({ cycleStartDay: 28 }, new Date(2024, 1, 28, 12, 0)).totalDays, 29);

  // A stored 31 is clamped to the 28th rather than rolling into the next month, which
  // is what a bare `new Date(y, m, 31)` would do in February — silently, and one
  // month at a time.
  assert.equal(dayKey(startOfCycle({ cycleStartDay: 31 }, february)), "2026-02-28");
  assert.equal(dayKey(startOfCycle({ cycleStartDay: 31 }, new Date(2026, 1, 20))), "2026-01-28");

  // 0 means the calendar month, which is the same reset date as 1.
  const endOfJuly = new Date(2026, 6, 31, 14, 0);
  assert.equal(dayKey(startOfCycle(CALENDAR, endOfJuly)), "2026-07-01");
  assert.equal(dayKey(startOfCycle({ cycleStartDay: 1 }, endOfJuly)), "2026-07-01");

  // Anything else is junk that arrived over sync from a build we do not know. It must
  // fall back, not throw: this runs inside the popup's first paint.
  for (const anchor of [-3, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 99]) {
    const day = dayKey(startOfCycle({ cycleStartDay: anchor }, endOfJuly));
    assert.match(day, /^\d{4}-\d{2}-(01|28)$/, `anchor ${anchor} produced ${day}`);
  }
});

test("the calendar-month cycle is the month, however long the month is", () => {
  const endOfJuly = new Date(2026, 6, 31, 14, 0);
  assert.deepEqual(cycleRange(CALENDAR, endOfJuly), { from: "2026-07-01", to: "2026-07-31" });
  assert.deepEqual(cycleElapsed(CALENDAR, endOfJuly), { elapsedDays: 31, totalDays: 31 });
  assert.equal(dayKey(new Date(cycleResetsAt(CALENDAR, endOfJuly))), "2026-08-01");
  assert.equal(cycleElapsed(CALENDAR, new Date(2026, 1, 10, 12, 0)).totalDays, 28);
  assert.equal(cycleElapsed(CALENDAR, new Date(2024, 1, 10, 12, 0)).totalDays, 29, "leap year");
});

test("the reset day itself is day 1 of the new cycle, from its first millisecond", () => {
  const midnight = new Date(2026, 6, 15, 0, 0, 0, 0);
  const lastMoment = new Date(2026, 6, 14, 23, 59, 59, 999);

  // Pinned deliberately: a projection divides by `elapsedDays`, so day 0 would be a
  // division by zero on every reset morning.
  assert.deepEqual(cycleElapsed(MID_MONTH, midnight), { elapsedDays: 1, totalDays: 31 });
  assert.deepEqual(cycleRange(MID_MONTH, midnight), { from: "2026-07-15", to: "2026-07-15" });

  // One millisecond earlier is the last day of the previous cycle, entire.
  const ending = cycleElapsed(MID_MONTH, lastMoment);
  assert.deepEqual(ending, { elapsedDays: 30, totalDays: 30 }, "Jun 15 to Jul 15 is 30 days");
  assert.equal(dayKey(startOfCycle(MID_MONTH, lastMoment)), "2026-06-15");

  // The two agree on the instant they hand over: no gap, no day in both.
  assert.equal(cycleResetsAt(MID_MONTH, lastMoment), midnight.getTime());
  assert.equal(cycleResetsAt(MID_MONTH, lastMoment), startOfCycle(MID_MONTH, midnight).getTime());
  assert.ok(cycleResetsAt(MID_MONTH, midnight) > midnight.getTime(), "reset is always ahead");
});

test("a cycle spanning a daylight-saving change is still whole days", () => {
  // Both of these contain a 23- or 25-hour day in most northern zones. A cycle length
  // of 30.96 rounds to the wrong number of days remaining, which is the figure the
  // pace verdict is built on.
  const spring = new Date(2026, 2, 20, 12, 0);
  assert.deepEqual(cycleRange(MID_MONTH, spring), { from: "2026-03-15", to: "2026-03-20" });
  assert.deepEqual(cycleElapsed(MID_MONTH, spring), { elapsedDays: 6, totalDays: 31 });

  const autumn = new Date(2026, 10, 5, 12, 0);
  assert.deepEqual(cycleElapsed(MID_MONTH, autumn), { elapsedDays: 22, totalDays: 31 });
  assert.equal(dayKey(new Date(cycleResetsAt(MID_MONTH, autumn))), "2026-11-15");
});

test("every day belongs to exactly one cycle, and they run consecutively", () => {
  // Walked a day at a time over more than a year, because the interesting failures are
  // the ones at the seams: a day counted in two cycles or in none is a day of usage
  // that appears twice on the dashboard or vanishes from it.
  let previous = null;
  for (let offset = 0; offset < 400; offset++) {
    const day = new Date(2025, 10, 1 + offset, 12, 0);
    const from = dayKey(startOfCycle(MID_MONTH, day));
    const { elapsedDays, totalDays } = cycleElapsed(MID_MONTH, day);
    const range = cycleRange(MID_MONTH, day);

    assert.equal(range.from, from);
    assert.equal(range.to, dayKey(day));
    assert.equal(elapsedDays, daysBetween(range.from, range.to) + 1);
    assert.ok(elapsedDays >= 1, `${dayKey(day)} is day ${elapsedDays}`);
    assert.ok(elapsedDays <= totalDays, `${dayKey(day)} is day ${elapsedDays} of ${totalDays}`);
    assert.ok(totalDays >= 28 && totalDays <= 31, `${from} runs ${totalDays} days`);
    assert.ok(cycleResetsAt(MID_MONTH, day) > day.getTime());

    if (previous) {
      if (from === previous.from) {
        assert.equal(elapsedDays, previous.elapsedDays + 1, `${dayKey(day)} skipped a day`);
      } else {
        assert.equal(elapsedDays, 1, `${dayKey(day)} should open a cycle`);
        assert.equal(previous.elapsedDays, previous.totalDays, `${previous.from} ended short`);
        assert.equal(day.getDate(), 15, "cycles turn over on the anchor date and no other");
        assert.equal(previous.resetsAt, startOfCycle(MID_MONTH, day).getTime());
      }
    }
    previous = { from, elapsedDays, totalDays, resetsAt: cycleResetsAt(MID_MONTH, day) };
  }
});

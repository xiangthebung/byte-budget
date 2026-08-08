/**
 * Day and hour bucket keys, and the ranges the four periods cover.
 *
 * Everything is in the browser's local time, because a day of data usage means
 * the day the person had, not a UTC window that ends mid-afternoon. Keys are
 * `YYYY-MM-DD` and `YYYY-MM-DDTHH`, which sort lexicographically in the same
 * order they sort chronologically — that is the whole reason for the format, and
 * it is what lets an IndexedDB range query stand in for a date comparison.
 */

import { t } from "./i18n";
import { MAX_CYCLE_START_DAY, type Period, type Settings } from "./types";

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function dayKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Hour buckets are local wall-clock hours, and on the two daylight-saving days a
 * year that loses information. It is stated here rather than fixed, because every
 * fix costs more than the defect.
 *
 * On the fall-back day the repeated local hour yields one key for two real hours, so
 * that bar of the hourly chart holds up to twice the traffic of its neighbours. On
 * the spring-forward day the skipped local hour yields a key no request can carry,
 * so that bar reads zero. Nothing is lost and nothing is double counted: the bytes
 * land in the correct *day* either way, and only the `hourly` store is keyed this
 * finely — the daily rows every total, budget and projection is built from are
 * untouched. The damage is the shape of one chart, on one day, twice a year.
 *
 * The alternatives are worse. A UTC hour key stops agreeing with `dayKey`, so
 * `dayOfBucket` would no longer name the day the person had and every hourly read
 * would need a translation. Carrying the offset in the key breaks the fixed width
 * that makes a lexicographic IndexedDB range equal to a date comparison, which is
 * the one property this key format exists for.
 */
export function hourKey(date: Date = new Date()): string {
  return `${dayKey(date)}T${pad(date.getHours())}`;
}

export function dayKeyFromMs(ms: number): string {
  return dayKey(new Date(ms));
}

export function hourKeyFromMs(ms: number): string {
  return hourKey(new Date(ms));
}

/** The day a bucket key belongs to, for either resolution. */
export function dayOfBucket(bucket: string): string {
  return bucket.slice(0, 10);
}

/** Local midnight at the start of a `YYYY-MM-DD` key. */
export function startOfDay(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 0, 0, 0, 0);
}

export function addDays(key: string, days: number): string {
  const date = startOfDay(key);
  date.setDate(date.getDate() + days);
  return dayKey(date);
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  // Through UTC midnight of each local date, so a DST change inside the range
  // cannot make the difference 6.96 days and round to the wrong integer.
  const a = startOfDay(from);
  const b = startOfDay(to);
  const asUtc = (date: Date) =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((asUtc(b) - asUtc(a)) / 86_400_000);
}

/** Every day key from `from` to `to` inclusive. */
export function dayKeysInRange(from: string, to: string): string[] {
  const span = daysBetween(from, to);
  if (span < 0) return [];
  const keys: string[] = [];
  for (let offset = 0; offset <= span; offset++) keys.push(addDays(from, offset));
  return keys;
}

/** Every hour key in a day, `00` to `23` — including the two days a year that do
 * not have 24 of them, for the reasons set out on `hourKey`. */
export function hourKeysInDay(day: string): string[] {
  return Array.from({ length: 24 }, (_, hour) => `${day}T${pad(hour)}`);
}

/** The `YYYY-MM-DD` of the first day of the calendar week containing `key`. */
export function startOfWeek(key: string, weekStart: 0 | 1): string {
  const date = startOfDay(key);
  const shift = (date.getDay() - weekStart + 7) % 7;
  return addDays(key, -shift);
}

/** The `YYYY-MM-DD` of the first day of the calendar month containing `key`. */
export function startOfMonth(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

export interface DayRange {
  /** Inclusive `YYYY-MM-DD`. */
  from: string;
  /** Inclusive `YYYY-MM-DD`. */
  to: string;
}

/**
 * The day range a period covers, or `null` for `session`.
 *
 * `session` has no day range on purpose: it is "since this browser started",
 * which does not line up with midnight and is read from `chrome.storage.session`
 * rather than from the daily rows.
 */
export function periodRange(
  period: Period,
  settings: Pick<Settings, "weekMode" | "monthMode" | "weekStart">,
  now: Date = new Date(),
): DayRange | null {
  const today = dayKey(now);
  switch (period) {
    case "session":
      return null;
    case "today":
      return { from: today, to: today };
    case "week":
      return settings.weekMode === "calendar"
        ? { from: startOfWeek(today, settings.weekStart), to: today }
        : { from: addDays(today, -6), to: today };
    case "month":
      return settings.monthMode === "calendar"
        ? { from: startOfMonth(today), to: today }
        : { from: addDays(today, -29), to: today };
  }
}

/* ------------------------------------------------------------------ *
 * The billing cycle
 * ------------------------------------------------------------------ */

/**
 * The cycle functions below are the ones a person reconciles against a bill, which is
 * why they are separate from `periodRange` rather than another case inside it. A
 * period is a window the user chose to *look* at; a cycle is the window the carrier
 * is counting, and it is the only one where being a day out changes the answer to
 * "will I go over".
 */

/**
 * The day of the month a cycle is anchored to, as a real 1..28.
 *
 * `0` (calendar month) and `1` name the same reset date, so they collapse into one
 * anchor here rather than being special-cased by each function below. Anything else
 * out of range is clamped into it rather than thrown on: this value arrives from
 * `chrome.storage.sync`, where a newer build or a bad write can leave anything at
 * all, and a cycle that quietly starts on the 1st is a wrong date the user can see
 * and correct — where a throw takes down whichever surface asked, popup included.
 */
function cycleAnchor(settings: Pick<Settings, "cycleStartDay">): number {
  const day = Math.trunc(settings.cycleStartDay);
  if (!Number.isFinite(day) || day <= 0) return 1;
  return Math.min(day, MAX_CYCLE_START_DAY);
}

/** Local midnight on the day the running billing cycle began. */
export function startOfCycle(
  settings: Pick<Settings, "cycleStartDay">,
  now: Date = new Date(),
): Date {
  const anchor = cycleAnchor(settings);
  // Before the anchor day, the cycle that is running started *last* month. Month -1
  // is left to the Date constructor, which rolls it to December of the year before —
  // the December-to-January wrap is the case a hand-written branch gets wrong.
  const month = now.getMonth() - (now.getDate() >= anchor ? 0 : 1);
  return new Date(now.getFullYear(), month, anchor, 0, 0, 0, 0);
}

/** Local midnight on the day the running cycle ends and the next one begins. */
function startOfNextCycle(settings: Pick<Settings, "cycleStartDay">, now: Date): Date {
  const start = startOfCycle(settings, now);
  // Stepping a month from the cycle's own start, not from `now`: the anchor is never
  // above 28, so this cannot overflow into the following month the way `+1 month` on
  // a 31st does.
  return new Date(start.getFullYear(), start.getMonth() + 1, start.getDate(), 0, 0, 0, 0);
}

/**
 * The inclusive day range the running cycle covers *so far*.
 *
 * `to` is today rather than the reset date, matching `periodRange`: there are no rows
 * for days that have not happened, and a range that ran to the end of the cycle would
 * make every "days covered" figure count days the user has not lived through.
 */
export function cycleRange(
  settings: Pick<Settings, "cycleStartDay">,
  now: Date = new Date(),
): DayRange {
  return { from: dayKey(startOfCycle(settings, now)), to: dayKey(now) };
}

/** Epoch ms of the local midnight the running cycle rolls over at. */
export function cycleResetsAt(
  settings: Pick<Settings, "cycleStartDay">,
  now: Date = new Date(),
): number {
  return startOfNextCycle(settings, now).getTime();
}

/**
 * How far through the cycle we are, in whole days.
 *
 * The reset day itself is day 1, not day 0, and the tests pin it. A projection
 * divides usage by `elapsedDays` to get a daily rate, so a zero on the morning of
 * the reset is a division by zero dressed up as a forecast; and nobody reading a
 * bill calls the first day of their cycle day 0. `elapsedDays` is therefore always
 * 1..`totalDays`, and `totalDays` is 28..31 depending on the month the cycle
 * started in.
 */
export function cycleElapsed(
  settings: Pick<Settings, "cycleStartDay">,
  now: Date = new Date(),
): { elapsedDays: number; totalDays: number } {
  const from = dayKey(startOfCycle(settings, now));
  return {
    elapsedDays: daysBetween(from, dayKey(now)) + 1,
    totalDays: daysBetween(from, dayKey(startOfNextCycle(settings, now))),
  };
}

const MONTH_DAY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

const WEEKDAY_SHORT = new Intl.DateTimeFormat(undefined, { weekday: "short" });

export function formatDayShort(key: string): string {
  return MONTH_DAY.format(startOfDay(key));
}

export function formatWeekday(key: string): string {
  return WEEKDAY_SHORT.format(startOfDay(key));
}

/**
 * Which of the six sentences a period wants, without composing any of them.
 *
 * `period` alone does not decide this: `week` and `month` each read as a calendar
 * window or a trailing one depending on a setting, and the two need different
 * sentences. Naming the six cases here is what lets the worker say *which* window it
 * measured without saying it in English.
 */
export type PeriodKind =
  | "session"
  | "day"
  | "calendarWeek"
  | "rollingWeek"
  | "calendarMonth"
  | "rollingMonth";

export interface PeriodDescription {
  kind: PeriodKind;
  /** Inclusive `YYYY-MM-DD`. `null` only for `session`, which has no day range. */
  from: string | null;
  /** Inclusive `YYYY-MM-DD`. `null` only for `session`. */
  to: string | null;
  /** Whole days covered, inclusive of both ends. `0` for `session`. */
  days: number;
}

/**
 * What a period covers, as data rather than as a sentence.
 *
 * This is the form meant to cross the message boundary: the worker computes it, puts
 * it on the payload, and the surface renders it with `formatPeriodDescription`, which
 * is where the locale actually is. A composed sentence cannot survive that trip — a
 * translation of "This week · Jul 27 – Jul 31" may need the range first, the separator
 * elsewhere, or no separator at all, and none of that is reachable once the worker has
 * already joined the pieces.
 *
 * `track/stats.ts` still sends `describePeriod`'s English on `payload.description`; the
 * three surfaces move over to this one at a time, and that field goes when the last of
 * them has.
 */
export function periodDescription(
  period: Period,
  settings: Pick<Settings, "weekMode" | "monthMode" | "weekStart">,
  now: Date = new Date(),
): PeriodDescription {
  const range = periodRange(period, settings, now);
  if (!range) return { kind: "session", from: null, to: null, days: 0 };

  const kind: PeriodKind =
    period === "today"
      ? "day"
      : period === "week"
        ? settings.weekMode === "calendar"
          ? "calendarWeek"
          : "rollingWeek"
        : settings.monthMode === "calendar"
          ? "calendarMonth"
          : "rollingMonth";

  return {
    kind,
    from: range.from,
    to: range.to,
    days: daysBetween(range.from, range.to) + 1,
  };
}

/**
 * The sentence, built in the surface's locale from whole messages.
 *
 * Every case is one message with placeholders — never a prefix joined to a range —
 * because a translator cannot reorder two fragments that arrive already
 * concatenated. The date range is itself one message (`corePeriodSpan`) for the same
 * reason: the separator between two dates is not the same character everywhere, and
 * some languages want the dates the other way round.
 */
export function formatPeriodDescription(description: PeriodDescription): string {
  if (description.kind === "session" || description.from === null || description.to === null) {
    return t("corePeriodSession");
  }
  const span = t("corePeriodSpan", [
    formatDayShort(description.from),
    formatDayShort(description.to),
  ]);
  switch (description.kind) {
    case "day":
      return t("corePeriodToday", formatDayShort(description.to));
    case "calendarWeek":
      return t("corePeriodCalendarWeek", span);
    case "calendarMonth":
      return t("corePeriodCalendarMonth", span);
    case "rollingWeek":
    case "rollingMonth":
      return t("corePeriodRollingDays", [String(description.days), span]);
  }
}

/**
 * A sentence naming what a period actually covers, for the UI to show.
 *
 * @deprecated Composed in the worker, in English, and shipped as
 * `payload.description`. Use `periodDescription` on the producing side and
 * `formatPeriodDescription` on the rendering side; this exists only so the three
 * surfaces can migrate one at a time instead of all in the same commit.
 *
 * Deliberately still literal English rather than a set of catalogue lookups. It has no
 * localised behaviour to offer — the worker composes it before the surface's locale is
 * in the picture — so translating it would duplicate the six `corePeriod*` sentences in
 * `i18n/core.json` for a function that is being deleted. Delete this once nothing reads
 * `payload.description`.
 */
export function describePeriod(
  period: Period,
  settings: Pick<Settings, "weekMode" | "monthMode" | "weekStart">,
  now: Date = new Date(),
): string {
  const description = periodDescription(period, settings, now);
  if (description.from === null || description.to === null) return "Since this browser started";
  const span = `${formatDayShort(description.from)} – ${formatDayShort(description.to)}`;
  switch (description.kind) {
    case "session":
      return "Since this browser started";
    case "day":
      return formatDayShort(description.to);
    case "calendarWeek":
      return `This week · ${span}`;
    case "calendarMonth":
      return `This month · ${span}`;
    case "rollingWeek":
    case "rollingMonth":
      return `Last ${description.days} days · ${span}`;
  }
}

/** The oldest day key worth keeping, given a retention setting. `null` = keep all. */
export function retentionCutoff(retentionDays: number, now: Date = new Date()): string | null {
  if (!retentionDays || retentionDays <= 0) return null;
  return addDays(dayKey(now), -(retentionDays - 1));
}

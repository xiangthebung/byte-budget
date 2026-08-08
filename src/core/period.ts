/**
 * Day and hour bucket keys, and the ranges the four periods cover.
 *
 * Everything is in the browser's local time, because a day of data usage means
 * the day the person had, not a UTC window that ends mid-afternoon. Keys are
 * `YYYY-MM-DD` and `YYYY-MM-DDTHH`, which sort lexicographically in the same
 * order they sort chronologically — that is the whole reason for the format, and
 * it is what lets an IndexedDB range query stand in for a date comparison.
 */

import type { Period, Settings } from "./types";

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function dayKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

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

/** Every hour key in a day, `00` to `23`. */
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

/** A sentence naming what a period actually covers, for the UI to show. */
export function describePeriod(
  period: Period,
  settings: Pick<Settings, "weekMode" | "monthMode" | "weekStart">,
  now: Date = new Date(),
): string {
  const range = periodRange(period, settings, now);
  if (!range) return "Since this browser started";
  if (period === "today") return formatDayShort(range.to);
  const days = daysBetween(range.from, range.to) + 1;
  const span = `${formatDayShort(range.from)} – ${formatDayShort(range.to)}`;
  if (period === "week") {
    return settings.weekMode === "calendar" ? `This week · ${span}` : `Last ${days} days · ${span}`;
  }
  return settings.monthMode === "calendar" ? `This month · ${span}` : `Last ${days} days · ${span}`;
}

/** The oldest day key worth keeping, given a retention setting. `null` = keep all. */
export function retentionCutoff(retentionDays: number, now: Date = new Date()): string | null {
  if (!retentionDays || retentionDays <= 0) return null;
  return addDays(dayKey(now), -(retentionDays - 1));
}

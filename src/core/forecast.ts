/**
 * Whether the current rate meets the deadline.
 *
 * A cap is a deadline. The only useful thing to say about a deadline is whether what
 * is being spent now arrives under it, which no amount of per-day bars answers — a
 * chart shows what happened, and a plan is a question about what has not.
 *
 * Everything this module returns is MODELLED. It is arithmetic over days that have not
 * happened, which makes it the least defensible number in a product whose whole
 * discipline is keeping measured figures apart from inferred ones. Four consequences,
 * all deliberate:
 *
 * - `basis` is a required field, and it is a sentence rather than a code. A projection
 *   that reaches a screen without saying what rate it assumed and over what window is
 *   a confident-looking byte count with nothing behind it.
 * - `confident` is false rather than the function guessing harder. Three days into a
 *   thirty-day cycle, extrapolating is astrology with a unit attached. The surfaces
 *   print no figure while it is false; they print how many days are recorded and how
 *   many are needed, which is the sentence a person can check tomorrow.
 * - The days already recorded are carried through as themselves. Only the remainder is
 *   modelled, so the measured part of the answer is never overwritten by the model.
 * - A day the ledger did not exist for is unknown, not zero. Installed on the twelfth
 *   day of a cycle, this used to read eleven days of measured nothing, call the rate
 *   established after one page load, and print a confident month. Those days are now
 *   `unknownDays`: excluded from the rate, excluded from the total, and named in the
 *   basis so the figure is read as "since Byte Budget started counting".
 *
 * Pure: no chrome API, and no clock. The cycle's start arrives as a parameter so the
 * whole thing runs under `node --test` — a forecast that reads `Date.now()` internally
 * can only be tested by waiting.
 */

import { formatBytes } from "./format";

export interface Projection {
  /** Bytes expected by the end of the window: what is measured, plus a modelled rest. */
  projected: number;
  /** What it is being measured against. */
  planBytes: number;
  /** `projected - planBytes`, clamped at 0. */
  overBy: number;
  /** Epoch ms the plan is expected to run out, or `null` if it is not expected to. */
  exhaustedOn: number | null;
  /**
   * What the projection assumes, in words a reader can check against their own chart.
   *
   * Required, and required to be rendered with the number. `projected` alone is
   * indistinguishable on screen from a measurement, and this is the field that stops
   * it from being read as one.
   */
  basis: string;
  /** False when there are too few finished days for the rate to mean anything. */
  confident: boolean;
  /** Finished days the ledger recorded this cycle. What the rate rests on. */
  recordedDays: number;
  /** Finished, recorded days needed before `confident` can be true. */
  neededDays: number;
  /** Days of this cycle that passed before recording began. Never counted. */
  unknownDays: number;
}

const DAY_MS = 86_400_000;

/**
 * Finished days the rate is taken over, at most.
 *
 * Two weeks, so a weekend appears whatever day of the week the cycle started on, and
 * so the days ahead are not paced by behaviour a month old. A longer window is more
 * data and not more information about next Tuesday.
 */
const RATE_WINDOW_DAYS = 14;

/**
 * The two floors below which a projection is not offered as a number.
 *
 * Five finished days, because that is where the winsorising below starts working:
 * `floor(4 * 0.2)` is zero, so with four days or fewer a single 8 GB evening *is* the
 * rate rather than being bounded by it. Five is also the fewest that can contain both
 * working days and a weekend, which for most people is the largest structure in the
 * series.
 *
 * And a fifth of the cycle, which is about the extrapolation rather than the rate: at
 * five days of thirty the model multiplies whatever the rate has wrong by six, and a
 * number that leveraged should not be printed at all.
 *
 * Both have to hold. Below either, `confident` is false and the caller must say so
 * instead of showing the figure. `neededDays` on the result is the larger of the two,
 * so the caller can say how many days are still to come rather than only "not yet".
 */
export const MIN_RATE_DAYS = 5;
const MIN_CYCLE_SHARE = 0.2;

/**
 * Fraction of each tail pulled in before the rate is taken.
 *
 * Winsorised, not trimmed: the heaviest day is replaced by the next heaviest rather
 * than dropped, so it still counts — more than a median would let it — but it cannot
 * set the pace alone. Both alternatives fail in a direction that matters here.
 * Dropping the heavy days understates a plan that is genuinely being spent on one big
 * evening a week, and the person then blows through a cap the tool told them they
 * would clear; keeping them raw means one downloaded film projects someone into
 * bankruptcy and the warning gets ignored from then on. `optimize/savings.ts`
 * winsorises for the same reason on the same kind of distribution.
 */
const TAIL = 0.2;

/** Bytes a typical day costs, with the tails of the sample pulled in. */
function typicalDay(finished: readonly number[]): number {
  const sorted = [...finished].sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) return 0;
  const pull = Math.floor(count * TAIL);
  const lower = sorted[pull]!;
  const upper = sorted[count - 1 - pull]!;
  let sum = 0;
  for (const value of sorted) sum += value < lower ? lower : value > upper ? upper : value;
  return sum / count;
}

function dayCount(count: number): string {
  return `${count} day${count === 1 ? "" : "s"}`;
}

/** Finished, recorded days needed before a figure is printed for a cycle this long. */
export function neededDaysFor(totalDays: number): number {
  return Math.max(MIN_RATE_DAYS, Math.ceil(totalDays * MIN_CYCLE_SHARE));
}

/**
 * When the plan is expected to run out, or `null` if it is not expected to inside the
 * cycle.
 *
 * Two different kinds of answer, and the difference is the point. Past the plan
 * already, the crossing is found by walking the days that were actually recorded, so
 * the date is a measurement — the day someone ran out is not a thing to guess at when
 * it is on file. Still under it, the date is `rate` away and is as modelled as
 * everything else here.
 *
 * Day offsets are added as fixed 86.4-million-millisecond days rather than through the
 * calendar, so a daylight-saving change inside the cycle moves the answer by an hour.
 * That is several orders of magnitude inside the model's own error and the alternative
 * is threading day keys through a module whose whole input is a plain array.
 *
 * `recordedStart` is the first recorded day's midnight — the cycle start plus the
 * unknown days — because `finished[0]` is that day, not the cycle's first.
 */
function exhaustionMs(
  finished: readonly number[],
  today: number,
  rate: number,
  planBytes: number,
  elapsed: number,
  totalDays: number,
  cycleStart: number,
  recordedStart: number,
): number | null {
  let cumulative = 0;
  for (let index = 0; index < finished.length; index++) {
    const day = finished[index]!;
    if (cumulative + day >= planBytes) {
      // The store keeps a day's total and not the hour each byte arrived in, so the
      // crossing is placed proportionally through the day it happened on.
      const share = day > 0 ? (planBytes - cumulative) / day : 0;
      return recordedStart + (index + share) * DAY_MS;
    }
    cumulative += day;
  }

  if (cumulative + today >= planBytes) {
    const share = today > 0 ? (planBytes - cumulative) / today : 0;
    return recordedStart + (finished.length + share) * DAY_MS;
  }

  if (!(rate > 0)) return null;
  // Measured from the end of today: today's bytes are already spent and already
  // counted, so the days bought by the remaining allowance start after it.
  const offset = elapsed + (planBytes - cumulative - today) / rate;
  if (offset > totalDays) return null;
  return cycleStart + offset * DAY_MS;
}

/**
 * The projection for a plan cycle.
 *
 * `dailyBytes` is the cycle to date, one total per day, oldest first and aligned to
 * `cycleStart` — so the last entry is today and is partial. `elapsedDays` says how
 * many days of the cycle have begun and `totalDays` how many it holds. `unknownDays`
 * is how many of the leading entries predate recording; they are sliced off rather
 * than read as zero.
 *
 * `null` only when there is nothing to project against: no plan, or a cycle with no
 * length. A cycle with no finished day in it still answers, with `confident: false`
 * and `recordedDays: 0`, so a surface can say "too early — 0 days recorded, 6 needed"
 * on the first day rather than showing nothing and leaving the reader to wonder
 * whether the feature exists.
 */
export function forecast(
  dailyBytes: readonly number[],
  elapsedDays: number,
  totalDays: number,
  planBytes: number | null,
  cycleStart: number,
  unknownDays = 0,
): Projection | null {
  if (planBytes === null || !(planBytes > 0)) return null;
  if (!(totalDays > 0)) return null;

  const elapsed = Math.max(0, Math.min(Math.floor(elapsedDays), dailyBytes.length));
  const unknown = Math.max(0, Math.min(Math.floor(unknownDays), elapsed));
  const days = dailyBytes.slice(unknown, elapsed);
  // Today is excluded from the rate, not from the totals. Averaging in a day that is a
  // few hours old drags the rate down by however much of it is left, every day and
  // worst in the morning — a plan being overspent would read as comfortable at 9am and
  // only admit it at midnight.
  const finished = days.slice(0, -1);

  // Named `recent` rather than `window`: this module is loaded into the service worker,
  // where shadowing the DOM global is the kind of thing that reads as a mistake later.
  const recent = finished.slice(-RATE_WINDOW_DAYS);
  const rate = typicalDay(recent);
  const usedFinished = finished.reduce((sum, value) => sum + value, 0);
  const today = days[days.length - 1] ?? 0;
  const remaining = Math.max(0, totalDays - elapsed);

  // Today counts at what it has already cost or at a typical day, whichever is larger.
  // The partial figure alone would make the projection fall every midnight and climb
  // back through the day; the typical figure alone would ignore a today that has
  // already blown past it, which is exactly the day someone needs telling.
  const projected = usedFinished + Math.max(today, rate) + rate * remaining;

  const recordedDays = finished.length;
  const neededDays = neededDaysFor(totalDays);
  const confident = recordedDays >= neededDays;

  // Formatted on the SI scale regardless of the units setting: this figure is compared
  // against a carrier's plan, and a plan is sold in decimal gigabytes. A basis quoting
  // GiB against a "15 GB" plan is a sentence the reader cannot check.
  const perDay = formatBytes(rate);
  const unknownNote =
    unknown > 0
      ? ` The first ${dayCount(unknown)} of this cycle passed before Byte Budget was ` +
        `counting, so they are not included anywhere in this figure.`
      : "";
  const basis = confident
    ? `${dayCount(recordedDays)} of this cycle are measured and carried as themselves. ` +
      `The ${dayCount(remaining)} after today are modelled at about ${perDay} each — ` +
      `the typical day across the last ${dayCount(recent.length)}, with the heaviest and ` +
      `lightest pulled in so one unusual day cannot set the pace. Today counts at what it ` +
      `has used so far, or at that same figure, whichever is larger.${unknownNote}`
    : `Too early to project: only ${dayCount(recordedDays)} of this ${totalDays}-day ` +
      `cycle ${recordedDays === 1 ? "has" : "have"} finished since Byte Budget started ` +
      `counting, and ${dayCount(neededDays)} are needed before a daily rate means ` +
      `anything.${unknownNote}`;

  return {
    projected,
    planBytes,
    overBy: Math.max(0, projected - planBytes),
    exhaustedOn: exhaustionMs(
      finished,
      today,
      rate,
      planBytes,
      elapsed,
      totalDays,
      cycleStart,
      cycleStart + unknown * DAY_MS,
    ),
    basis,
    confident,
    recordedDays,
    neededDays,
    unknownDays: unknown,
  };
}

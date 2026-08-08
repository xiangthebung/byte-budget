/**
 * Display formatting for byte counts.
 *
 * Both unit systems are offered because both audiences are right: a network bill
 * is quoted in decimal gigabytes, and a file on disk is measured in binary ones.
 * Guessing which the reader meant is how a tracker ends up 7% out and blamed for
 * it, so the choice is a setting and the unit is always printed.
 *
 * Formatting and `parseByteSize` are one design, not two functions that happen to
 * live together: the app has to be able to read back what it printed. Change the
 * separator handling on either side alone and a person whose locale writes "1,5 GB"
 * either sees a figure this file cannot parse, or types one it reads as 15 GB.
 */

import type { Settings } from "./types";

const SI_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"] as const;
const IEC_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

export interface SplitBytes {
  /** Already rounded for display. */
  value: string;
  unit: string;
}

/** Reduces a byte count to the largest unit it fills. The sign is the caller's. */
function scale(bytes: number, units: Settings["units"]): { value: number; index: number } {
  const base = units === "iec" ? 1024 : 1000;
  const names = units === "iec" ? IEC_UNITS : SI_UNITS;
  const magnitude = Math.max(0, Math.abs(bytes));

  let index = 0;
  let value = magnitude;
  while (value >= base && index < names.length - 1) {
    value /= base;
    index += 1;
  }

  // Rounding can push a figure back over the base: 999,999,999 B is 999.999… MB,
  // which prints as "1000 MB" one byte before it would have printed "1.0 GB".
  // Anything this close to the base is displayed with no decimals (value >= 100),
  // so 0.5 is exactly where the rounding flips.
  if (value >= base - 0.5 && index < names.length - 1) {
    value /= base;
    index += 1;
  }

  return { value, index };
}

/**
 * Bytes are always whole; above that, one decimal until three digits, because
 * "1247 MB" is harder to read at a glance than "1.2 GB" and no less precise than
 * the estimate underneath it deserves.
 */
function decimalsFor(value: number, index: number): number {
  return index === 0 ? 0 : value < 100 ? 1 : 0;
}

/**
 * These figures sit beside counts from `formatCount`, which localises. `toFixed`
 * does not, so a de-DE reader got "1.2 GB" next to "1.234 sites" — the same
 * character meaning a decimal point in one and a thousands separator in the other.
 *
 * Grouping is off deliberately. The only figure here that can reach four digits is
 * 1000-1023 on the IEC scale, and a grouped "1.023 B" is a string `parseByteSize`
 * would have to read as either 1023 B or 1.023 B with nothing in it to say which.
 */
function formatDecimal(value: number, decimals: number): string {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  }).format(value);
}

/**
 * Splits a byte count into a rounded number and its unit, so a UI can set them
 * in different type without re-parsing a formatted string.
 */
export function splitBytes(bytes: number, units: Settings["units"] = "si"): SplitBytes {
  const names = units === "iec" ? IEC_UNITS : SI_UNITS;
  const { value, index } = scale(bytes, units);
  const rounded = formatDecimal(value, decimalsFor(value, index));
  return {
    value: bytes < 0 ? `-${rounded}` : rounded,
    unit: names[index] ?? "B",
  };
}

export function formatBytes(bytes: number, units: Settings["units"] = "si"): string {
  const split = splitBytes(bytes, units);
  return `${split.value} ${split.unit}`;
}

/**
 * At most four characters, for the toolbar badge. Chrome truncates anything
 * longer to something unreadable rather than shrinking it.
 *
 * The decimal is dropped by measuring the formatted text, not by re-parsing it:
 * this used to run `Number()` over `splitBytes().value`, which is NaN the moment
 * the locale's decimal separator is a comma — so a de-DE toolbar read "NaNM".
 */
export function formatBytesBadge(bytes: number, units: Settings["units"] = "si"): string {
  const base = units === "iec" ? 1024 : 1000;
  const names = units === "iec" ? IEC_UNITS : SI_UNITS;
  const sign = bytes < 0 ? "-" : "";
  let { value, index } = scale(bytes, units);

  // Four digits plus a unit letter is five characters. Only the IEC scale gets
  // there — a figure that rounds to 1000 or more without reaching 1024 — and only
  // above the bytes row, where a bare "1023" still fits. The threshold is the
  // rounding boundary, not 1000: 999.87 GiB prints "1000" and would read "1000G".
  if (value >= 999.5 && index > 0 && index < names.length - 1) {
    value /= base;
    index += 1;
  }

  const short = index === 0 ? "" : (names[index]?.[0]?.toUpperCase() ?? "");

  const preferred = `${sign}${formatDecimal(value, decimalsFor(value, index))}${short}`;
  if (preferred.length <= 4) return preferred;
  return `${sign}${formatDecimal(value, 0)}${short}`;
}

export function formatBytesPerSecond(
  bytesPerSecond: number,
  units: Settings["units"] = "si",
): string {
  return `${formatBytes(bytesPerSecond, units)}/s`;
}

/** `92%`, or `>99%` and `<1%` so a rounded number never reads as a certainty. */
export function formatPercent(share: number): string {
  if (!Number.isFinite(share)) return "–";
  const percent = share * 100;
  if (percent > 0 && percent < 1) return "<1%";
  if (percent < 100 && percent > 99) return ">99%";
  return `${Math.round(percent)}%`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value));
}

/** `4.2 MB of 50 MB`, used by budget rows in phase 2. */
export function formatOfBudget(
  used: number,
  budget: number,
  units: Settings["units"] = "si",
): string {
  return `${formatBytes(used, units)} of ${formatBytes(budget, units)}`;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** `3 minutes ago`, for "last updated" lines. */
export function formatAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((timestamp - now) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 45) return "just now";
  if (absolute < 3600) return RELATIVE.format(Math.round(seconds / 60), "minute");
  if (absolute < 86_400) return RELATIVE.format(Math.round(seconds / 3600), "hour");
  return RELATIVE.format(Math.round(seconds / 86_400), "day");
}

const DIGITS = /^\d+$/;
/** These two match a separator doing nothing but three-digit grouping. */
const COMMA_GROUPED = /^\d{1,3}(?:,\d{3})+$/;
const DOT_GROUPED = /^\d{1,3}(?:\.\d{3})+$/;
/** The only fraction length behind a comma that is a decimal rather than a group. */
const FRACTION = /^\d{1,2}$/;

/** `12.5`, `.5`, `7.` — rebuilt in the one form `Number` reads the same way anywhere. */
function toDecimal(whole: string, fraction: string): number | null {
  if (whole === "" && fraction === "") return null;
  if (whole !== "" && !DIGITS.test(whole)) return null;
  if (fraction !== "" && !DIGITS.test(fraction)) return null;
  return Number(`${whole === "" ? "0" : whole}.${fraction === "" ? "0" : fraction}`);
}

/**
 * Reads the number in front of the unit.
 *
 * A comma is a decimal point to most of the world and a thousands separator to the
 * rest, and the two readings of one string differ by a factor of a thousand. This
 * used to delete every comma before parsing, so a de-DE user's "1,5 GB" became a
 * 15 GB cap that then never fired — the failure the docstring below promises not to
 * make. The rules:
 *
 * - a lone comma with one or two digits behind it is a decimal point: `1,5`;
 * - a comma in strict three-digit groups is a thousands separator: `1,500`;
 * - a dot is a decimal point unless there is more than one, which only grouping can
 *   explain: `1.5`, `1.234.567`;
 * - with both present, the last one is the decimal point and the other has to be
 *   grouping: `1,234.5`, `1.234,5`;
 * - anything else is `null`.
 *
 * A lone separator with exactly three digits behind it (`1,234`, `1.234`) is legal
 * both ways somewhere, and the rules above settle each on the en-US reading of that
 * character. That tie-break cannot corrupt a round trip — `splitBytes` never groups
 * and never writes more than one decimal, so neither form is something this
 * extension printed — but it is still a guess about a typist, and the only one here.
 */
function parseAmount(text: string): number | null {
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");

  // Both separators present: the last one is the decimal point and the other has to
  // be grouping the integer part, or the string is a number in no locale at all.
  if (lastComma >= 0 && lastDot >= 0) {
    const cut = Math.max(lastComma, lastDot);
    const whole = text.slice(0, cut);
    const fraction = text.slice(cut + 1);
    const grouped = text[cut] === "," ? DOT_GROUPED : COMMA_GROUPED;
    if (!grouped.test(whole) || !DIGITS.test(fraction)) return null;
    return Number(`${whole.replace(/[.,]/g, "")}.${fraction}`);
  }

  if (lastComma >= 0) {
    if (COMMA_GROUPED.test(text)) return Number(text.replace(/,/g, ""));
    const parts = text.split(",");
    // Three digits behind the comma was grouping and matched above; four or more is
    // neither reading, which is the ambiguity the caller wants reported, not guessed.
    if (parts.length !== 2 || !FRACTION.test(parts[1] ?? "")) return null;
    return toDecimal(parts[0] ?? "", parts[1] ?? "");
  }

  if (lastDot >= 0) {
    const parts = text.split(".");
    // Two dots cannot both be decimal points, so it is grouping or it is malformed.
    if (parts.length > 2) return DOT_GROUPED.test(text) ? Number(text.replace(/\./g, "")) : null;
    return toDecimal(parts[0] ?? "", parts[1] ?? "");
  }

  return DIGITS.test(text) ? Number(text) : null;
}

/**
 * Parses a byte size a person typed: `500`, `50MB`, `1.5 gb`, `1,5 gb`, `250 MiB`.
 * Returns `null` when it cannot tell, rather than guessing at a limit that will
 * later be enforced by cutting off someone's connection.
 */
export function parseByteSize(input: string): number | null {
  const match = /^\s*([\d.,]+)\s*([a-z]*)\s*$/i.exec(input);
  if (!match) return null;
  const amount = parseAmount(String(match[1]));
  if (amount === null || !Number.isFinite(amount) || amount < 0) return null;

  const unit = String(match[2] ?? "").toLowerCase();
  // Every unit `splitBytes` can print needs an entry here, or the app cannot read
  // its own output back — which is how a round trip through the limit field would
  // silently drop a cap the user believed they had re-saved.
  const factors: Record<string, number> = {
    "": 1_000_000, // A bare number in a limit field means megabytes.
    b: 1,
    kb: 1000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
    pb: 1_000_000_000_000_000,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    pib: 1024 ** 5,
    k: 1000,
    m: 1_000_000,
    g: 1_000_000_000,
    t: 1_000_000_000_000,
    p: 1_000_000_000_000_000,
  };
  const factor = factors[unit];
  if (factor === undefined) return null;
  return Math.round(amount * factor);
}

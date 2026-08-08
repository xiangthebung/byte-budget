/**
 * Display formatting for byte counts.
 *
 * Both unit systems are offered because both audiences are right: a network bill
 * is quoted in decimal gigabytes, and a file on disk is measured in binary ones.
 * Guessing which the reader meant is how a tracker ends up 7% out and blamed for
 * it, so the choice is a setting and the unit is always printed.
 */

import type { Settings } from "./types";

const SI_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"] as const;
const IEC_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

export interface SplitBytes {
  /** Already rounded for display. */
  value: string;
  unit: string;
}

/**
 * Splits a byte count into a rounded number and its unit, so a UI can set them
 * in different type without re-parsing a formatted string.
 */
export function splitBytes(bytes: number, units: Settings["units"] = "si"): SplitBytes {
  const base = units === "iec" ? 1024 : 1000;
  const names = units === "iec" ? IEC_UNITS : SI_UNITS;
  const magnitude = Math.max(0, Math.abs(bytes));

  let index = 0;
  let value = magnitude;
  while (value >= base && index < names.length - 1) {
    value /= base;
    index += 1;
  }

  // Bytes are always whole; above that, one decimal until three digits, because
  // "1,247 MB" is harder to read at a glance than "1.2 GB" and no less precise
  // than the estimate underneath it deserves.
  const decimals = index === 0 ? 0 : value < 100 ? 1 : 0;
  const rounded = value.toFixed(decimals);
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
 */
export function formatBytesBadge(bytes: number, units: Settings["units"] = "si"): string {
  const { value, unit } = splitBytes(bytes, units);
  if (unit === "B") return value;
  const short = unit[0]?.toUpperCase() ?? "";
  const trimmed = value.length + 1 > 4 ? Math.round(Number(value)).toString() : value;
  return `${trimmed}${short}`;
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

/**
 * Parses a byte size a person typed: `500`, `50MB`, `1.5 gb`, `250 MiB`.
 * Returns `null` when it cannot tell, rather than guessing at a limit that will
 * later be enforced by cutting off someone's connection.
 */
export function parseByteSize(input: string): number | null {
  const match = /^\s*([\d.,]+)\s*([a-z]*)\s*$/i.exec(input);
  if (!match) return null;
  const amount = Number(String(match[1]).replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount < 0) return null;

  const unit = String(match[2] ?? "").toLowerCase();
  const factors: Record<string, number> = {
    "": 1_000_000, // A bare number in a limit field means megabytes.
    b: 1,
    kb: 1000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    k: 1000,
    m: 1_000_000,
    g: 1_000_000_000,
    t: 1_000_000_000_000,
  };
  const factor = factors[unit];
  if (factor === undefined) return null;
  return Math.round(amount * factor);
}

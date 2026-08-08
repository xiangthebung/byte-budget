/**
 * Read queries. Everything the popup and the dashboard display comes from here.
 *
 * All of it is derived on read rather than maintained on write. A month is about
 * three thousand daily rows, which is a single ranged `getAll` and a loop — far
 * cheaper than keeping four rollups correct through every period boundary, every
 * retention prune, and a timezone that changes twice a year.
 */

import {
  bucketRange,
  countRows,
  getAll,
  getAllFromIndex,
  STORES,
} from "../core/db";
import {
  addDays,
  dayKey,
  dayKeysInRange,
  describePeriod,
  hourKeyFromMs,
  hourKeysInDay,
  periodRange,
  startOfDay,
  type DayRange,
} from "../core/period";
import { isThirdParty, originFromUrl, siteKeyFromUrl } from "../core/sites";
import {
  addTotals,
  addTypeBytes,
  emptyTotals,
  type HostRow,
  type Period,
  type Settings,
  type TypeBytes,
  type UsageRow,
  type UsageTotals,
  type Visit,
} from "../core/types";
import type {
  HostUsage,
  OverviewPayload,
  SeriesPoint,
  SiteDetailPayload,
  SiteUsage,
  StorageReport,
  VisitStats,
} from "../core/messages";
import { ledger, type Delta, type FlushError } from "./ledger";

function emptyDelta(): Delta {
  return { ...emptyTotals(), byType: {} };
}

function totalOf(totals: Readonly<UsageTotals>): number {
  return totals.down + totals.up;
}

/**
 * The day range to read for a period.
 *
 * `session` has no day range of its own — its totals come from
 * `chrome.storage.session` — but its *charts* still need days, and a session that
 * started before midnight spans two of them. So it reads from the day the browser
 * started to today.
 */
async function resolveRange(period: Period, settings: Settings): Promise<DayRange> {
  const range = periodRange(period, settings);
  if (range) return range;
  const session = await ledger.sessionUsage();
  return { from: dayKey(new Date(session.startedAt)), to: dayKey() };
}

function accumulate(rows: readonly UsageRow[]): {
  totals: UsageTotals;
  byType: TypeBytes;
  bySite: Map<string, Delta>;
} {
  const totals = emptyTotals();
  const byType: TypeBytes = {};
  const bySite = new Map<string, Delta>();

  for (const row of rows) {
    addTotals(totals, row);
    addTypeBytes(byType, row.byType ?? {});
    let site = bySite.get(row.site);
    if (!site) {
      site = emptyDelta();
      bySite.set(row.site, site);
    }
    addTotals(site, row);
    addTypeBytes(site.byType, row.byType ?? {});
  }

  return { totals, byType, bySite };
}

function sitesFrom(bySite: Map<string, Delta>): SiteUsage[] {
  return [...bySite.entries()]
    .map(([site, delta]) => ({
      site,
      totals: { ...(delta as UsageTotals) },
      byType: { ...delta.byType },
    }))
    .sort((a, b) => totalOf(b.totals) - totalOf(a.totals));
}

/**
 * Hours the "Over time" chart shows at most.
 *
 * Two places have to agree on this: the bucket list is clamped to the days these can
 * come from, and `trimLeadingEmpty` keeps this many. Raising one alone either draws
 * bars with no data behind them or goes back to expanding the whole session range.
 */
const HOUR_BUCKETS_SHOWN = 24;

/** Calendar days `HOUR_BUCKETS_SHOWN` hours can span when they end at 23:00. */
const HOUR_BUCKET_DAYS = Math.ceil(HOUR_BUCKETS_SHOWN / 24) + 1;

/**
 * Hour buckets across a range, starting no earlier than `from` if given and never
 * running past the hour it is now.
 *
 * The session period is the awkward one: its totals come from
 * `chrome.storage.session`, which Chrome empties when the browser closes, while its
 * chart comes from the stored hourly rows, which do not care about browser
 * sessions. Unclamped, a browser restarted at three in the afternoon drew a chart of
 * the whole day underneath a headline figure covering the last few hours, and the
 * bars visibly added up to more than the number above them.
 *
 * Clamping is to the hour, so the hour the session began in may still carry a little
 * traffic from before it. That is a bar being slightly tall, not a chart disagreeing
 * with its own heading.
 */
function hourBuckets(range: DayRange, from: number | null): string[] {
  // The day range is clamped before it is expanded, not after. `session` runs from the
  // day the browser started, which on a machine that is never shut down is months ago:
  // every one of those days became twenty-four keys, on every poll, so that all but
  // the last day of them could be thrown away again.
  const earliest = shiftDay(range.to, -(HOUR_BUCKET_DAYS - 1));
  const days = dayKeysInRange(range.from > earliest ? range.from : earliest, range.to);
  const first = from === null ? null : hourKeyFromMs(from);
  // Nothing past the current hour. The bucket list is what the chart draws ticks for,
  // so an unfiltered "today" put bars for 22:00 and 23:00 on the panel at nine in the
  // evening — hours that have not happened, drawn as if they had cost nothing.
  const now = hourKeyFromMs(Date.now());
  return days
    .flatMap((day) => hourKeysInDay(day))
    .filter((bucket) => bucket <= now && (first === null || bucket >= first));
}

/** One point per bucket, with empty buckets filled in so a chart has no gaps. */
function seriesFrom(rows: readonly UsageRow[], buckets: readonly string[]): SeriesPoint[] {
  const byBucket = new Map<string, SeriesPoint>();
  for (const bucket of buckets) byBucket.set(bucket, { bucket, down: 0, up: 0, saved: 0 });
  for (const row of rows) {
    const point = byBucket.get(row.bucket);
    if (!point) continue;
    point.down += row.down;
    point.up += row.up;
    point.saved += row.saved;
  }
  return [...byBucket.values()];
}

async function currentTab(): Promise<{ site: string | null; origin: string | null }> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url) return { site: null, origin: null };
    return { site: siteKeyFromUrl(tab.url), origin: originFromUrl(tab.url) };
  } catch {
    return { site: null, origin: null };
  }
}

export async function overview(period: Period, settings: Settings): Promise<OverviewPayload> {
  const session = await ledger.sessionUsage();
  const range = await resolveRange(period, settings);

  // One read of the daily store, shared by the totals and the series. They asked for
  // the identical range and issued it twice, and `overview` is what the popup's
  // two-second poll calls — thirty duplicate full-range reads a minute while it is open.
  const dailyRows =
    period === "session"
      ? []
      : await getAll<UsageRow>(STORES.daily, bucketRange(range.from, range.to));

  let totals: UsageTotals;
  let byType: TypeBytes;
  let sites: SiteUsage[];

  if (period === "session") {
    const bySite = new Map<string, Delta>();
    totals = emptyTotals();
    byType = {};
    for (const [site, delta] of Object.entries(session.sites)) {
      const merged = addTotals(emptyDelta(), delta) as Delta;
      addTypeBytes(merged.byType, delta.byType ?? {});
      bySite.set(site, merged);
      addTotals(totals, delta);
      addTypeBytes(byType, delta.byType ?? {});
    }
    sites = sitesFrom(bySite);
  } else {
    const aggregated = accumulate(dailyRows);
    totals = aggregated.totals;
    byType = aggregated.byType;
    sites = sitesFrom(aggregated.bySite);
  }

  // Today and the session are read at hour resolution: "where did today go" is a
  // question about hours, and a one-bar chart is not a chart.
  const hourly = period === "today" || period === "session";
  const buckets = hourly
    ? hourBuckets(range, period === "session" ? session.startedAt : null)
    : dayKeysInRange(range.from, range.to);
  const seriesRows = hourly
    ? await getAll<UsageRow>(
        STORES.hourly,
        IDBKeyRange.bound(`${range.from}T00|`, `${range.to}T23|\uffff`),
      )
    : dailyRows;
  const series = trimLeadingEmpty(
    seriesFrom(seriesRows, buckets),
    hourly ? HOUR_BUCKETS_SHOWN : buckets.length,
  );

  const tab = await currentTab();
  const currentTotals = tab.site
    ? (sites.find((entry) => entry.site === tab.site)?.totals ?? emptyTotals())
    : emptyTotals();

  return {
    period,
    description: describePeriod(period, settings),
    totals,
    byType,
    sites,
    current: { site: tab.site, origin: tab.origin, totals: currentTotals },
    series,
    settings,
    generatedAt: Date.now(),
    sessionStartedAt: session.startedAt,
  };
}

/**
 * Keeps at most `keep` buckets, ending at the last one.
 *
 * A session that started at 21:40 should not draw twenty-two empty hours in front
 * of itself, and a chart of "today" at 09:00 reads better as nine bars than as
 * nine bars and fifteen gaps.
 */
function trimLeadingEmpty(points: SeriesPoint[], keep: number): SeriesPoint[] {
  const trimmed = points.slice(Math.max(0, points.length - keep));
  const firstUsed = trimmed.findIndex((point) => point.down > 0 || point.up > 0);
  if (firstUsed <= 0) return trimmed;
  // Leave a little context in front of the first bar with data.
  return trimmed.slice(Math.max(0, firstUsed - 1));
}

export async function siteDetail(
  site: string,
  period: Period,
  settings: Settings,
): Promise<SiteDetailPayload> {
  const range = await resolveRange(period, settings);
  const session = await ledger.sessionUsage();

  const dailyRows = await getAllFromIndex<UsageRow>(
    STORES.daily,
    "bySiteBucket",
    IDBKeyRange.bound([site, range.from], [site, range.to]),
  );

  let totals: UsageTotals;
  let byType: TypeBytes;
  if (period === "session") {
    const delta = session.sites[site];
    totals = addTotals(emptyTotals(), delta ?? emptyTotals());
    byType = { ...(delta?.byType ?? {}) };
  } else {
    const aggregated = accumulate(dailyRows);
    totals = aggregated.totals;
    byType = aggregated.byType;
  }

  const hostRows = settings.trackHosts
    ? await getAllFromIndex<HostRow>(
        STORES.hosts,
        "bySiteBucket",
        IDBKeyRange.bound([site, range.from], [site, range.to]),
      )
    : [];
  const hosts = collapseHosts(site, hostRows);

  const today = dayKey();
  const hourRows = await getAllFromIndex<UsageRow>(
    STORES.hourly,
    "bySiteBucket",
    IDBKeyRange.bound([site, `${today}T00`], [site, `${today}T23`]),
  );

  const visits = await visitStats(site, range);

  return {
    site,
    period,
    description: describePeriod(period, settings),
    totals,
    byType,
    hosts,
    days: seriesFrom(dailyRows, dayKeysInRange(range.from, range.to)),
    hours: seriesFrom(hourRows, hourKeysInDay(today)),
    visits,
    settings,
  };
}

function collapseHosts(site: string, rows: readonly HostRow[]): HostUsage[] {
  const byHost = new Map<string, HostUsage>();
  for (const row of rows) {
    let usage = byHost.get(row.host);
    if (!usage) {
      usage = {
        host: row.host,
        down: 0,
        up: 0,
        requests: 0,
        thirdParty: isThirdParty(site, row.host),
      };
      byHost.set(row.host, usage);
    }
    usage.down += row.down;
    usage.up += row.up;
    usage.requests += row.requests;
  }
  return [...byHost.values()].sort((a, b) => b.down + b.up - (a.down + a.up));
}

async function visitStats(site: string, range: DayRange): Promise<VisitStats> {
  const fromMs = startOfDay(range.from).getTime();
  // Midnight after the last day, reached through the day *key* rather than by adding
  // 86,400,000 ms. On the day a clock goes forward that arithmetic lands at 23:00 and
  // silently drops the last hour of page loads; on the day it goes back it spills an
  // hour into the next range.
  const toMs = startOfDay(addDays(range.to, 1)).getTime();
  const visits = await getAllFromIndex<Visit>(
    STORES.visits,
    "bySiteStart",
    // Upper bound excluded, or a page load starting exactly at midnight is counted
    // once in this range and again in the next one.
    IDBKeyRange.bound([site, fromMs], [site, toMs], false, true),
  );
  if (visits.length === 0) return { count: 0, meanDown: 0, medianDown: 0 };

  const sizes = visits.map((visit) => visit.down).sort((a, b) => a - b);
  const sum = sizes.reduce((total, value) => total + value, 0);
  const middle = Math.floor(sizes.length / 2);
  const median =
    sizes.length % 2 === 1
      ? (sizes[middle] ?? 0)
      : ((sizes[middle - 1] ?? 0) + (sizes[middle] ?? 0)) / 2;

  return { count: sizes.length, meanDown: sum / sizes.length, medianDown: median };
}

/** Daily totals across the whole browser, for the dashboard's headline chart. */
export async function dailySeries(days: number): Promise<SeriesPoint[]> {
  const to = dayKey();
  const from = shiftDay(to, -(Math.max(1, days) - 1));
  const rows = await getAll<UsageRow>(STORES.daily, bucketRange(from, to));
  return seriesFrom(rows, dayKeysInRange(from, to));
}

function shiftDay(day: string, offset: number): string {
  const date = startOfDay(day);
  date.setDate(date.getDate() + offset);
  return dayKey(date);
}

/**
 * What is on disk, and whether the numbers behind it are complete.
 *
 * `lastFlushError` rides alongside `StorageReport` rather than inside it because the
 * shared type in `core/messages.ts` does not name the field yet. It belongs here all
 * the same: a rejected write leaves every total quietly behind the traffic it claims
 * to measure, and this is the only report in the extension whose job is to say what
 * the storage layer is actually doing. Fold it into `StorageReport` when that file
 * next changes.
 */
export async function storageReport(): Promise<
  StorageReport & { lastFlushError: FlushError | null }
> {
  const [dailyRows, hourlyRows, hostRows, visitRows, sizeModelRows] = await Promise.all([
    countRows(STORES.daily),
    countRows(STORES.hourly),
    countRows(STORES.hosts),
    countRows(STORES.visits),
    countRows(STORES.sizeModel),
  ]);

  let bytesUsed: number | null = null;
  try {
    const estimate = await navigator.storage?.estimate();
    bytesUsed = typeof estimate?.usage === "number" ? estimate.usage : null;
  } catch {
    bytesUsed = null;
  }

  return {
    dailyRows,
    hourlyRows,
    hostRows,
    visitRows,
    sizeModelRows,
    bytesUsed,
    lastFlushError: ledger.lastFlushError(),
  };
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

const CSV_COLUMNS = [
  "date",
  "site",
  "down_bytes",
  "up_bytes",
  "requests",
  "estimated_down_bytes",
  "cache_hits",
  "cache_avoided_bytes",
  "saved_bytes",
  "blocked_requests",
] as const;

/**
 * One CSV cell: quoted where the format needs it, and defused where a spreadsheet
 * would otherwise run it.
 *
 * A leading `=`, `+`, `-`, `@`, tab or carriage return makes Excel, LibreOffice and
 * Sheets evaluate the cell as a formula, and they do it inside a quoted field as
 * readily as outside one — so quoting is not the guard, and adding the characters to
 * the quote test would not have helped. The `site` column is a hostname straight from
 * the URL parser, which accepts `=` and `+` in an http host (`new URL("http://=cmd/")`
 * parses and yields `=cmd`), so a page someone merely visited can plant the payload
 * and the export carries it to their spreadsheet. A leading apostrophe is the
 * cross-spreadsheet "this cell is text".
 */
function csvCell(value: string | number): string {
  // Numbers are formatted by this module and cannot be a formula; prefixing one would
  // turn a byte count into text in the sheet, which is the opposite of the point.
  if (typeof value === "number") return String(value);
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * A byte figure at the export boundary.
 *
 * The size model's output is a running mean, so `saved`, `estimatedDown` and
 * `cacheAvoided` are genuinely fractional in the store — and `1234.5600000000002` in
 * the one artefact anybody opens reads as a broken tool, whatever the number means.
 * Rounded here rather than on write: the stored value is what was actually computed,
 * and rounding every accumulation would drift.
 */
function csvBytes(value: number): number {
  return Math.round(value);
}

/**
 * The whole ledger, in a form a spreadsheet can open.
 *
 * Included because a number you cannot get out of an extension is a number you
 * have to take on faith, and this one is about someone's data plan.
 */
export async function exportData(
  format: "csv" | "json",
  days: number,
): Promise<{ filename: string; mimeType: string; body: string }> {
  const to = dayKey();
  const from = shiftDay(to, -(Math.max(1, days) - 1));
  const rows = (await getAll<UsageRow>(STORES.daily, bucketRange(from, to))).sort((a, b) =>
    a.key < b.key ? -1 : 1,
  );
  const stamp = to.replace(/-/g, "");

  if (format === "json") {
    // Unindented, and the values unrounded. Two deliberate and opposite choices: at
    // 400 days this is roughly forty thousand rows, and the pretty-printing was the
    // majority of a string that then gets structured-cloned across the message bus and
    // wrapped in a Blob — while the numbers stay exactly as stored, because this is the
    // machine-readable copy and the CSV is the one a person reads.
    return {
      filename: `byte-budget-${stamp}.json`,
      mimeType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        from,
        to,
        note:
          "down_bytes and up_bytes include an approximation of HTTP header " +
          "overhead. estimated_down_bytes is the part of down_bytes that no " +
          "measurement covered.",
        rows: rows.map((row) => ({
          date: row.bucket,
          site: row.site,
          down: row.down,
          up: row.up,
          requests: row.requests,
          estimatedDown: row.estimatedDown,
          cacheHits: row.cacheHits,
          cacheAvoided: row.cacheAvoided,
          saved: row.saved,
          blocked: row.blocked,
          byType: row.byType,
        })),
      }),
    };
  }

  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.bucket,
        row.site,
        csvBytes(row.down),
        csvBytes(row.up),
        row.requests,
        csvBytes(row.estimatedDown),
        row.cacheHits,
        csvBytes(row.cacheAvoided),
        csvBytes(row.saved),
        row.blocked,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return {
    filename: `byte-budget-${stamp}.csv`,
    mimeType: "text/csv",
    body: lines.join("\n"),
  };
}

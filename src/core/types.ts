/**
 * The data model, in one place.
 *
 * Everything downstream of the request ledger reads these shapes, so the rule
 * that keeps the numbers honest lives here: a total always carries how much of
 * it was *measured* alongside how much of it is. See PLAN.md §1.1 — Chrome does
 * not hand extensions a byte count, so some of every total is inferred, and a
 * total that hides that fact is a total nobody should trust.
 */

/** Schema version for the IndexedDB database. Bump on any store change. */
export const DB_VERSION = 1;
export const DB_NAME = "byte-budget";

/* ------------------------------------------------------------------ *
 * Resource types
 * ------------------------------------------------------------------ */

/**
 * A closed set we control, rather than `chrome.webRequest.ResourceType`.
 *
 * Chrome adds types over time (`webtransport`, `webbundle`, …). Storing whatever
 * the browser said would mean stored data whose keys depend on the Chrome
 * version that wrote it, so anything unrecognised folds into `other`.
 */
export const RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "media",
  "xmlhttprequest",
  "websocket",
  "ping",
  "other",
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

const RESOURCE_TYPE_SET = new Set<string>(RESOURCE_TYPES);

export function asResourceType(value: string | undefined): ResourceType {
  return value && RESOURCE_TYPE_SET.has(value) ? (value as ResourceType) : "other";
}

/**
 * Hue per resource type, for the breakdown bar.
 *
 * Assigned rather than hashed from the name. A hash gives stable colours, which is
 * what matters for an open-ended set like hostnames, but this set is fixed and
 * small — so it can also be *legible*: the two categories that dominate a heavy
 * page, video and images, are far apart on the wheel, and the small structural
 * ones sit together in the blues.
 */
export const RESOURCE_TYPE_HUES: Record<ResourceType, number> = {
  media: 352,
  image: 268,
  script: 38,
  main_frame: 205,
  sub_frame: 222,
  stylesheet: 315,
  font: 96,
  xmlhttprequest: 172,
  websocket: 142,
  ping: 20,
  other: 232,
};

/** Display order and labels for the type breakdown, heaviest first by habit. */
export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  media: "Video & audio",
  image: "Images",
  script: "Scripts",
  main_frame: "Pages",
  sub_frame: "Frames",
  stylesheet: "Styles",
  font: "Fonts",
  xmlhttprequest: "Data (XHR/fetch)",
  websocket: "Sockets",
  ping: "Beacons",
  other: "Other",
};

/* ------------------------------------------------------------------ *
 * Site keys
 * ------------------------------------------------------------------ */

/**
 * Reserved site keys.
 *
 * They start with `#`, which no hostname can, so they can share the keyspace
 * with real sites without a separate store or a flag column.
 */
export const BACKGROUND_SITE = "#background";
export const EXTENSION_SITE = "#extensions";

export const RESERVED_SITE_LABELS: Record<string, string> = {
  [BACKGROUND_SITE]: "Background & other",
  [EXTENSION_SITE]: "Extensions",
};

export function isReservedSite(site: string): boolean {
  return site.startsWith("#");
}

/* ------------------------------------------------------------------ *
 * Totals
 * ------------------------------------------------------------------ */

export type TypeBytes = Partial<Record<ResourceType, number>>;

export interface UsageTotals {
  /** Bytes received: response headers plus response body. */
  down: number;
  /** Bytes sent: request line, request headers, and request body. */
  up: number;
  requests: number;
  /**
   * How much of `down` came from the size estimator rather than a measurement.
   * Never larger than `down`. The UI turns this into a measured percentage.
   */
  estimatedDown: number;
  /** Responses the HTTP cache served, so they cost no network bytes. */
  cacheHits: number;
  /** Bytes the HTTP cache avoided, from the size model. Always an estimate. */
  cacheAvoided: number;
  /** Bytes a limit refused or an optimizer removed. */
  saved: number;
  /**
   * How much of `saved` rests on a measurement rather than a model.
   *
   * A refused request has no size — the number is what the estimator thinks it would
   * have weighed. A *rewritten* request does: if the original variant has been seen
   * before, the difference between what it cost then and what the smaller one cost
   * now is arithmetic. The two must be reported apart, or the second is dragged down
   * to the credibility of the first.
   */
  savedMeasured: number;
  /** Requests a budget or an optimizer rule stopped. */
  blocked: number;
  /** Requests an optimizer rewrote to a smaller variant. */
  rewritten: number;
}

export function emptyTotals(): UsageTotals {
  return {
    down: 0,
    up: 0,
    requests: 0,
    estimatedDown: 0,
    cacheHits: 0,
    cacheAvoided: 0,
    saved: 0,
    savedMeasured: 0,
    blocked: 0,
    rewritten: 0,
  };
}

/**
 * The keys of `UsageTotals`, in one place.
 *
 * Addition walks this list rather than naming each field, so a field added to the
 * shape and forgotten in the adder cannot silently stop accumulating — which is a
 * failure that looks like "the number seems low" rather than like a bug.
 */
export const TOTAL_KEYS = Object.keys(emptyTotals()) as (keyof UsageTotals)[];

/**
 * Adds one set of totals into another.
 *
 * Missing fields are read as zero. Rows written by an earlier version of the
 * extension genuinely lack the newer ones, and `undefined + 0` is `NaN` — one such
 * row would poison every aggregate it appeared in, permanently, with no way to tell
 * where it came from.
 */
export function addTotals(into: UsageTotals, from: Partial<Readonly<UsageTotals>>): UsageTotals {
  for (const key of TOTAL_KEYS) {
    into[key] = (into[key] ?? 0) + (from[key] ?? 0);
  }
  return into;
}

export function addTypeBytes(into: TypeBytes, from: Readonly<TypeBytes>): TypeBytes {
  for (const key of Object.keys(from) as ResourceType[]) {
    into[key] = (into[key] ?? 0) + (from[key] ?? 0);
  }
  return into;
}

export function totalBytes(totals: Readonly<UsageTotals>): number {
  return totals.down + totals.up;
}

/**
 * Share of `down` that was actually measured, as 0..1.
 *
 * A total of zero counts as fully measured: there is nothing in it to be wrong
 * about, and returning 0 would make an empty popup claim 0% confidence.
 */
export function measuredShare(totals: Readonly<UsageTotals>): number {
  if (totals.down <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - totals.estimatedDown / totals.down));
}

/* ------------------------------------------------------------------ *
 * Stored rows
 * ------------------------------------------------------------------ */

/**
 * One site's usage inside one bucket.
 *
 * `bucket` is a day (`2026-07-31`) in the `daily` store and an hour
 * (`2026-07-31T14`) in the `hourly` store. Same shape in both, because the only
 * difference between them is resolution and how long they are kept.
 */
export interface UsageRow extends UsageTotals {
  /** `${bucket}|${site}` — the primary key. */
  key: string;
  bucket: string;
  site: string;
  byType: TypeBytes;
}

/** One third-party host's contribution to one site on one day. */
export interface HostRow {
  /** `${bucket}|${site}|${host}` */
  key: string;
  bucket: string;
  site: string;
  host: string;
  down: number;
  up: number;
  requests: number;
  blocked: number;
  saved: number;
}

/**
 * Which arm of the optimizer comparison a page load belongs to.
 *
 * A bare boolean cannot answer this, and the cases it collapses are not
 * interchangeable. Every load from before Data Saver was switched on, every load on
 * an excluded site, and every load whose optimizer settings had not resolved yet are
 * all "not optimized" — and none of them is a control. Counted as one, switching Data
 * Saver on today makes the previous thirty days the control group, so the first
 * "measured" saving anyone sees is really before-versus-after-install.
 *
 * Only `holdout` is a control and only `optimized` is treatment. The other three
 * belong to neither and must be counted in neither.
 */
export const VISIT_REASONS = ["optimized", "holdout", "disabled", "excluded", "unknown"] as const;

export type VisitReason = (typeof VISIT_REASONS)[number];

/**
 * One top-level page load.
 *
 * Deliberately holds no path and no query string — only the origin. Per-visit
 * byte averages and the phase-3 optimize/holdout comparison need to know *which
 * site* and *how many bytes*, and nothing else. Storing full URLs would make
 * this a browsing history, which is a different product with different stakes.
 */
export interface Visit {
  id: string;
  site: string;
  /** Scheme and host only, e.g. `https://www.youtube.com`. */
  origin: string;
  tabId: number;
  startedAt: number;
  endedAt?: number;
  down: number;
  up: number;
  requests: number;
  /**
   * Phase 3: whether optimizers were active for this load.
   *
   * Kept alongside `reason` rather than replaced by it. It is the only thing rows
   * written before `reason` existed carry, so dropping it would make them
   * unreadable instead of merely coarse — and an added optional field needs no
   * schema migration, which a replacement would.
   */
  optimized: boolean;
  /** Absent on rows written before the field existed; use `visitReason`. */
  reason?: VisitReason;
  saved: number;
}

/**
 * The arm a stored visit belongs to, including rows written before `reason` existed.
 *
 * `optimized: true` maps straight across: the build that wrote it could only set that
 * when the optimizers were on and the load was not a holdout. `optimized: false`
 * cannot be mapped, because that build could not tell a holdout from an excluded site
 * from an unresolved settings snapshot — so it reads as `unknown` and lands in neither
 * arm. Reading it as `holdout` or `disabled` is precisely the contamination this
 * field was added to close.
 */
export function visitReason(visit: Readonly<Pick<Visit, "optimized" | "reason">>): VisitReason {
  if (visit.reason) return visit.reason;
  return visit.optimized ? "optimized" : "unknown";
}

/**
 * The learned size model: a running mean response size per host and type.
 *
 * Used for two things — filling in responses that arrived without a
 * `Content-Length` and without usable resource timing, and pricing a request
 * that was blocked before it could report a size at all.
 */
export interface SizeSample {
  /** `${host}|${type}` */
  key: string;
  mean: number;
  count: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ *
 * Periods
 * ------------------------------------------------------------------ */

export const PERIODS = ["session", "today", "week", "month"] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABELS: Record<Period, string> = {
  session: "Session",
  today: "Today",
  week: "7 days",
  month: "30 days",
};

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export interface Settings {
  theme: "auto" | "light" | "dark";
  /** `si`: 1 kB = 1000 B. `iec`: 1 KiB = 1024 B. */
  units: "si" | "iec";
  /** A calendar week, or the trailing seven days including today. */
  weekMode: "calendar" | "rolling";
  /** A calendar month, or the trailing thirty days including today. */
  monthMode: "calendar" | "rolling";
  /** First day of a calendar week. 0 = Sunday, 1 = Monday. */
  weekStart: 0 | 1;
  /** Days of daily rows to keep. 0 keeps everything. */
  retentionDays: number;
  /** What the toolbar badge counts, if anything. */
  badge: "off" | "session" | "today";
  /** Record per-host breakdowns. Off makes the drill-down poorer and the DB smaller. */
  trackHosts: boolean;
}

export const RETENTION_OPTIONS = [30, 90, 400, 0] as const;

export const DEFAULT_SETTINGS: Settings = {
  theme: "auto",
  units: "si",
  weekMode: "rolling",
  monthMode: "rolling",
  weekStart: 1,
  retentionDays: 400,
  badge: "off",
  trackHosts: true,
};

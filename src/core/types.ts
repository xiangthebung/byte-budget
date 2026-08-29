/**
 * The data model, in one place.
 *
 * Everything downstream of the request ledger reads these shapes, so the rule
 * that keeps the numbers honest lives here: a total always carries how much of
 * it was *measured* alongside how much of it is. See ARCHITECTURE.md "Measurement" — Chrome does
 * not hand extensions a byte count, so some of every total is inferred, and a
 * total that hides that fact is a total nobody should trust.
 */

import { t } from "./i18n";

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

/**
 * Display order and labels for the type breakdown, heaviest first by habit.
 *
 * The order is the property order of this object and is read by the chart; the text
 * comes from the catalogue. Resolved once at module load rather than per render,
 * because the locale cannot change while a page is open.
 */
export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  media: t("coreResourceTypeMedia"),
  image: t("coreResourceTypeImage"),
  script: t("coreResourceTypeScript"),
  main_frame: t("coreResourceTypeMainFrame"),
  sub_frame: t("coreResourceTypeSubFrame"),
  stylesheet: t("coreResourceTypeStylesheet"),
  font: t("coreResourceTypeFont"),
  xmlhttprequest: t("coreResourceTypeXhr"),
  websocket: t("coreResourceTypeWebsocket"),
  ping: t("coreResourceTypePing"),
  other: t("coreResourceTypeOther"),
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

/**
 * The budget key meaning "everything", rather than one site.
 *
 * Unlike the other two reserved keys this one is never attributed to: no stored row
 * ever carries it. It is a `Budget.site` and nothing else, so a reader that sums the
 * daily rows cannot meet it and count the same bytes twice. The `#` prefix is what
 * keeps it out of the hostname keyspace, exactly as it does for the buckets.
 */
export const ALL_SITES = "#all";

/**
 * What each reserved key is called on screen. The keys themselves are stored and
 * never translated; only the label a person reads comes from the catalogue.
 */
export const RESERVED_SITE_LABELS: Record<string, string> = {
  [BACKGROUND_SITE]: t("coreSiteBackground"),
  [EXTENSION_SITE]: t("coreSiteExtensions"),
  [ALL_SITES]: t("coreSiteAll"),
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

/** The option text in the period selector. Short: these sit in a four-up control. */
export const PERIOD_LABELS: Record<Period, string> = {
  session: t("corePeriodOptionSession"),
  today: t("corePeriodOptionToday"),
  week: t("corePeriodOptionWeek"),
  month: t("corePeriodOptionMonth"),
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
  /**
   * The size of the data plan these numbers are reconciled against, in bytes.
   *
   * `null` means no plan is set, and that is not the same as a plan of zero. A zero
   * would be 100% spent before the first request and would put every surface into
   * "over your limit" for someone who has simply never answered the question, so the
   * two states are kept apart here rather than argued about at each call site.
   */
  planBytes: number | null;
  /**
   * Day of the month the plan resets. 1..28, or 0 for the calendar month.
   *
   * Most carrier cycles do not reset on the 1st, and a "30 days" figure anchored
   * there is never the figure on the bill — which is the number this whole product
   * exists to predict.
   */
  cycleStartDay: number;
}

export const RETENTION_OPTIONS = [30, 90, 400, 0] as const;

/**
 * The sections of the options page, as they appear in its URL fragment.
 *
 * Here rather than in `settings.ts` because the popup links into three of them and
 * the dashboard into two, and until this list existed each of those surfaces spelled
 * the fragment out for itself. When the panels became panes every one of them kept
 * pointing at a `#…-panel` that no longer existed — which does not throw, does not
 * warn, and simply opens Settings at the top, so four buttons quietly stopped doing
 * what their labels said.
 *
 * `settings.ts` reads a fragment against this list and falls back to the first entry,
 * so an unknown one is still handled. What the shared list buys is that a caller
 * cannot write one: `openSettings("plan-panel")` is now a type error rather than a
 * button that goes to the wrong place.
 */
export const SETTINGS_SECTIONS = [
  "plan",
  "saver",
  "limits",
  "alerts",
  "appearance",
  "privacy",
  /**
   * Last on the rail on purpose.
   *
   * Every lock elsewhere on the page links here, so it is reachable in one click from
   * the moment anyone meets a ceiling — which is the only time it is relevant. Putting
   * it first would make the upgrade the first thing a person sees on the page they
   * opened to change their reset day, and the paid tier here is meant to be something
   * people grow into rather than something the settings page opens by asking for money.
   */
  "plus",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * The largest day of the month a billing cycle may start on.
 *
 * 28 rather than 31, because every month has a 28th. A cycle anchored above it would
 * have to be clamped in short months, which means the reset date moves — and the
 * reset date is the one value here a person checks against a paper bill.
 */
export const MAX_CYCLE_START_DAY = 28;

export const DEFAULT_SETTINGS: Settings = {
  theme: "auto",
  units: "si",
  weekMode: "rolling",
  monthMode: "rolling",
  weekStart: 1,
  retentionDays: 400,
  badge: "off",
  trackHosts: true,
  planBytes: null,
  cycleStartDay: 0,
};

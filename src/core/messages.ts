/**
 * The typed contract between the two UIs and the service worker.
 *
 * The worker owns the ledger, so every number the popup and the dashboard show
 * comes through here. Two consequences worth stating: a UI never opens the
 * database itself (there would then be two writers to reason about), and every
 * read forces a flush of the in-memory buffer first, so an open popup can never
 * show a total that is five seconds stale while traffic is flowing.
 */

import type { AlertSettings } from "../limit/alerts";
import type { Budget, BudgetPeriod, BudgetShape } from "../limit/budgets";
import type { Tier } from "../limit/tiers";
import type { OptimizeSettings, PageFeatureId } from "../optimize/features";
import type { FlushError } from "../track/ledger";
import type { Projection } from "./forecast";
import type {
  Period,
  ResourceType,
  Settings,
  TypeBytes,
  UsageTotals,
} from "./types";

/* ------------------------------------------------------------------ *
 * Payload shapes
 * ------------------------------------------------------------------ */

export interface SiteUsage {
  site: string;
  totals: UsageTotals;
  byType: TypeBytes;
}

export interface SeriesPoint {
  /** A day (`YYYY-MM-DD`) or an hour (`YYYY-MM-DDTHH`) key. */
  bucket: string;
  down: number;
  up: number;
  saved: number;
}

export interface CurrentTab {
  site: string | null;
  origin: string | null;
  /** Usage for this site over the requested period. */
  totals: UsageTotals;
}

export interface OverviewPayload {
  period: Period;
  /** A sentence naming exactly what the period covers. */
  description: string;
  totals: UsageTotals;
  byType: TypeBytes;
  /** Descending by total bytes. */
  sites: SiteUsage[];
  current: CurrentTab;
  /** Bytes per day across the period, for the popup sparkline. Empty for `session`. */
  series: SeriesPoint[];
  /**
   * The window of the same length immediately before this one.
   *
   * Measured, on exactly the same basis as `totals`, so the two can be subtracted:
   * "18% less than the previous 30 days". Behaviour change is the point of a budgeting
   * tool, and a tool that cannot show change cannot show that it worked.
   */
  previousTotals: UsageTotals;
  /**
   * Where the current cycle is heading, or `null` when no plan is set or there are too
   * few days to say anything.
   *
   * The one modelled figure on this payload, and it must be shown as one: label it a
   * projection and print `basis` beside it rather than summarising it away. Never add it
   * to, or subtract it from, `totals` — merging a modelled number into a measured one is
   * the mistake this codebase is organised to make impossible.
   */
  projection: Projection | null;
  settings: Settings;
  /**
   * When the worker composed this payload, epoch ms.
   *
   * On the payload so a surface can say how old what it is showing is. The popup polls
   * every two seconds and keeps the last payload on screen while a poll is in flight or
   * has failed — and a worker torn down after an idle gap makes a failed poll ordinary
   * rather than exceptional. So: compare with `Date.now()` on render, and past roughly
   * ten seconds print `formatAgo(generatedAt)` instead of presenting the figures as
   * live. A number that is quietly a minute old is exactly what a measurement tool
   * cannot show without saying so.
   */
  generatedAt: number;
  /** Wall-clock start of the browser session, for the `session` period. */
  sessionStartedAt: number;
}

export interface HostUsage {
  host: string;
  down: number;
  up: number;
  requests: number;
  thirdParty: boolean;
}

export interface VisitStats {
  count: number;
  meanDown: number;
  medianDown: number;
}

export interface SiteDetailPayload {
  site: string;
  period: Period;
  description: string;
  totals: UsageTotals;
  byType: TypeBytes;
  /** Descending by bytes. Empty when host tracking is switched off. */
  hosts: HostUsage[];
  /** One point per day in the period. */
  days: SeriesPoint[];
  /** One point per hour, only for the `today` period. */
  hours: SeriesPoint[];
  visits: VisitStats;
  settings: Settings;
}

export interface StorageReport {
  dailyRows: number;
  hourlyRows: number;
  hostRows: number;
  visitRows: number;
  sizeModelRows: number;
  /**
   * Rows in the observed-baselines store.
   *
   * Optional so that a payload from a build whose `storageReport()` predates the field
   * still typechecks and can be shown as "not reported". Defaulting it to 0 would be the
   * worse failure: this is the one store retention pruning does not touch, it is capped
   * by row count alone, and a disk panel claiming it is empty when it holds three
   * thousand third-party image URLs would be wrong in the direction that matters.
   */
  baselineRows?: number;
  /** From `navigator.storage.estimate()`, when the browser offers it. */
  bytesUsed: number | null;
  /**
   * The last flush whose writes did not all land, or `null` when everything is written.
   *
   * Reported rather than only logged: a rejected write leaves every total quietly behind
   * the traffic it claims to measure, and a service worker's console is not a surface
   * anyone opens. This is the only report in the extension whose job is to say what the
   * storage layer is actually doing, so it is the only place that admission fits.
   */
  lastFlushError: FlushError | null;
}

/* ------------------------------------------------------------------ *
 * Content script -> worker
 * ------------------------------------------------------------------ */

/**
 * One resource the page observed loading.
 *
 * Sent only when it carries a usable size. `transferSize` is 0 for an opaque
 * cross-origin response *and* for a cache hit, so a zero tells us nothing and
 * posting it would just be noise on the message bus (PLAN.md §1.1).
 */
export interface TimingReport {
  url: string;
  /** Bytes over the wire, including response headers. */
  transferSize: number;
  /** Compressed body size, for the rare case `transferSize` is unavailable. */
  encodedBodySize: number;
  initiatorType: string;
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

export type ExtensionRequest =
  | { type: "GET_OVERVIEW"; period: Period }
  | { type: "GET_SITE"; site: string; period: Period }
  | { type: "GET_SERIES"; days: number }
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; changes: Partial<Settings> }
  /**
   * Alert preferences are their own pair rather than fields on `Settings`.
   *
   * `Settings` is what every surface reads on every render and what `normalize()` has to
   * validate field by field; two booleans that only the worker's alerting path consults
   * do not belong in that hot, load-bearing shape. Keeping them apart also keeps the
   * thing that can interrupt someone in one file with the rules that bound it.
   */
  | { type: "GET_ALERTS" }
  | { type: "SAVE_ALERTS"; changes: Partial<AlertSettings> }
  | { type: "GET_STORAGE_REPORT" }
  | { type: "EXPORT"; format: "csv" | "json"; days: number }
  | { type: "CLEAR_DATA" }
  /**
   * Sets a site's enforcement tier directly.
   *
   * Phase 2's budget evaluator will call the same code path when usage crosses a
   * threshold; exposing it as a message is what lets the browser test drive
   * enforcement without a budget having to be exceeded first.
   */
  | { type: "SET_ENFORCEMENT"; site: string; tier: Tier }
  | { type: "GET_ENFORCEMENT" }
  | { type: "GET_BUDGETS" }
  | {
      type: "PUT_BUDGET";
      site: string;
      bytes: number;
      period: BudgetPeriod;
      shape?: BudgetShape;
      kbps?: number;
    }
  | { type: "REMOVE_BUDGET"; site: string }
  | { type: "SNOOZE_BUDGET"; site: string; minutes: number }
  | { type: "RESUME_BUDGET"; site: string }
  | { type: "GRANT_BYTES"; site: string; bytes: number }
  /** Asked by the in-page banner for its own tab. */
  | { type: "GET_TAB_NOTICE" }
  | { type: "OPEN_DASHBOARD" }
  | { type: "GET_OPTIMIZE" }
  | { type: "SAVE_OPTIMIZE"; changes: Partial<OptimizeSettings> }
  /** Adds or removes the current site from the never-optimize list. */
  | { type: "SET_SITE_OPTIMIZE"; site: string; optimize: boolean }
  | { type: "GET_SAVINGS"; days: number }
  /** Asked by the page optimizer for the features it should apply. */
  | { type: "GET_PAGE_FEATURES" }
  /** Fire-and-forget from the timing content script. */
  | { type: "REPORT_TIMINGS"; entries: TimingReport[] };

export interface EnforcementState {
  site: string;
  tier: Tier;
  tabIds: number[];
  since: number;
}

/** A budget plus everything the UI needs to talk about it. */
export interface BudgetStatus {
  budget: Budget;
  /** Bytes used in the current window, live rather than from the last flush. */
  used: number;
  /** Budget plus any grant for this window. */
  allowance: number;
  /** `used / allowance`, uncapped so the UI can honestly say 112%. */
  share: number;
  /** The tier currently installed. */
  tier: Tier;
  /** The tier the numbers imply, ignoring a snooze. */
  wouldBe: Tier;
  snoozed: boolean;
  periodKey: string;
  /** Epoch ms when the window rolls over, or `null` for a session budget. */
  resetsAt: number | null;
}

/**
 * The savings report, with its three sources kept apart.
 *
 * Reporting one number would be easier and would be the wrong thing: a refused request
 * has no measured size, a rewritten one often does, and the difference between control
 * and optimized page loads is the only figure that does not depend on the extension's
 * own estimates at all. Collapsing them would drag the strongest down to the
 * credibility of the weakest.
 */
export interface SavingsReport {
  from: string;
  to: string;
  /**
   * Total credited, measured plus modelled.
   *
   * Deliberately not the headline. It is the sum of two numbers with different
   * standing, and a surface that renders only this one has merged them — which is the
   * single thing README.md:133-141 says must never happen. Render `savedMeasured` and
   * `savedModelled` as two figures; use this only where a single total is genuinely
   * what is being asked for, and tilde it when it is.
   */
  saved: number;
  /** The part that came from observing the original variant. Arithmetic — show it untilded. */
  savedMeasured: number;
  /**
   * `saved` minus `savedMeasured`: the estimator's share of the credit.
   *
   * Precomputed rather than left as a subtraction for the UI, because a subtraction the
   * caller has to remember is a subtraction one caller will forget — and the failure is
   * silent, arriving as a modelled number wearing a measured number's confidence.
   * Never show it without a tilde.
   */
  savedModelled: number;
  blocked: number;
  rewritten: number;
  /** Per-site page-load comparisons, where both sides have enough samples. */
  deltas: VisitDeltaView[];
  /** Sum of `savedTotal` across `deltas`. Measured, by construction. */
  deltaTotal: number;
  /** How many original sizes are on file, for the UI to explain improving accuracy. */
  baselines: number;
  settings: Settings;
  optimize: OptimizeSettings;
}

export interface VisitDeltaView {
  site: string;
  optimizedCount: number;
  controlCount: number;
  optimizedMean: number;
  controlMean: number;
  savedPerVisit: number;
  /**
   * Half-width of the 95% interval around `savedPerVisit`, in bytes.
   *
   * Carried to the UI so the figure can be shown as the range it is. Page weights are
   * heavy-tailed, so a difference of means over a few dozen loads can be large and mean
   * nothing; `savings.ts` already suppresses a row whose interval straddles zero, and
   * printing the spread is what stops the survivors reading as more precise than they
   * are. A number this product cannot stand behind is a number it should not show.
   */
  savedPerVisitSpread: number;
  savedTotal: number;
}

/**
 * What the in-page banner says.
 *
 * Composed in the worker so the content script carries no formatting logic — it has
 * to stay import-free, and duplicating byte formatting into it would be the first
 * thing to drift.
 */
export interface TabNotice {
  site: string;
  tier: Tier;
  headline: string;
  detail: string;
  /** False while already snoozed, so the button does not offer a no-op. */
  canPause: boolean;
}

export type ResponseFor<T extends ExtensionRequest> = T extends { type: "GET_OVERVIEW" }
  ? OverviewPayload
  : T extends { type: "GET_SITE" }
    ? SiteDetailPayload
    : T extends { type: "GET_SERIES" }
      ? { points: SeriesPoint[] }
      : T extends { type: "GET_SETTINGS" }
        ? { settings: Settings }
        : T extends { type: "SAVE_SETTINGS" }
          ? { settings: Settings }
          : T extends { type: "GET_ALERTS" | "SAVE_ALERTS" }
            ? { alerts: AlertSettings }
            : T extends { type: "GET_STORAGE_REPORT" }
              ? StorageReport
              : T extends { type: "EXPORT" }
                ? { filename: string; mimeType: string; body: string }
                : T extends { type: "SET_ENFORCEMENT" }
                  ? { rules: number; enforcement: EnforcementState[] }
                  : T extends { type: "GET_ENFORCEMENT" }
                    ? { enforcement: EnforcementState[] }
                    : T extends {
                          type:
                            | "GET_BUDGETS"
                            | "PUT_BUDGET"
                            | "REMOVE_BUDGET"
                            | "SNOOZE_BUDGET"
                            | "RESUME_BUDGET"
                            | "GRANT_BYTES";
                        }
                      ? { statuses: BudgetStatus[] }
                      : T extends { type: "GET_TAB_NOTICE" }
                        ? { notice: TabNotice | null }
                        : T extends {
                              type: "GET_OPTIMIZE" | "SAVE_OPTIMIZE" | "SET_SITE_OPTIMIZE";
                            }
                          ? { optimize: OptimizeSettings; rules: number }
                          : T extends { type: "GET_SAVINGS" }
                            ? SavingsReport
                            : T extends { type: "GET_PAGE_FEATURES" }
                              ? { features: PageFeatureId[] }
                              : Record<string, never>;

export type Envelope<T> = ({ ok: true } & T) | { ok: false; error: string };

/** Sends a request to the service worker and unwraps the response. */
export async function sendRequest<T extends ExtensionRequest>(
  request: T,
): Promise<ResponseFor<T>> {
  const response = await new Promise<Envelope<ResponseFor<T>> | undefined>((resolve, reject) => {
    chrome.runtime.sendMessage(request, (value) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? "The background worker is unavailable."));
      else resolve(value as Envelope<ResponseFor<T>> | undefined);
    });
  });
  if (!response) throw new Error("The background worker did not respond.");
  if (!response.ok) throw new Error(response.error);
  return response;
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** Order a type breakdown by bytes, largest first, dropping empty entries. */
export function sortTypeBytes(byType: TypeBytes): [ResourceType, number][] {
  return (Object.entries(byType) as [ResourceType, number][])
    .filter(([, bytes]) => bytes > 0)
    .sort((a, b) => b[1] - a[1]);
}

/**
 * The popup: one question, answered in one glance — am I about to blow my plan?
 *
 * It polls while open. That looks wasteful and is the opposite: asking the worker
 * for an overview forces it to flush its buffer first, so a popup left open next
 * to a loading page shows the bytes arriving rather than a figure from whenever it
 * was opened. It also keeps the worker awake for exactly as long as someone is
 * looking at it, which is when that matters.
 *
 * Two rules the render path is built around, both of them defects this file used to
 * have:
 *
 * 1. A poll never destroys a node. Everything fixed is written in popup.html and
 *    only ever has its text, style, dataset and `hidden` updated; the site list is
 *    reconciled by site key; the chart and the type breakdown are the only things
 *    rebuilt, and only when their numbers actually changed. Three `replaceChildren`
 *    calls on a two-second clock gave a keyboard user under two seconds to reach
 *    "Pause 1 hour" before the button was deleted underneath them, and wiped a
 *    screen reader's buffer mid-sentence, every two seconds, for as long as it was
 *    reading.
 *
 * 2. Measured and modelled figures never merge. `totals` is measured; `projection`
 *    is the one modelled number here and it is rendered with `basis` beside it and
 *    the word "projected", never added to anything; a refused request's size is the
 *    estimator's guess and carries a tilde and `--estimate`; a rewrite whose
 *    original is on file is arithmetic and carries neither.
 */

import "./popup.css";
import { barChart, stackedBar, type BarPoint, type StackSegment } from "./core/chart";
import {
  bindGroup,
  button,
  element,
  faviconUrl,
  paintGroup,
  query,
  queryAll,
  replaceChildren,
  type Child,
} from "./core/dom";
import { formatAgo, formatBytes, formatCount, formatPercent, splitBytes } from "./core/format";
import { applyDocumentLanguage, t } from "./core/i18n";
import {
  errorMessage,
  sendRequest,
  sortTypeBytes,
  type BudgetStatus,
  type OverviewPayload,
  type SavingsReport,
  type SeriesPoint,
  type SiteUsage,
} from "./core/messages";
import {
  cycleElapsed,
  cycleResetsAt,
  dayKeyFromMs,
  formatDayShort,
  formatPeriodDescription,
  hourKey,
} from "./core/period";
import { applyTheme, getSettings, onSettingsChanged } from "./core/settings";
import type { BudgetPeriod } from "./limit/budgets";
import { TIER_DESCRIPTIONS, TIERS } from "./limit/tiers";
import type { OptimizeSettings } from "./optimize/features";
import {
  ALL_SITES,
  isReservedSite,
  measuredShare,
  PERIOD_LABELS,
  PERIODS,
  RESERVED_SITE_LABELS,
  RESOURCE_TYPE_HUES,
  RESOURCE_TYPE_LABELS,
  totalBytes,
  type Period,
  type Settings,
} from "./core/types";

/** Live figures: the ledger flushes on every one of these, so it is also the write cadence. */
const FAST_MS = 2000;
/**
 * Preferences, the savings report and the cycle-to-date total.
 *
 * None of them is a live number. Optimize settings change when a person changes
 * them, the savings report is computed over page loads rather than requests, and a
 * plan is a monthly figure — refreshing any of them every two seconds would be
 * three more IndexedDB transactions a second to move a number nobody is watching
 * that closely.
 */
const SLOW_MS = 20_000;
const SITE_ROWS = 6;
const SITE_ROWS_EXPANDED = 40;
/** Past this, the payload is described as what it is rather than presented as live. */
const STALE_MS = 10_000;
const SAVINGS_DAYS = 30;
/**
 * Consecutive failed polls before the popup stops asking.
 *
 * Not one. A worker torn down after an idle gap makes the first poll after it fail
 * as a matter of course, and the old code killed the timer on that first failure —
 * so an ordinary MV3 teardown left the popup frozen on a stale figure with an error
 * where the privacy note goes. Two failures earn a banner, ten earn giving up.
 */
const POLL_FAILURES_BANNER = 2;
const POLL_FAILURES_STOP = 10;
const REMOVE_CONFIRM_MS = 5000;
const PERIOD_STORAGE_KEY = "ui.period";
const OPTIMIZE_DISMISSED_KEY = "ui.optimizeDismissed";

/* ------------------------------------------------------------------ *
 * Fixed strings
 * ------------------------------------------------------------------ */

/**
 * Writes the text that popup.html names but does not hold.
 *
 * Chrome substitutes `__MSG_name__` in the manifest and in CSS but not in an
 * extension page's HTML, so this loop is the only way those strings can be
 * translated at all. It runs at module scope, before the lookups below and well
 * before the first paint, so a key is never on screen.
 *
 * `title` and `aria-label` are swept alongside text. They carry the entire top bar
 * and the plan meter for a screen-reader user, and an attribute is the string an
 * extraction pass forgets. `welcome.ts` holds the twin of this loop rather than
 * sharing one: `core/i18n.ts` is the cross-surface contract and holds `t` alone.
 */
function applyFixedStrings(): void {
  for (const node of queryAll<HTMLElement>("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n ?? "");
  }
  for (const node of queryAll<HTMLElement>("[data-i18n-title]")) {
    node.title = t(node.dataset.i18nTitle ?? "");
  }
  for (const node of queryAll<HTMLElement>("[data-i18n-label]")) {
    node.setAttribute("aria-label", t(node.dataset.i18nLabel ?? ""));
  }
}

applyFixedStrings();

/* ------------------------------------------------------------------ *
 * Elements
 * ------------------------------------------------------------------ */

const app = query<HTMLDivElement>("#app");
const paceLine = query<HTMLParagraphElement>("#pace-line");
const totalValue = query<HTMLSpanElement>("#total-value");
const totalUnit = query<HTMLSpanElement>("#total-unit");
const planBlock = query<HTMLDivElement>("#plan-block");
const planMeter = query<HTMLSpanElement>("#plan-meter");
const planMeterFill = query<HTMLSpanElement>("#plan-meter-fill");
const planMeterPace = query<HTMLSpanElement>("#plan-meter-pace");
const planLine = query<HTMLParagraphElement>("#plan-line");
const planCta = query<HTMLParagraphElement>("#plan-cta");
const planAlerts = query<HTMLElement>("#plan-alerts");
const planAlertsHint = query<HTMLSpanElement>("#plan-alerts-hint");
const projectionCard = query<HTMLElement>("#projection");
const projectionFigure = query<HTMLParagraphElement>("#projection-figure");
const projectionBasis = query<HTMLParagraphElement>("#projection-basis");
const projectionToggle = query<HTMLButtonElement>("#projection-toggle");
const periodTabs = query<HTMLDivElement>("#period-tabs");
const metaLine = query<HTMLParagraphElement>("#meta-line");
const actionError = query<HTMLParagraphElement>("#action-error");
const actionErrorText = query<HTMLSpanElement>("#action-error-text");
const actionErrorDismiss = query<HTMLButtonElement>("#action-error-dismiss");
const limitCard = query<HTMLElement>("#limit-card");
const limitScope = query<HTMLSpanElement>("#limit-scope");
const limitStatus = query<HTMLParagraphElement>("#limit-status");
const limitLine = query<HTMLParagraphElement>("#limit-line");
const limitBar = query<HTMLSpanElement>("#limit-bar");
const limitBarFill = query<HTMLSpanElement>("#limit-bar-fill");
const limitConsequence = query<HTMLParagraphElement>("#limit-consequence");
const limitPrevented = query<HTMLParagraphElement>("#limit-prevented");
const limitAlso = query<HTMLParagraphElement>("#limit-also");
const limitNote = query<HTMLParagraphElement>("#limit-note");
const limitActions = query<HTMLDivElement>("#limit-actions");
const limitGrant = query<HTMLButtonElement>("#limit-grant");
const limitPause = query<HTMLButtonElement>("#limit-pause");
const limitRemove = query<HTMLButtonElement>("#limit-remove");
const limitPresets = query<HTMLDivElement>("#limit-presets");
const optimizeRow = query<HTMLElement>("#optimize-row");
const optimizeCheck = query<HTMLInputElement>("#optimize-site");
const optimizeCopy = query<HTMLLabelElement>("#optimize-copy");
const optimizeTitle = query<HTMLSpanElement>("#optimize-title");
const optimizeHint = query<HTMLSpanElement>("#optimize-hint");
const optimizeMeasured = query<HTMLSpanElement>("#optimize-measured");
const optimizeAction = query<HTMLButtonElement>("#optimize-action");
const optimizeDismissButton = query<HTMLButtonElement>("#optimize-dismiss");
const chartPanel = query<HTMLElement>("#chart-panel");
const chartSlot = query<HTMLDivElement>("#chart-slot");
const chartNote = query<HTMLSpanElement>("#chart-note");
const typesSlot = query<HTMLDivElement>("#types-slot");
const sitesPanel = query<HTMLElement>("#sites-panel");
const siteList = query<HTMLOListElement>("#site-list");
const sitesNote = query<HTMLSpanElement>("#sites-note");
const sitesExpand = query<HTMLButtonElement>("#sites-expand");
const emptyState = query<HTMLParagraphElement>("#empty-state");
const liveRegion = query<HTMLParagraphElement>("#live-region");

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

let period: Period = "today";
let units: Settings["units"] = "si";
let settings: Settings | null = null;
let overview: OverviewPayload | null = null;
let statuses: BudgetStatus[] = [];
let optimize: OptimizeSettings | null = null;
let savings: SavingsReport | null = null;
let savingsLoaded = false;
/** Measured bytes since the plan cycle began, or `null` while unknown or with no plan. */
let cycleUsed: number | null = null;
let optimizeDismissed = false;
let siteLimit = SITE_ROWS;
let pollFailures = 0;
let fastTimer: ReturnType<typeof setInterval> | null = null;
let slowTimer: ReturnType<typeof setInterval> | null = null;

/** Which limit the card's three buttons act on. Set by `renderLimit`, read by the handlers. */
let actingOn: BudgetStatus | null = null;
let removeArmed = false;
let removeTimer: ReturnType<typeof setTimeout> | null = null;
let errorSource: "poll" | "action" | null = null;
let lastChartSignature = "";
let lastTypesSignature = "";
let lastMetaSignature = "";
let lastSiteOrder = "";

function bytes(value: number): string {
  return formatBytes(value, units);
}

function siteLabel(site: string): string {
  return isReservedSite(site) ? (RESERVED_SITE_LABELS[site] ?? site) : site;
}

/**
 * Sets a state attribute, or removes it on `null`.
 *
 * Every one of these drives a CSS selector rather than being read back, and a state
 * that is toggled off has to leave no attribute behind — `data-over="false"` is a
 * different thing to no attribute at all, and `[data-over="true"]` would not be the
 * only selector anyone ever writes against it.
 */
function setData(node: Element, name: string, value: string | null): void {
  if (value === null) node.removeAttribute(name);
  else node.setAttribute(name, value);
}

/* ------------------------------------------------------------------ *
 * Copy that only the UI needs
 *
 * These belong beside the sentences they are read in, not in `limit/budgets.ts`,
 * which names the same four windows for a different job: "per day" is the right
 * phrase for a settings table listing limits and the wrong one for "132% of ___".
 * ------------------------------------------------------------------ */

/** Reads after a percentage: "132% of today's limit". */
const BUDGET_WINDOW_LABELS: Record<BudgetPeriod, string> = {
  session: t("popupBudgetWindowSession"),
  day: t("popupBudgetWindowDay"),
  week: t("popupBudgetWindowWeek"),
  month: t("popupBudgetWindowMonth"),
};

/** Reads after a byte figure on the grant button: "+50 MB today". */
const GRANT_WINDOW_LABELS: Record<BudgetPeriod, string> = {
  session: t("popupGrantWindowSession"),
  day: t("popupGrantWindowDay"),
  week: t("popupGrantWindowWeek"),
  month: t("popupGrantWindowMonth"),
};

/**
 * What `previousTotals` is the window before.
 *
 * Deliberately not "the previous 7 days": with `weekMode: "calendar"` a Wednesday's
 * week is three days long and the comparison window is the three days before it, so
 * naming a length would be wrong in exactly the mode that cares about calendars.
 */
const PREVIOUS_WINDOW_LABELS: Record<Period, string> = {
  session: t("popupPreviousWindowSession"),
  today: t("popupPreviousWindowToday"),
  week: t("popupPreviousWindowWeek"),
  month: t("popupPreviousWindowMonth"),
};

/**
 * Presets rather than a number field.
 *
 * A byte count typed into a 420px panel is a chore, and the three sizes people
 * actually reach for are "enough for a normal day", "enough with some video", and
 * "stop me before a boxset". Anything finer belongs in settings.
 *
 * `label` is a fixed size rather than prose, so it is not a message: it is the value
 * the button writes, and the sentences it appears in are `popupLimitPresetLabel` and
 * `popupLimitPresetTitle`.
 */
const LIMIT_PRESETS: readonly { label: string; bytes: number }[] = [
  { label: "100 MB", bytes: 100_000_000 },
  { label: "500 MB", bytes: 500_000_000 },
  { label: "1 GB", bytes: 1_000_000_000 },
];

/* ------------------------------------------------------------------ *
 * Chart labels
 * ------------------------------------------------------------------ */

const HOUR_BUCKET = /^\d{4}-\d{2}-\d{2}T(\d{2})$/;

function tickFor(bucket: string): string {
  const hour = HOUR_BUCKET.exec(bucket);
  if (hour) return hour[1] ?? "";
  return bucket.slice(8, 10);
}

function labelFor(bucket: string): string {
  const hour = HOUR_BUCKET.exec(bucket);
  if (hour) return `${bucket.slice(0, 10)} ${hour[1]}:00`;
  return bucket;
}

/**
 * Drops hour buckets that have not happened yet.
 *
 * `hourBuckets` returns all 24 keys for today and only the front of the series is
 * trimmed, so at 21:00 the chart drew empty columns for 22 and 23 — an axis
 * claiming two hours of measured nothing in the future. Only trailing *empty*
 * buckets past the current hour go: one with bytes in it means the clock moved, and
 * throwing measured data away to tidy an axis is the wrong trade.
 */
function withoutFutureHours(points: readonly SeriesPoint[]): readonly SeriesPoint[] {
  const first = points[0];
  if (!first || !HOUR_BUCKET.test(first.bucket)) return points;
  const now = hourKey();
  let end = points.length;
  while (end > 1) {
    const point = points[end - 1];
    if (!point || point.bucket <= now || point.down > 0 || point.up > 0) break;
    end -= 1;
  }
  return end === points.length ? points : points.slice(0, end);
}

/* ------------------------------------------------------------------ *
 * Headline, plan and projection
 * ------------------------------------------------------------------ */

function renderHeadline(payload: OverviewPayload): void {
  const plan = payload.settings.planBytes;

  // `planBytes` of null means no plan set, which is not a plan of zero: rendering it
  // as "0 B", 0% or 100% would put someone who has simply never answered the question
  // into an over-budget state.
  if (plan === null || cycleUsed === null) {
    const split = splitBytes(totalBytes(payload.totals), units);
    totalValue.textContent = split.value;
    totalUnit.textContent = split.unit;
    planBlock.hidden = true;
    planCta.hidden = plan !== null;
    return;
  }

  const used = splitBytes(cycleUsed, units);
  const cap = splitBytes(plan, units);
  // "4.2 of 15 GB" when both land on the same unit, "820 MB of 15 GB" when they do
  // not — a bare "820 of 15 GB" would be off by three orders of magnitude.
  totalValue.textContent = used.unit === cap.unit ? used.value : `${used.value} ${used.unit}`;
  totalUnit.textContent = t("popupHeadlineOf", `${cap.value} ${cap.unit}`);
  planCta.hidden = true;
  planBlock.hidden = false;

  const { elapsedDays, totalDays } = cycleElapsed(payload.settings);
  const resetsAt = cycleResetsAt(payload.settings);
  const share = cycleUsed / plan;
  const pace = Math.min(1, elapsedDays / totalDays);

  planMeterFill.style.width = `${Math.min(100, Math.max(1, share * 100)).toFixed(1)}%`;
  setData(planMeterFill, "data-over", share >= 1 ? "true" : null);
  // Held off the right edge: the meter clips its overflow, so a mark at exactly 100%
  // is two pixels of nothing on the last day of every cycle.
  planMeterPace.style.left = `${Math.min(99.5, pace * 100).toFixed(1)}%`;
  planMeter.setAttribute("aria-valuenow", String(Math.round(Math.min(100, share * 100))));
  planMeter.setAttribute(
    "aria-valuetext",
    t("popupPlanMeterValueText", [
      bytes(cycleUsed),
      bytes(plan),
      formatPercent(share),
      String(elapsedDays),
      String(totalDays),
    ]),
  );
  planMeter.title = t("popupPlanMeterTitle", formatPercent(pace));
  planLine.textContent = t("popupPlanLine", [
    String(elapsedDays),
    String(totalDays),
    formatAgo(resetsAt),
  ]);
}

/**
 * The pace verdict, from the window before this one.
 *
 * Suppressed on a zero rather than divided by it. `previousTotals` is zero both for
 * `session` and for a profile with no history that far back, and the two are
 * indistinguishable from here — "∞% more" is not a result, and neither is a
 * confident "100% more" against a window that was never recorded.
 */
function renderPace(payload: OverviewPayload): void {
  const previous = totalBytes(payload.previousTotals);
  if (previous <= 0) {
    paceLine.hidden = true;
    return;
  }
  const delta = totalBytes(payload.totals) / previous - 1;
  const against = PREVIOUS_WINDOW_LABELS[payload.period];
  paceLine.hidden = false;
  paceLine.title = t("popupPaceTitle", [bytes(totalBytes(payload.totals)), bytes(previous)]);
  // Under a twentieth either way is noise dressed up as a finding, and a popup that
  // reports "3% more than yesterday" every day teaches people to ignore the line.
  if (Math.abs(delta) < 0.05) {
    setData(paceLine, "data-tone", null);
    paceLine.textContent = t("popupPaceSame", against);
    return;
  }
  setData(paceLine, "data-tone", delta > 0 ? "up" : "down");
  // Two whole sentences rather than one with "more"/"less" substituted in. A
  // comparative is not a noun that can be dropped into a slot: substituting it forces
  // every translation to keep English word order, which is the bug this wave exists
  // to remove.
  paceLine.textContent = t(delta > 0 ? "popupPaceMore" : "popupPaceLess", [
    formatPercent(Math.abs(delta)),
    against,
  ]);
}

/**
 * Shown only when a plan size is recorded and nothing is tracking an allowance for it.
 *
 * `settings.planBytes` produces no alert on its own, ever: alerting is driven from
 * the governor's live allowance figures, so a plan with no `#all` budget behind it is
 * a number that watches nothing. The consequence of fixing that is real — a limit
 * over everything sheds video at 60% — so the copy states it and the user presses the
 * button or does not.
 */
function renderPlanAlerts(payload: OverviewPayload): void {
  const plan = payload.settings.planBytes;
  if (plan === null || statuses.some((status) => status.budget.site === ALL_SITES)) {
    planAlerts.hidden = true;
    return;
  }
  planAlerts.hidden = false;
  planAlertsHint.textContent = t("popupPlanAlertsHint", bytes(plan));
}

function renderProjection(payload: OverviewPayload): void {
  const projection = payload.projection;
  // `null` is no plan, or day one of the cycle. There is no honest sentence to write
  // about a cycle whose only number is a few hours old, so nothing is written.
  if (!projection) {
    projectionCard.hidden = true;
    return;
  }
  projectionCard.hidden = false;
  // Composed in the worker by `core/forecast.ts` and shipped as prose, so it arrives
  // already built and passes straight through. It is the one user-visible sentence on
  // this surface that is not a message here.
  projectionBasis.textContent = projection.basis;

  // Too few finished days for the rate to mean anything. `basis` already says so in
  // full and stands alone; printing the figure beside it would be the extrapolation
  // the flag exists to withhold.
  if (!projection.confident) {
    projectionFigure.hidden = true;
    return;
  }

  const endsOn = formatDayShort(dayKeyFromMs(cycleResetsAt(payload.settings) - 1));
  // The middle dots stay in code because the clause between them is a coloured span,
  // not text: over-plan and spare are the same sentence in two tones, and merging the
  // three into one message would cost the colour that distinguishes them.
  const parts: Child[] = [
    t("popupProjectionFigure", [bytes(projection.projected), endsOn]),
    " · ",
  ];
  parts.push(
    projection.overBy > 0
      ? element("span", {
          className: "projection-over",
          text: t("popupProjectionOver", bytes(projection.overBy)),
        })
      : element("span", {
          className: "projection-spare",
          text: t("popupProjectionSpare", bytes(projection.planBytes - projection.projected)),
        }),
  );
  if (projection.exhaustedOn !== null) {
    // Past and future are two messages, not one with the verb substituted: a tense is
    // not a noun, and a translation that has to receive one through a slot is stuck
    // with English word order.
    const key =
      projection.exhaustedOn <= Date.now() ? "popupProjectionRanOut" : "popupProjectionRunsOut";
    parts.push(` · ${t(key, formatAgo(projection.exhaustedOn))}`);
  }
  projectionFigure.hidden = false;
  replaceChildren(projectionFigure, parts);
}

/* ------------------------------------------------------------------ *
 * Meta line
 * ------------------------------------------------------------------ */

const MEASURED_TITLE = t("popupMeasuredTitle");

/**
 * How much of the figure was measured, in bands.
 *
 * It used to read "Measured directly" and flip to "90% measured · the rest is
 * estimated" the moment a rounding error crossed 90% — a sentence that changed
 * character on a tenth of a percent and said nothing to anyone who had not read the
 * README. Wide bands cannot flicker, and only the band that is actually a caveat
 * gets the estimate colour.
 */
function measuredNote(totals: OverviewPayload["totals"]): HTMLElement {
  if (totals.down <= 0) return element("span", { text: t("popupMeasuredNone"), title: MEASURED_TITLE });
  const share = measuredShare(totals);
  if (share >= 0.97) return element("span", { text: t("popupMeasuredAll"), title: MEASURED_TITLE });
  if (share >= 0.8) return element("span", { text: t("popupMeasuredNearlyAll"), title: MEASURED_TITLE });
  return element("span", {
    className: "meta-flag",
    text: t("popupMeasuredEstimatedShare", formatPercent(1 - share)),
    title: MEASURED_TITLE,
  });
}

function renderMeta(payload: OverviewPayload): void {
  // `description` names the window and is composed in the worker, so it arrives as
  // prose and passes through rather than being looked up here.
  const parts: HTMLElement[] = [element("span", { text: formatPeriodDescription(payload.description) })];

  // With a plan the headline belongs to the cycle, so the period figure the tabs
  // above actually control has to be printed somewhere or the tabs move nothing
  // visible but the chart.
  if (payload.settings.planBytes !== null) {
    parts.push(
      element("span", { className: "meta-figure", text: bytes(totalBytes(payload.totals)) }),
    );
  }

  parts.push(measuredNote(payload.totals));

  if (payload.totals.cacheAvoided > 0) {
    parts.push(
      element("span", {
        text: t("popupCacheSaved", bytes(payload.totals.cacheAvoided)),
        title: t("popupCacheSavedTitle"),
      }),
    );
  }

  // Past ten seconds the payload is described rather than presented as live. The poll
  // keeps the last figures on screen while one is in flight or has failed, and a
  // worker torn down after an idle gap makes a failed poll ordinary — so "these
  // numbers are a minute old" is a thing this surface has to be able to say.
  if (Date.now() - payload.generatedAt > STALE_MS) {
    parts.push(
      element("span", {
        className: "meta-flag",
        text: t("popupReadAgo", formatAgo(payload.generatedAt)),
        title: t("popupStaleTitle"),
      }),
    );
  }

  // Same guard as the chart, derived from the rendered text so the staleness phrase
  // still moves from "a minute ago" to "2 minutes ago" on its own. Nothing here is
  // focusable, but a virtual cursor parked on this line would otherwise be reset
  // thirty times a minute on a tab that is not loading anything.
  const signature = parts.map((part) => part.textContent ?? "").join("|");
  if (signature === lastMetaSignature) return;
  lastMetaSignature = signature;
  replaceChildren(metaLine, parts);
}

/* ------------------------------------------------------------------ *
 * Charts
 * ------------------------------------------------------------------ */

/**
 * Names the second band inside each bar.
 *
 * Saved bytes were *prevented*, so a band drawn inside the transferred total would
 * otherwise read as "part of this total was saved", which is false — and the figure
 * is part measured (a rewrite whose original is on file) and part modelled (the
 * estimator's price for a request that was never sent). The label says both.
 */
const OVERLAY_LABEL = t("popupOverlayLabel");

function renderChart(payload: OverviewPayload): void {
  const series = withoutFutureHours(payload.series);
  const signature = `${units}|${formatPeriodDescription(payload.description)}|${series
    .map((point) => `${point.bucket}:${point.down + point.up}:${point.saved}`)
    .join(",")}`;
  // Rebuilding an identical chart every two seconds costs a screen reader the table
  // it was reading and gains nothing, so the numbers decide when it is redrawn.
  if (signature === lastChartSignature) return;
  lastChartSignature = signature;

  if (series.length === 0) {
    replaceChildren(chartSlot, [
      element("p", { className: "stack-note", text: t("popupChartEmpty") }),
    ]);
    chartNote.textContent = "";
    return;
  }

  const points: BarPoint[] = series.map((point) => ({
    key: point.bucket,
    value: point.down + point.up,
    tick: tickFor(point.bucket),
    label: labelFor(point.bucket),
    overlay: point.saved,
  }));
  const peak = points.reduce((max, point) => Math.max(max, point.value), 0);
  chartNote.textContent = peak > 0 ? t("popupChartPeak", bytes(peak)) : "";
  replaceChildren(chartSlot, [
    barChart({
      points,
      format: (value) => bytes(value),
      caption: formatPeriodDescription(payload.description),
      tickEvery: points.length > 16 ? Math.ceil(points.length / 8) : 1,
      overlayLabel: OVERLAY_LABEL,
    }),
  ]);
}

function renderTypes(payload: OverviewPayload): void {
  const entries = sortTypeBytes(payload.byType);
  const signature = `${units}|${entries.map(([type, value]) => `${type}:${value}`).join(",")}`;
  if (signature === lastTypesSignature) return;
  lastTypesSignature = signature;

  const segments: StackSegment[] = entries.map(([type, value]) => ({
    key: type,
    label: RESOURCE_TYPE_LABELS[type],
    value,
    hue: RESOURCE_TYPE_HUES[type],
  }));
  replaceChildren(typesSlot, [
    stackedBar({
      segments,
      format: (value) => bytes(value),
      minShare: 0.04,
      caption: t("popupTypesCaption"),
    }),
  ]);
}

/* ------------------------------------------------------------------ *
 * Sites
 * ------------------------------------------------------------------ */

/**
 * The parts of a site row a re-render writes to.
 *
 * The name and the icon are not among them: a row is keyed by site, so the one thing
 * about it that cannot change is which site it is. Holding a reference to a node
 * nothing updates would suggest otherwise.
 */
interface SiteRowNodes {
  li: HTMLLIElement;
  row: HTMLButtonElement;
  tag: HTMLSpanElement;
  fill: HTMLSpanElement;
  figure: HTMLSpanElement;
  share: HTMLSpanElement;
}

const siteRows = new Map<string, SiteRowNodes>();

function createSiteRow(site: string): SiteRowNodes {
  const reserved = isReservedSite(site);
  const row = button("site-row", {
    onClick: () => openDashboard(reserved ? undefined : site),
  });
  const icon = element("img", { className: "site-icon" });
  icon.width = 20;
  icon.height = 20;
  icon.alt = "";
  if (!reserved) icon.src = faviconUrl(`https://${site}/`);

  const name = element("span", {
    className: "site-name",
    text: siteLabel(site),
    dataset: reserved ? { reserved: "true" } : {},
  });
  const tag = element("span", { className: "site-tag", text: t("popupSiteTagCurrent") });
  tag.hidden = true;
  const fill = element("span", { className: "site-bar-fill" });
  const figure = element("span", { className: "site-bytes" });
  const share = element("span", { className: "site-share" });

  row.append(
    icon,
    element("span", { className: "site-main" }, [
      element("span", { className: "site-heading" }, [name, tag]),
      element("span", { className: "site-bar", ariaHidden: true }, [fill]),
    ]),
    element("span", { className: "site-figures" }, [figure, share]),
  );

  return { li: element("li", {}, [row]), row, tag, fill, figure, share };
}

function updateSiteRow(
  nodes: SiteRowNodes,
  entry: SiteUsage,
  peak: number,
  periodTotal: number,
  isCurrent: boolean,
): void {
  const own = totalBytes(entry.totals);
  const reserved = isReservedSite(entry.site);
  const name = siteLabel(entry.site);
  const estimated = entry.totals.down > 0 && measuredShare(entry.totals) < 0.75;

  nodes.tag.hidden = !isCurrent;
  if (isCurrent) nodes.row.setAttribute("aria-current", "true");
  else nodes.row.removeAttribute("aria-current");
  nodes.row.title = reserved ? t("popupSiteReservedTitle") : t("popupSiteOpenTitle", name);
  nodes.fill.style.width = `${peak > 0 ? Math.max(2, (own / peak) * 100) : 0}%`;
  nodes.figure.textContent = bytes(own);
  nodes.share.className = estimated ? "site-share site-estimate" : "site-share";
  // The caveat is part of a whole sentence rather than a suffix bolted onto the
  // share, because a translation has to be free to put it in front.
  nodes.share.textContent = t(
    estimated ? "popupSiteShareEstimated" : "popupSiteShare",
    formatPercent(periodTotal > 0 ? own / periodTotal : 0),
  );
}

/**
 * The rows to show: the heaviest sites, plus the tab you are on wherever it ranks.
 *
 * Pinning the current site is what let the separate "current site" card go. That card
 * restated the whole surface on a one-site profile — same name, same bytes, same
 * share, twice — and cost a full card of height on every other one.
 */
function pickSites(sites: readonly SiteUsage[], current: string | null, limit: number): SiteUsage[] {
  const shown = sites.slice(0, limit);
  if (current && !shown.some((entry) => entry.site === current)) {
    const pinned = sites.find((entry) => entry.site === current);
    if (pinned) shown.push(pinned);
  }
  return shown;
}

function renderSites(payload: OverviewPayload): void {
  const current = payload.current.site;
  const shown = pickSites(payload.sites, current, siteLimit);
  const peak = shown.reduce((max, entry) => Math.max(max, totalBytes(entry.totals)), 0);
  const periodTotal = totalBytes(payload.totals);
  const count = payload.sites.length;

  // Two whole messages rather than a count with a noun appended: Chrome's message
  // format has no plural rules, so the singular and the plural are separate strings
  // and the choice between them is made here.
  sitesNote.textContent =
    count > 0
      ? t(count === 1 ? "popupSitesCountOne" : "popupSitesCountOther", formatCount(count))
      : "";

  if (count > shown.length) {
    sitesExpand.hidden = false;
    // A silent truncation at 6 of 40 is the popup deciding the other 34 do not exist.
    sitesExpand.textContent = t(
      siteLimit < SITE_ROWS_EXPANDED ? "popupSitesShowAll" : "popupSitesSeeAll",
      formatCount(count),
    );
  } else {
    sitesExpand.hidden = true;
  }

  // Structural changes are skipped while the keyboard is inside the list: creating,
  // removing or reordering a row means detaching a node, and detaching the node that
  // has focus drops focus to <body>. Text, bars and figures still update, so what is
  // on screen stays true; the list settles the moment focus leaves.
  const focusInside = siteList.contains(document.activeElement);

  for (const entry of shown) {
    let nodes = siteRows.get(entry.site);
    if (!nodes) {
      if (focusInside) continue;
      nodes = createSiteRow(entry.site);
      siteRows.set(entry.site, nodes);
    }
    updateSiteRow(nodes, entry, peak, periodTotal, entry.site === current);
  }

  if (focusInside) return;

  // Reordering is skipped when the order has not changed, because `append` on already
  // connected nodes detaches and re-inserts every one of them — which resets the
  // list's scroll position on a list long enough to have one. `|` cannot occur in a
  // hostname or in a reserved `#` key, so two different lists cannot join to one
  // string.
  const order = shown.map((entry) => entry.site).join("|");
  if (order === lastSiteOrder) return;
  lastSiteOrder = order;

  const wanted = new Set(shown.map((entry) => entry.site));
  for (const [site, nodes] of siteRows) {
    if (wanted.has(site)) continue;
    nodes.li.remove();
    siteRows.delete(site);
  }

  const ordered: HTMLLIElement[] = [];
  for (const entry of shown) {
    const nodes = siteRows.get(entry.site);
    if (nodes) ordered.push(nodes.li);
  }
  siteList.append(...ordered);
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

function openPage(page: "dashboard.html" | "settings.html", site?: string, section?: string): void {
  const url = new URL(chrome.runtime.getURL(page));
  if (site) url.hash = `site=${encodeURIComponent(site)}`;
  else if (section) url.hash = section;
  void chrome.tabs.create({ url: url.toString() });
  window.close();
}

function openDashboard(site?: string): void {
  openPage("dashboard.html", site);
}

function openSettings(section?: string): void {
  openPage("settings.html", undefined, section);
}

/* ------------------------------------------------------------------ *
 * The limit card
 * ------------------------------------------------------------------ */

/**
 * Which limit is actually biting on this tab.
 *
 * A site can be under two at once — its own and the one over everything — and only
 * the stricter of the two is doing anything. Naming the wrong one is worse than
 * naming neither: being cut off by a limit you cannot identify is the worst version
 * of this feature, and "132% of today's limit" beside a site that is at 4% of its own
 * is exactly that.
 */
function governingLimit(site: string | null): {
  primary: BudgetStatus | null;
  secondary: BudgetStatus | null;
} {
  const own = site ? (statuses.find((status) => status.budget.site === site) ?? null) : null;
  const all = statuses.find((status) => status.budget.site === ALL_SITES) ?? null;
  if (!own) return { primary: all, secondary: null };
  if (!all) return { primary: own, secondary: null };
  const allBites =
    TIERS.indexOf(all.tier) > TIERS.indexOf(own.tier) ||
    (all.tier === own.tier && all.share > own.share);
  return allBites ? { primary: all, secondary: own } : { primary: own, secondary: all };
}

/** The user's status, not the mechanism. Nothing in `TIER_LABELS` says "over". */
function statusWord(status: BudgetStatus): string {
  if (status.snoozed) {
    const until = status.budget.snoozedUntil;
    return until ? t("popupLimitPausedUntil", formatAgo(until)) : t("popupLimitPaused");
  }
  if (status.share >= 1) return t("popupLimitOver");
  if (status.share >= 0.85) return t("popupLimitNearlyFull");
  return t("popupLimitWithin");
}

const GRANT_MIN = 5_000_000;
const GRANT_MAX = 500_000_000;

/** Snaps to 1, 2 or 5 times a power of ten, so a button offers "+50 MB" and not "+47.3 MB". */
function roundPresentable(value: number): number {
  if (!(value > 0)) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const candidates = [1, 2, 5, 10].map((step) => step * magnitude);
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best,
  );
}

/**
 * How much a grant is worth, derived from the allowance rather than hard-coded.
 *
 * "+25 MB today" was a fixed figure against a grant that credits whatever window the
 * budget runs on. Against the 800 kB budget in the screenshots one tap multiplied the
 * allowance by thirty-two and effectively deleted the limit; against 10 GB a month it
 * was a quarter of one percent and did nothing. A quarter of the allowance is the same
 * gesture at both ends, and the floor and ceiling keep it from being either pointless
 * or a byte-count typing exercise.
 */
function grantSize(allowance: number): number {
  const quarter = Math.min(GRANT_MAX, Math.max(GRANT_MIN, allowance * 0.25));
  return Math.min(GRANT_MAX, Math.max(GRANT_MIN, roundPresentable(quarter)));
}

function showLimitStatus(status: BudgetStatus, payload: OverviewPayload): void {
  const isAll = status.budget.site === ALL_SITES;
  const over = status.share >= 1;

  setData(limitScope, "data-scope", isAll ? "all" : "site");
  // The label comes from `core/types.ts`, which is where every surface reads it, so it
  // is localised there rather than here. The fallback is unreachable while that record
  // has an `#all` entry and is left English deliberately: a second copy of the word in
  // a message catalogue would be a second thing to keep in step.
  limitScope.textContent = isAll
    ? t("popupLimitScopeAll", RESERVED_SITE_LABELS[ALL_SITES] ?? "Everything")
    : status.budget.site;

  limitStatus.hidden = false;
  limitStatus.textContent = statusWord(status);
  setData(limitStatus, "data-tone", status.snoozed ? "paused" : over ? "over" : null);
  setData(
    limitCard,
    "data-state",
    status.snoozed ? "paused" : over ? "over" : status.share >= 0.85 ? "near" : "within",
  );

  limitLine.hidden = false;
  // One message, not three fragments joined on a middle dot. "1.1 MB of 800 kB · 132%
  // of today's limit · resets in 3 hours" is a sentence, and a translator handed its
  // three pieces separately cannot reorder them or change the punctuation between
  // them. The two reset endings are two whole messages for the same reason.
  const limitFigures = [
    bytes(status.used),
    bytes(status.allowance),
    formatPercent(status.share),
    BUDGET_WINDOW_LABELS[status.budget.period],
  ];
  limitLine.textContent = status.resetsAt
    ? t("popupLimitLine", [...limitFigures, formatAgo(status.resetsAt)])
    : t("popupLimitLineUntilClose", limitFigures);

  limitBar.hidden = false;
  limitBarFill.style.width = `${Math.min(100, Math.max(1, status.share * 100)).toFixed(1)}%`;
  setData(limitBarFill, "data-over", over ? "true" : null);

  // The tier is a consequence, not a status: "Page shell only" told someone the name
  // of a setting when what they needed was the sentence underneath it.
  limitConsequence.hidden = false;
  limitConsequence.textContent = status.snoozed
    ? t("popupLimitPausedConsequence", TIER_DESCRIPTIONS[status.wouldBe])
    : TIER_DESCRIPTIONS[status.tier];

  // The bytes a limit prevented, which used to be printed inside the "Data Saver on"
  // row and therefore vanished when Data Saver was off — a budget doing all the work
  // got no credit anywhere. `savedMeasured` is the part resting on an observed
  // original, which only a rewrite produces, so it is the optimizer's; the remainder
  // is the estimator pricing requests that were never sent, which is what a limit
  // does. Hence the tilde and the estimate colour.
  const totals = isAll ? payload.totals : payload.current.totals;
  const modelled = Math.max(0, totals.saved - totals.savedMeasured);
  if (status.tier !== "off" && modelled > 0) {
    limitPrevented.hidden = false;
    limitPrevented.textContent = t("popupLimitPrevented", bytes(modelled));
    limitPrevented.title = t("popupLimitPreventedTitle", formatPeriodDescription(payload.description));
  } else {
    limitPrevented.hidden = true;
  }

  limitActions.hidden = false;
  const grant = grantSize(status.allowance);
  // Not `window`: this module runs in a document and shadowing the DOM global with a
  // string is the kind of thing that reads as a mistake three edits later.
  const windowLabel = GRANT_WINDOW_LABELS[status.budget.period];
  limitGrant.textContent = t("popupLimitGrant", [bytes(grant), windowLabel]);
  limitGrant.title = t("popupLimitGrantTitle", [
    windowLabel,
    bytes(status.allowance),
    bytes(status.allowance + grant),
  ]);
  limitPause.textContent = t(status.snoozed ? "popupLimitResume" : "popupLimitPause");
  limitPause.title = t(status.snoozed ? "popupLimitResumeTitle" : "popupLimitPauseTitle");
  if (!removeArmed) limitRemove.textContent = t("popupLimitRemove");
  setData(limitRemove, "data-danger", "true");
  limitRemove.title = t("popupLimitRemoveTitle", siteLabel(status.budget.site));
}

function renderLimit(payload: OverviewPayload, primary: BudgetStatus | null, secondary: BudgetStatus | null): void {
  const site = payload.current.site;

  // Always rendered, on every page. On a new tab, a PDF or a chrome:// page three
  // cards used to disappear together and "Manage limits" went with them, so the one
  // route from the popup into settings existed only on pages that already had a limit.
  limitCard.hidden = false;

  if (actingOn?.budget.site !== primary?.budget.site) disarmRemove();
  actingOn = primary;

  if (primary) {
    limitNote.hidden = true;
    limitPresets.hidden = true;
    showLimitStatus(primary, payload);
  } else {
    setData(limitCard, "data-state", null);
    setData(limitScope, "data-scope", "site");
    limitScope.textContent = site ?? "";
    limitStatus.hidden = true;
    limitLine.hidden = true;
    limitBar.hidden = true;
    limitConsequence.hidden = true;
    limitPrevented.hidden = true;
    limitActions.hidden = true;
    limitNote.hidden = false;
    limitPresets.hidden = !site;
    limitNote.textContent = site ? t("popupNoLimitOnSite", site) : t("popupNoLimitHere");
  }

  if (secondary) {
    limitAlso.hidden = false;
    limitAlso.textContent = t("popupLimitAlso", [
      formatPercent(secondary.share),
      BUDGET_WINDOW_LABELS[secondary.budget.period],
      siteLabel(secondary.budget.site),
    ]);
  } else {
    limitAlso.hidden = true;
  }
}

/* ------------------------------------------------------------------ *
 * The optimizer row
 * ------------------------------------------------------------------ */

function renderOptimize(payload: OverviewPayload, biting: boolean): void {
  const site = payload.current.site;
  // Suppressed while a limit is biting. The pitch used to sit directly above
  // "1.1 MB of 800 kB · 132%", selling an optimizer to someone whose page was already
  // being cut off by enforcement they set themselves.
  if (!site || !optimize || biting) {
    optimizeRow.hidden = true;
    return;
  }

  if (!optimize.enabled) {
    if (optimizeDismissed) {
      optimizeRow.hidden = true;
      return;
    }
    optimizeRow.hidden = false;
    optimizeRow.dataset.active = "false";
    optimizeCheck.hidden = true;
    optimizeCopy.htmlFor = "";
    optimizeMeasured.hidden = true;
    optimizeDismissButton.hidden = false;
    optimizeTitle.textContent = t("popupOptimizeOffTitle");
    optimizeHint.textContent = t("popupOptimizeOffHint");
    optimizeAction.textContent = t("popupOptimizeTurnOn");
    optimizeAction.title = t("popupOptimizeTurnOnTitle");
    return;
  }

  const excluded = optimize.exclusions.includes(site);
  const active = !excluded;
  optimizeRow.hidden = false;
  optimizeRow.dataset.active = String(active);
  optimizeCheck.hidden = false;
  optimizeCheck.checked = active;
  optimizeCopy.htmlFor = "optimize-site";
  optimizeDismissButton.hidden = true;
  optimizeTitle.textContent = t(active ? "popupOptimizeOnForSite" : "popupOptimizeOffForSite", site);
  optimizeHint.textContent = t(active ? "popupOptimizeActiveHint" : "popupOptimizeExcludedHint");
  // The global switch it just flipped could not be flipped back from the popup: once
  // enabled, this row only ever rendered the per-site tick. "Off everywhere" rather
  // than "Turn off", because the tick two centimetres to its left also turns
  // something off and the two are not the same thing.
  optimizeAction.textContent = t("popupOptimizeOffEverywhere");
  optimizeAction.title = t("popupOptimizeOffEverywhereTitle");

  // Only what an optimizer earned, and only per site. The delta is the strongest
  // number this product has — a difference between two sets of real page loads — so
  // it is preferred; `savedMeasured` is the fallback and is also arithmetic, being the
  // observed size of an original variant minus what the rewritten one cost. Neither
  // gets a tilde, because neither is a model's output.
  const delta = savings?.deltas.find((entry) => entry.site === site) ?? null;
  if (active && delta) {
    optimizeMeasured.hidden = false;
    optimizeMeasured.textContent = t("popupOptimizeMeasuredDelta", [
      bytes(delta.savedPerVisit),
      bytes(delta.savedPerVisitSpread),
    ]);
    optimizeMeasured.title = t("popupOptimizeMeasuredDeltaTitle", [
      formatCount(delta.optimizedCount),
      formatCount(delta.controlCount),
      String(SAVINGS_DAYS),
    ]);
  } else if (active && payload.current.totals.savedMeasured > 0) {
    optimizeMeasured.hidden = false;
    optimizeMeasured.textContent = t(
      "popupOptimizeMeasuredHere",
      bytes(payload.current.totals.savedMeasured),
    );
    optimizeMeasured.title = t("popupOptimizeMeasuredHereTitle", formatPeriodDescription(payload.description));
  } else {
    optimizeMeasured.hidden = true;
  }
}

/* ------------------------------------------------------------------ *
 * Painting
 * ------------------------------------------------------------------ */

function paint(): void {
  const payload = overview;
  if (!payload) return;

  paintGroup(periodTabs, period);
  renderPace(payload);
  renderHeadline(payload);
  renderPlanAlerts(payload);
  renderProjection(payload);
  renderMeta(payload);

  const { primary, secondary } = governingLimit(payload.current.site);
  renderLimit(payload, primary, secondary);
  renderOptimize(payload, Boolean(primary && primary.tier !== "off"));

  // One "nothing here" message rather than three. An empty profile used to get the
  // chart's, the breakdown's and the list's, stacked, saying the same thing.
  const nothing = totalBytes(payload.totals) <= 0 && payload.sites.length === 0;
  chartPanel.hidden = nothing;
  sitesPanel.hidden = nothing;
  emptyState.hidden = !nothing;
  if (nothing) {
    emptyState.textContent = t(
      payload.settings.planBytes === null ? "popupEmptyNoPlan" : "popupEmptyWithPlan",
    );
    return;
  }

  renderChart(payload);
  renderTypes(payload);
  renderSites(payload);
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

function showError(message: string, source: "poll" | "action"): void {
  errorSource = source;
  actionError.hidden = false;
  actionErrorText.textContent = message;
  actionErrorDismiss.textContent = t(
    fastTimer === null && source === "poll" ? "popupErrorTryAgain" : "popupErrorDismiss",
  );
  liveRegion.textContent = message;
}

function clearError(source: "poll" | "action"): void {
  if (errorSource !== source) return;
  errorSource = null;
  actionError.hidden = true;
  actionErrorText.textContent = "";
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

/** The two live reads. Budgets stay on the last known statuses if only that one fails. */
async function loadFast(): Promise<void> {
  const [overviewResult, budgetResult] = await Promise.allSettled([
    sendRequest({ type: "GET_OVERVIEW", period }),
    sendRequest({ type: "GET_BUDGETS" }),
  ]);

  if (budgetResult.status === "fulfilled") statuses = budgetResult.value.statuses;

  if (overviewResult.status === "rejected") {
    pollFailures += 1;
    if (pollFailures >= POLL_FAILURES_STOP) stopPolling();
    // A first failure with nothing on screen yet has to be said immediately: the
    // grace period exists to stop a routine worker wake flashing an error over
    // figures that are still true, and there are no figures to keep here.
    if (pollFailures >= POLL_FAILURES_BANNER || overview === null) {
      showError(errorMessage(overviewResult.reason, t("popupErrorReadUsage")), "poll");
    }
    return;
  }

  pollFailures = 0;
  overview = overviewResult.value;
  settings = overviewResult.value.settings;
  units = settings.units;
  applyTheme(settings.theme);
  clearError("poll");
}

/**
 * Everything that is not a live number.
 *
 * The cycle total comes from the daily series rather than from a budget: budget
 * windows are calendar-anchored and a plan cycle is anchored to `cycleStartDay`, so
 * the two only coincide on a plan that resets on the 1st.
 */
async function loadSlow(): Promise<void> {
  try {
    optimize = (await sendRequest({ type: "GET_OPTIMIZE" })).optimize;
  } catch {
    // Leave the last known settings up rather than blanking the row: a failed read
    // is not evidence that Data Saver changed.
  }

  // Read after the await, not before: on the first load this runs beside `loadFast`,
  // and by now that call has usually supplied the settings this needs.
  const current = settings;
  if (current && current.planBytes !== null) {
    try {
      const { elapsedDays } = cycleElapsed(current);
      const { points } = await sendRequest({ type: "GET_SERIES", days: elapsedDays });
      cycleUsed = points.reduce((sum, point) => sum + point.down + point.up, 0);
    } catch {
      // Keep the previous figure; `renderHeadline` falls back to the period total
      // only while it has never been read at all.
    }
  } else {
    cycleUsed = null;
  }

  // Once per popup, and again after an optimize change. It reads page loads over
  // thirty days, and nothing in it can move between two polls.
  if (!savingsLoaded && optimize?.enabled) {
    try {
      savings = await sendRequest({ type: "GET_SAVINGS", days: SAVINGS_DAYS });
      savingsLoaded = true;
    } catch {
      // The per-site delta is an extra, not the row's reason to exist.
    }
  }
}

async function refresh(): Promise<void> {
  await loadFast();
  paint();
}

async function refreshAll(): Promise<void> {
  await loadFast();
  await loadSlow();
  paint();
}

/** Sends a change and re-reads, reporting failure rather than letting the next poll erase it. */
async function ask(request: Parameters<typeof sendRequest>[0], failure: string): Promise<void> {
  try {
    await sendRequest(request);
    clearError("action");
    await refreshAll();
  } catch (error) {
    showError(errorMessage(error, failure), "action");
  }
}

/* ------------------------------------------------------------------ *
 * Polling
 * ------------------------------------------------------------------ */

function startPolling(): void {
  if (fastTimer === null) fastTimer = setInterval(() => void refresh(), FAST_MS);
  if (slowTimer === null) {
    slowTimer = setInterval(() => {
      void loadSlow().then(paint);
    }, SLOW_MS);
  }
}

function stopPolling(): void {
  if (fastTimer !== null) clearInterval(fastTimer);
  if (slowTimer !== null) clearInterval(slowTimer);
  fastTimer = null;
  slowTimer = null;
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function choosePeriod(value: Period): void {
  period = value;
  // An expansion belongs to the list it was asked for; a different period is a
  // different list.
  siteLimit = SITE_ROWS;
  void chrome.storage.local.set({ [PERIOD_STORAGE_KEY]: value });
  paintGroup(periodTabs, period);
  void refresh();
}

function disarmRemove(): void {
  removeArmed = false;
  // Also resets the label here, not only in `showLimitStatus`: a limit removed from
  // another surface mid-arm leaves the card with no status to render, and a button
  // still reading "Press again to remove" pointing at nothing.
  limitRemove.textContent = t("popupLimitRemove");
  if (removeTimer !== null) {
    clearTimeout(removeTimer);
    removeTimer = null;
  }
}

query<HTMLButtonElement>("#dashboard-button").addEventListener("click", () => openDashboard());
query<HTMLButtonElement>("#settings-button").addEventListener("click", () => openSettings());
query<HTMLButtonElement>("#plan-cta-button").addEventListener("click", () => openSettings("plan-panel"));

query<HTMLButtonElement>("#plan-alerts-button").addEventListener("click", () => {
  const plan = overview?.settings.planBytes;
  if (!plan) return;
  void ask(
    { type: "PUT_BUDGET", site: ALL_SITES, bytes: plan, period: "month", shape: "progressive" },
    t("popupErrorCreateAllLimit"),
  );
});

projectionToggle.addEventListener("click", () => {
  const expanded = projectionBasis.dataset.expanded === "true";
  setData(projectionBasis, "data-expanded", expanded ? null : "true");
  projectionToggle.setAttribute("aria-expanded", String(!expanded));
  projectionToggle.textContent = t(expanded ? "popupProjectionShow" : "popupProjectionShowLess");
});

actionErrorDismiss.addEventListener("click", () => {
  if (fastTimer === null) {
    pollFailures = 0;
    startPolling();
    void refreshAll();
  }
  errorSource = null;
  actionError.hidden = true;
});

limitGrant.addEventListener("click", () => {
  const status = actingOn;
  if (!status) return;
  void ask(
    { type: "GRANT_BYTES", site: status.budget.site, bytes: grantSize(status.allowance) },
    t("popupErrorGrant"),
  );
});

limitPause.addEventListener("click", () => {
  const status = actingOn;
  if (!status) return;
  void ask(
    status.snoozed
      ? { type: "RESUME_BUDGET", site: status.budget.site }
      : { type: "SNOOZE_BUDGET", site: status.budget.site, minutes: 60 },
    t(status.snoozed ? "popupErrorResume" : "popupErrorPause"),
  );
});

/**
 * Two presses, on the one destructive control in the popup.
 *
 * It sat between "Pause 1 hour" and a preset, styled identically, and deleted a limit
 * outright on a single click with no confirmation and no undo — while `[data-danger]`
 * existed in the shared stylesheet with no user. A second press beats `confirm()`
 * here: a modal dialog over a popup is a good way to lose the popup.
 */
limitRemove.addEventListener("click", () => {
  const status = actingOn;
  if (!status) return;
  if (!removeArmed) {
    removeArmed = true;
    limitRemove.textContent = t("popupLimitRemoveArmed");
    liveRegion.textContent = t("popupLimitRemoveConfirm", siteLabel(status.budget.site));
    removeTimer = setTimeout(() => {
      disarmRemove();
      paint();
    }, REMOVE_CONFIRM_MS);
    return;
  }
  disarmRemove();
  void ask({ type: "REMOVE_BUDGET", site: status.budget.site }, t("popupErrorRemove"));
});

query<HTMLButtonElement>("#limit-more").addEventListener("click", () => openSettings("limits-panel"));

optimizeCheck.addEventListener("change", () => {
  const site = overview?.current.site;
  if (!site) return;
  void ask(
    { type: "SET_SITE_OPTIMIZE", site, optimize: optimizeCheck.checked },
    t("popupErrorSiteOptimize"),
  );
});

optimizeAction.addEventListener("click", () => {
  const enabled = optimize?.enabled === true;
  savingsLoaded = false;
  void ask(
    { type: "SAVE_OPTIMIZE", changes: { enabled: !enabled } },
    t("popupErrorOptimize"),
  );
});

optimizeDismissButton.addEventListener("click", () => {
  optimizeDismissed = true;
  void chrome.storage.local.set({ [OPTIMIZE_DISMISSED_KEY]: true });
  optimizeRow.hidden = true;
  liveRegion.textContent = t("popupOptimizeDismissed");
});

sitesExpand.addEventListener("click", () => {
  if (siteLimit < SITE_ROWS_EXPANDED) {
    siteLimit = SITE_ROWS_EXPANDED;
    paint();
    return;
  }
  openDashboard();
});

// A popup is normally torn down rather than hidden, but it is also reachable as a tab
// and can be minimised with the window. Polling a document nobody is looking at wakes
// the worker every two seconds for nothing.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
    return;
  }
  if (pollFailures < POLL_FAILURES_STOP) {
    startPolling();
    void refreshAll();
  }
});

addEventListener("pagehide", stopPolling);

/*
 * Settings can change from the dashboard or the settings tab while this is open.
 * Theme and units are applied at once because they are visible immediately; the plan
 * and the cycle need a re-read, because `paint` renders the worker's copy of
 * `Settings` off the last payload and the cycle total is only fetched on the slow
 * clock — a plan cleared elsewhere would otherwise sit in this headline for 20
 * seconds.
 */
onSettingsChanged((changed) => {
  settings = changed;
  units = changed.units;
  applyTheme(changed.theme);
  void refreshAll();
});

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

async function start(): Promise<void> {
  // Before anything is painted. A screen reader picks its voice and its pronunciation
  // rules from `<html lang>`, and every page here ships `lang="en"` in its markup — true
  // of the only catalogue that exists, and a lie the moment a second one does. Text that
  // is correct and read aloud in the wrong language is worse than text left untranslated.
  applyDocumentLanguage();
  // Theme first, and read straight out of storage rather than asked of the worker.
  // An explicit light or dark choice otherwise waits on a message round trip that may
  // have to wake a service worker, and the popup paints the other theme meanwhile —
  // which is the whole of the flash.
  try {
    const stored = await getSettings();
    settings = stored;
    units = stored.units;
    applyTheme(stored.theme);
  } catch {
    // The overview payload carries the same fields a moment later.
  }

  const local = await chrome.storage.local.get([PERIOD_STORAGE_KEY, OPTIMIZE_DISMISSED_KEY]);
  const saved = local[PERIOD_STORAGE_KEY] as Period | undefined;
  if (saved && (PERIODS as readonly string[]).includes(saved)) period = saved;
  optimizeDismissed = local[OPTIMIZE_DISMISSED_KEY] === true;

  // Once, at startup. `bindGroup` replaces the option elements, so calling it from the
  // render path would destroy the button the user is standing on between one keypress
  // and the next; `paintGroup` in `paint` moves the checked state and the roving
  // tabindex without touching the nodes.
  bindGroup<Period>({
    container: periodTabs,
    options: PERIODS.map((value) => ({ value, label: PERIOD_LABELS[value] })),
    value: period,
    onSelect: choosePeriod,
  });

  // Presets are built once and read the current tab's site at click time, so the poll
  // never has to rebuild them.
  replaceChildren(
    limitPresets,
    LIMIT_PRESETS.map((preset) =>
      button("ghost-button", {
        text: t("popupLimitPresetLabel", preset.label),
        title: t("popupLimitPresetTitle", preset.label),
        onClick: () => {
          const site = overview?.current.site;
          if (!site) return;
          void ask(
            { type: "PUT_BUDGET", site, bytes: preset.bytes, period: "day", shape: "progressive" },
            t("popupErrorSetLimit"),
          );
        },
      }),
    ),
  );

  // Both reads before the first paint. Painting after the fast one alone would show a
  // plan user the period total in the headline and swap it for the cycle figure a
  // moment later, which is a flicker on the one number they opened this for.
  await Promise.all([loadFast(), loadSlow()]);
  app.dataset.state = "ready";
  paint();
  startPolling();
}

void start();

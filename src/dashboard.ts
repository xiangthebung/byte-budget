import "./dashboard.css";
import { barChart, stackedBar, type BarPoint, type StackSegment } from "./core/chart";
import {
  bindGroup,
  button,
  element,
  faviconUrl,
  paintGroup,
  query,
  replaceChildren,
} from "./core/dom";
import { formatAgo, formatBytes, formatCount, formatPercent, splitBytes } from "./core/format";
import {
  errorMessage,
  sendRequest,
  sortTypeBytes,
  type BudgetStatus,
  type ExtensionRequest,
  type OverviewPayload,
  type SavingsReport,
  type SeriesPoint,
  type SiteDetailPayload,
  type SiteUsage,
  type StorageReport,
  type VisitDeltaView,
} from "./core/messages";
import {
  cycleElapsed,
  cycleRange,
  cycleResetsAt,
  dayKeyFromMs,
  formatDayShort,
  formatWeekday,
  startOfDay,
} from "./core/period";
import { applyTheme, onSettingsChanged } from "./core/settings";
import {
  BUDGET_PERIODS,
  BUDGET_PERIOD_LABELS,
  BUDGET_SHAPES,
  BUDGET_SHAPE_LABELS,
  type BudgetPeriod,
  type BudgetShape,
} from "./limit/budgets";
import { TIER_DESCRIPTIONS } from "./limit/tiers";
import { FEATURES_BY_ID, type FeatureId, type OptimizeSettings } from "./optimize/features";
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
  type ResourceType,
  type Settings,
  type TypeBytes,
} from "./core/types";

const RANGE_OPTIONS = [14, 30, 90] as const;
type RangeOption = (typeof RANGE_OPTIONS)[number];
const RANGE_LABELS: Record<RangeOption, string> = {
  14: "2 weeks",
  30: "30 days",
  90: "3 months",
};

/**
 * What the second band inside each bar is.
 *
 * Not "saved". Those bytes were *prevented*, so a band drawn inside the transferred
 * total reads as "part of this total was saved", which is false — the two numbers do
 * not share a denominator. And the figure is part measured subtraction, part size
 * model, so the name has to carry that too or the chart quietly upgrades a guess.
 */
const PREVENTED_LABEL = "prevented, partly estimated";

/** Rows drawn before the list is capped. Every row builds a favicon `<img>`. */
const SITE_LIMIT = 25;

/**
 * Keystrokes are cheap; the list is not.
 *
 * Each row carries a favicon `<img>` and the whole `<ol>` is replaced, so typing
 * "youtube" rebuilt forty images seven times. Long enough to skip the intermediate
 * states of a word, short enough that it still feels like filtering as you type.
 */
const SEARCH_DEBOUNCE_MS = 120;

/**
 * How often an open dashboard asks the worker for fresh figures.
 *
 * It used to refresh only on `visibilitychange`, so a dashboard left visible in a
 * second window never updated at all. Five times slower than the popup's poll,
 * because this surface is usually not the one being watched and because every refresh
 * replaces subtrees a keyboard user may be standing in.
 */
const REFRESH_MS = 10_000;

/**
 * Age past which the figures stop being presented as live.
 *
 * The worker is torn down after an idle gap, so a failed poll is ordinary rather than
 * exceptional. Comfortably above `REFRESH_MS` so a single slow answer does not raise
 * the notice, and well below the point where a stale total would be acted on.
 */
const STALE_AFTER_MS = 30_000;

const periodTabs = query<HTMLDivElement>("#period-tabs");
const rangeTabs = query<HTMLDivElement>("#range-tabs");
const periodDescription = query<HTMLParagraphElement>("#period-description");
const updatedNote = query<HTMLParagraphElement>("#updated-note");
const stats = query<HTMLElement>("#stats");
const projectionBasis = query<HTMLParagraphElement>("#projection-basis");
const trendSlot = query<HTMLDivElement>("#trend-slot");
const typesSlot = query<HTMLDivElement>("#types-slot");
const typesNote = query<HTMLSpanElement>("#types-note");
const siteList = query<HTMLOListElement>("#site-list");
const sitesNote = query<HTMLSpanElement>("#sites-note");
const sitesEmpty = query<HTMLParagraphElement>("#sites-empty");
const siteSearch = query<HTMLInputElement>("#site-search");
const detailPanel = query<HTMLElement>("#detail-panel");
const detailIcon = query<HTMLImageElement>("#detail-icon");
const detailSite = query<HTMLParagraphElement>("#detail-site");
const detailSub = query<HTMLParagraphElement>("#detail-sub");
const detailLimitBlock = query<HTMLDivElement>("#detail-limit-block");
const detailLimitStatus = query<HTMLDivElement>("#detail-limit-status");
const detailLimitControls = query<HTMLDivElement>("#detail-limit-controls");
const detailPeriodTabs = query<HTMLDivElement>("#detail-period");
const detailShapeTabs = query<HTMLDivElement>("#detail-shape");
const detailPresets = query<HTMLDivElement>("#detail-presets");
const detailLimitHint = query<HTMLParagraphElement>("#detail-limit-hint");
const detailSaver = query<HTMLDivElement>("#detail-saver");
const detailAdvice = query<HTMLParagraphElement>("#detail-advice");
const detailHours = query<HTMLDivElement>("#detail-hours");
const detailDays = query<HTMLDivElement>("#detail-days");
const detailTypes = query<HTMLDivElement>("#detail-types");
const detailHostsBody = query<HTMLTableSectionElement>("#detail-hosts tbody");
const detailHostsTable = query<HTMLTableElement>("#detail-hosts");
const detailHostsEmpty = query<HTMLParagraphElement>("#detail-hosts-empty");
const savingsStats = query<HTMLDivElement>("#savings-stats");
const savingsNote = query<HTMLSpanElement>("#savings-note");
const savingsHint = query<HTMLParagraphElement>("#savings-hint");
const savingsCompareNote = query<HTMLParagraphElement>("#savings-compare-note");
const savingsExplainer = query<HTMLParagraphElement>("#savings-explainer");
const savingsTable = query<HTMLTableElement>("#savings-table");
const savingsBody = query<HTMLTableSectionElement>("#savings-table tbody");
const savingsEmpty = query<HTMLParagraphElement>("#savings-empty");
const planNote = query<HTMLSpanElement>("#plan-note");
const planBody = query<HTMLDivElement>("#plan-body");
const storageBody = query<HTMLDivElement>("#storage-body");
const liveRegion = query<HTMLParagraphElement>("#live-region");

let period: Period = "today";
let trendDays: RangeOption = 30;
let units: Settings["units"] = "si";
let overview: OverviewPayload | null = null;
let selectedSite: string | null = null;
let filter = "";
/** Cleared by every new filter, so a search never opens onto forty rows. */
let showAllSites = false;
let searchTimer: number | null = null;

/** Everything the detail panel is currently showing, for the partial re-renders below. */
let detail: SiteDetailPayload | null = null;
let detailBudget: BudgetStatus | null = null;
let detailOptimize: OptimizeSettings | null = null;
let detailError: string | null = null;
let detailPeriod: BudgetPeriod = "day";
let detailShape: BudgetShape = "progressive";
/** The row the panel was opened from, so closing can put focus back on it. */
let returnFocusTo: HTMLElement | null = null;
/** Whether opening the panel pushed a history entry that closing should walk back. */
let pushedDetailEntry = false;

let planError: string | null = null;
let refreshing = false;

function bytes(value: number): string {
  return formatBytes(value, units);
}

function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

function focusWithin(node: Element): boolean {
  const active = document.activeElement;
  return active !== null && node.contains(active);
}

const CONTROL_SELECTOR = "button, input, a[href]";

/**
 * Rebuilds a block the user is standing in without dropping them to `<body>`.
 *
 * Every action in the detail panel replaces the controls that triggered it: pressing
 * Pause rebuilds the row Pause was in, and toggling Data Saver rebuilds the switch.
 * Focus is restored by position rather than by name because which controls exist
 * depends on what the action did — Pause becomes Resume in the same place, and a
 * removed limit takes its whole row with it.
 */
function rerenderKeepingFocus(block: HTMLElement, render: () => void): void {
  const active = document.activeElement;
  const index =
    active instanceof HTMLElement && block.contains(active)
      ? [...block.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)].indexOf(active)
      : -1;
  render();
  if (index < 0) return;
  const controls = block.querySelectorAll<HTMLElement>(CONTROL_SELECTOR);
  const landing = controls[Math.min(index, controls.length - 1)] ?? detailPanel;
  landing.focus({ preventScroll: true });
}

/**
 * Reduced motion is a scripted argument here, not a style.
 *
 * `app.css` neutralises `html { scroll-behavior: smooth }` under the preference, and
 * that override cannot reach the `behavior` passed to `scrollIntoView` — so the one
 * scroll in this file that fires on an ordinary click has to read the query itself.
 */
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
function scrollBehavior(): ScrollBehavior {
  return reducedMotion.matches ? "auto" : "smooth";
}

function announce(message: string): void {
  liveRegion.textContent = message;
}

/* ------------------------------------------------------------------ *
 * Charts and labels
 * ------------------------------------------------------------------ */

const HOUR_BUCKET = /^\d{4}-\d{2}-\d{2}T(\d{2})$/;

/** `7/31` in en-US, `31.7.` in de-DE — short enough for a 46px column either way. */
const MONTH_DAY_NUMERIC = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
});

function tickFor(bucket: string, total: number, spansMonths: boolean): string {
  const hour = HOUR_BUCKET.exec(bucket);
  if (hour) return `${hour[1]}`;
  if (total <= 8) return formatWeekday(bucket);
  // A bare day-of-month repeats every month, so a 90-day chart read "02 05 08" three
  // times over with nothing in the axis to say which month each run belonged to.
  return spansMonths ? MONTH_DAY_NUMERIC.format(startOfDay(bucket)) : bucket.slice(8, 10);
}

function labelFor(bucket: string): string {
  const hour = HOUR_BUCKET.exec(bucket);
  if (hour) return `${formatDayShort(bucket.slice(0, 10))}, ${hour[1]}:00`;
  return formatDayShort(bucket);
}

function typeSegments(byType: TypeBytes): StackSegment[] {
  return sortTypeBytes(byType).map(([type, value]) => ({
    key: type,
    label: RESOURCE_TYPE_LABELS[type],
    value,
    hue: RESOURCE_TYPE_HUES[type],
  }));
}

function pointsFrom(series: readonly SeriesPoint[]): BarPoint[] {
  const first = series[0]?.bucket.slice(0, 7);
  const last = series.at(-1)?.bucket.slice(0, 7);
  const spansMonths = first !== undefined && last !== undefined && first !== last;
  return series.map((point) => ({
    key: point.bucket,
    value: point.down + point.up,
    tick: tickFor(point.bucket, series.length, spansMonths),
    label: labelFor(point.bucket),
    overlay: point.saved,
  }));
}

/**
 * The value axis the chart itself does not draw.
 *
 * `chart.ts` builds bars with percentage heights and no scale, so every chart on this
 * page was a shape with no magnitude: a 40 kB day and a 4 GB day drew the same
 * picture. Three labels — peak, half, zero — are enough to read a height off, and
 * they are hidden from assistive technology because the figure already ships a
 * summary and a full value table, where three numbers would just be noise in front of
 * them.
 */
function chartFrame(figure: HTMLElement, peak: number): HTMLElement {
  return element("div", { className: "chart-frame" }, [
    element(
      "div",
      { className: "chart-axis", ariaHidden: true },
      [peak, peak / 2, 0].map((value) => element("span", { text: bytes(value) })),
    ),
    element("div", { className: "chart-plot" }, [figure]),
  ]);
}

function chartInto(node: HTMLElement, series: readonly SeriesPoint[], caption: string): void {
  if (series.length === 0) {
    replaceChildren(node, [element("p", { className: "stack-note", text: "Nothing recorded." })]);
    return;
  }
  const points = pointsFrom(series);
  const peak = points.reduce((max, point) => Math.max(max, point.value), 0);
  const figure = barChart({
    points,
    format: (value) => bytes(value),
    caption,
    tickEvery: points.length > 16 ? Math.ceil(points.length / 10) : 1,
    overlayLabel: PREVENTED_LABEL,
  });
  replaceChildren(node, [
    element("div", { className: "dashboard-chart" }, [
      peak > 0 ? chartFrame(figure, peak) : figure,
    ]),
  ]);
}

/* ------------------------------------------------------------------ *
 * Single-choice controls
 *
 * All four are bound once, here, and painted from the render paths. `bindGroup`
 * replaces the option elements, so calling it on every render destroys the button the
 * user is standing on between one keypress and the next.
 * ------------------------------------------------------------------ */

/** Short enough for a segment; `BUDGET_PERIOD_LABELS` goes in the tooltip. */
const LIMIT_PERIOD_LABELS: Record<BudgetPeriod, string> = {
  session: "Session",
  day: "Day",
  week: "Week",
  month: "Month",
};

const LIMIT_SHAPE_LABELS: Record<BudgetShape, string> = {
  progressive: "Shed weight",
  hard: "Hard stop",
};

function bindControls(): void {
  bindGroup<Period>({
    container: periodTabs,
    options: PERIODS.map((value) => ({ value, label: PERIOD_LABELS[value] })),
    value: period,
    onSelect: (value) => {
      period = value;
      paintGroup(periodTabs, period);
      void load();
    },
  });

  bindGroup<RangeOption>({
    container: rangeTabs,
    options: RANGE_OPTIONS.map((value) => ({ value, label: RANGE_LABELS[value] })),
    value: trendDays,
    onSelect: (value) => {
      trendDays = value;
      paintGroup(rangeTabs, trendDays);
      // This control also re-scopes the Data Saver results, which are several hundred
      // pixels below the fold from here. Saying so is the difference between a range
      // picker and a number that changed for no visible reason.
      announce(`Daily usage and Data Saver results now cover the last ${RANGE_LABELS[value]}.`);
      void loadTrend();
      void loadSavings();
    },
  });

  bindGroup<BudgetPeriod>({
    container: detailPeriodTabs,
    options: BUDGET_PERIODS.map((value) => ({
      value,
      label: LIMIT_PERIOD_LABELS[value],
      title: BUDGET_PERIOD_LABELS[value],
    })),
    value: detailPeriod,
    onSelect: (value) => {
      detailPeriod = value;
      paintGroup(detailPeriodTabs, value);
      renderDetailLimit();
    },
  });

  bindGroup<BudgetShape>({
    container: detailShapeTabs,
    options: BUDGET_SHAPES.map((value) => ({
      value,
      label: LIMIT_SHAPE_LABELS[value],
      title: BUDGET_SHAPE_LABELS[value],
    })),
    value: detailShape,
    onSelect: (value) => {
      detailShape = value;
      paintGroup(detailShapeTabs, value);
      renderDetailLimit();
    },
  });
}

/* ------------------------------------------------------------------ *
 * Overview
 * ------------------------------------------------------------------ */

interface StatCardOptions {
  unit?: string;
  hint?: string;
  /** Colours the hint alone: "this figure is over the plan" is not "this figure is modelled". */
  hintTone?: "over";
  tone?: "estimate" | "saved";
  pill?: { text: string; title: string; tone?: "estimate" };
  note?: string;
  link?: { text: string; href: string };
}

function statCard(label: string, value: string, options: StatCardOptions = {}): HTMLElement {
  let link: HTMLAnchorElement | undefined;
  if (options.link) {
    link = element("a", { className: "panel-link stat-link", text: options.link.text });
    link.href = options.link.href;
  }

  return element(
    "article",
    { className: "stat", dataset: options.tone ? { tone: options.tone } : {} },
    [
      element("div", { className: "stat-label-row" }, [
        element("p", { className: "stat-label", text: label }),
        options.pill
          ? element("span", {
              className: "stat-pill",
              text: options.pill.text,
              title: options.pill.title,
              dataset: options.pill.tone ? { tone: options.pill.tone } : {},
            })
          : undefined,
      ]),
      element("p", { className: "stat-value" }, [
        value,
        options.unit ? element("span", { className: "unit", text: options.unit }) : undefined,
      ]),
      options.hint
        ? element("p", {
            className: "stat-hint",
            text: options.hint,
            dataset: options.hintTone ? { tone: options.hintTone } : {},
          })
        : undefined,
      options.note ? element("p", { className: "stat-note", text: options.note }) : undefined,
      link,
    ],
  );
}

/** What "the previous window" is, in the words the period control uses. */
function previousWindowLabel(payload: OverviewPayload): string {
  switch (payload.period) {
    case "session":
      return "session";
    case "today":
      return "day";
    case "week":
      return payload.settings.weekMode === "calendar" ? "week" : "7 days";
    case "month":
      return payload.settings.monthMode === "calendar" ? "month" : "30 days";
  }
}

/**
 * "18% less than the previous 30 days", or nothing at all.
 *
 * Suppressed entirely on a zero previous window, because zero is what both "nothing
 * was used then" and "this profile has no history that far back" look like from here,
 * and the two are indistinguishable. It is also always zero for `session`. A ratio
 * against zero is not a result, and "∞% more" is not a way of saying so.
 *
 * Deliberately uncoloured. `--saved` and `--estimate` mean "prevented bytes" and
 * "modelled figure" everywhere else in the product, and neither is what a
 * period-over-period delta is.
 */
function comparisonNote(payload: OverviewPayload): string | undefined {
  const previous = totalBytes(payload.previousTotals);
  if (previous <= 0) return undefined;
  const delta = totalBytes(payload.totals) / previous - 1;
  // Not named `window`: shadowing the DOM global reads as a mistake later, and
  // `forecast.ts` avoids the same collision for the same reason.
  const span = previousWindowLabel(payload);
  if (Math.abs(delta) < 0.005) return `About the same as the previous ${span}`;
  const direction = delta > 0 ? "more" : "less";
  return `${formatPercent(Math.abs(delta))} ${direction} than the previous ${span}`;
}

/**
 * The slot the "Accuracy 100%" card used to hold.
 *
 * Four rules, none of them optional. The word "projected" is always the label; the
 * basis is always rendered (below the row, by `renderProjectionBasis`); an
 * unconfident projection prints no figure at all, because a number extrapolated from
 * three days is astrology with a unit attached; and `null` is a call to action rather
 * than a zero, since no plan set and a plan of zero are different states.
 */
function projectionCard(payload: OverviewPayload): HTMLElement {
  const projection = payload.projection;
  if (!projection) {
    return payload.settings.planBytes === null
      ? statCard("Projected", "No plan", {
          hint: "Nothing to project against yet",
          link: { text: "Set your plan size and reset day", href: "./settings.html" },
        })
      : statCard("Projected", "Not yet", {
          hint: "No day of this cycle has finished",
        });
  }
  if (!projection.confident) {
    return statCard("Projected", "Too early", {
      hint: "Too few finished days to state a figure",
    });
  }
  const split = splitBytes(projection.projected, units);
  const under = Math.max(0, projection.planBytes - projection.projected);
  return statCard("Projected", split.value, {
    unit: split.unit,
    hint:
      projection.overBy > 0
        ? `${bytes(projection.overBy)} over your ${bytes(projection.planBytes)} plan`
        : `${bytes(under)} under your ${bytes(projection.planBytes)} plan`,
    // The value is modelled and wears the token that says so, whatever it says.
    tone: "estimate",
    ...(projection.overBy > 0 ? { hintTone: "over" as const } : {}),
  });
}

function renderProjectionBasis(payload: OverviewPayload): void {
  const projection = payload.projection;
  projectionBasis.hidden = projection === null;
  if (!projection) {
    projectionBasis.textContent = "";
    return;
  }
  const parts = [`Projected — ${projection.basis}`];
  if (projection.exhaustedOn !== null) {
    const day = formatDayShort(dayKeyFromMs(projection.exhaustedOn));
    if (projection.exhaustedOn <= Date.now()) {
      // A crossing in the past was found by walking days that were recorded, so this
      // date is a measurement and survives an unconfident projection.
      parts.push(`The plan was already spent, on ${day}.`);
    } else if (projection.confident) {
      // A crossing ahead is as modelled as the rest, so it goes wherever the figure
      // does — nowhere, while the rate cannot be established.
      parts.push(`At that rate it runs out on ${day}.`);
    }
  }
  projectionBasis.textContent = parts.join(" ");
}

function renderStats(payload: OverviewPayload): void {
  const total = totalBytes(payload.totals);
  const totalSplit = splitBytes(total, units);
  const measured = measuredShare(payload.totals);
  const top = payload.sites[0];
  const topBytes = top ? totalBytes(top.totals) : 0;
  const saved = payload.totals.saved;
  const comparison = comparisonNote(payload);

  replaceChildren(stats, [
    // Accuracy is a near-constant metric about the tool, and it overclaims: the
    // measured share is 1 - estimatedDown/down, which by construction excludes the
    // halved headers, the invisible WebSocket frames and the zero-counted cancelled
    // bodies. It is a qualifier on this number, so it lives on this card as one.
    statCard("Data used", totalSplit.value, {
      unit: totalSplit.unit,
      hint: plural(payload.sites.length, "site", "sites"),
      pill: {
        text: `${formatPercent(measured)} measured`,
        title:
          "Response bodies measured. Header overhead is estimated and halved, WebSocket frames are invisible to an extension, and a cancelled body counts as zero — see How Byte Budget measures usage.",
        ...(measured < 0.9 ? { tone: "estimate" as const } : {}),
      },
      ...(comparison ? { note: comparison } : {}),
    }),
    statCard("Top site", top ? bytes(topBytes) : "–", {
      hint: top
        ? `${siteLabel(top.site)} · ${formatPercent(total > 0 ? topBytes / total : 0)}`
        : "No usage yet",
    }),
    projectionCard(payload),
    // The savings panel's identically-labelled tile is gone; this one keeps the
    // period the rest of the row is on. Tilded, because it is a sum of a measured
    // subtraction and a modelled one — and the hint says how much of it is which,
    // rather than leaving a merged figure to be read as measured.
    statCard("Data prevented", saved > 0 ? `~${bytes(saved)}` : "0 B", {
      hint:
        saved > 0
          ? `${bytes(payload.totals.savedMeasured)} of it measured, the rest modelled`
          : payload.totals.cacheAvoided > 0
            ? `Cache also avoided ~${bytes(payload.totals.cacheAvoided)}`
            : "Turn on Data Saver or add a limit",
      ...(saved > 0 ? { tone: "saved" as const } : {}),
    }),
  ]);
  renderProjectionBasis(payload);
}

/**
 * "Showing figures from 2 minutes ago", or nothing.
 *
 * Hidden while the payload is younger than a poll interval or two. A number that is
 * quietly a minute old is exactly what a measurement tool cannot show without saying
 * so — and after an idle gap the worker is gone, so a failed poll is routine.
 */
function renderFreshness(): void {
  const at = overview?.generatedAt;
  if (at === undefined) {
    updatedNote.hidden = true;
    return;
  }
  const stale = Date.now() - at > STALE_AFTER_MS;
  updatedNote.hidden = !stale;
  if (stale) updatedNote.textContent = `Showing figures from ${formatAgo(at)}.`;
}

/* ------------------------------------------------------------------ *
 * Sites
 * ------------------------------------------------------------------ */

function siteLabel(site: string): string {
  return isReservedSite(site) ? (RESERVED_SITE_LABELS[site] ?? site) : site;
}

/** The site key of the row that currently holds focus, if any. */
function focusedSiteKey(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !siteList.contains(active)) return null;
  return active.closest<HTMLElement>(".site-row")?.dataset.site ?? null;
}

function renderSites(payload: OverviewPayload): void {
  // The refresh poll rebuilds this list. Focus is captured by site key rather than by
  // index so a list that reordered underneath still lands on the row being read,
  // instead of dropping the user to <body> at the top of the document.
  const focused = focusedSiteKey();

  const needle = filter.trim().toLowerCase();
  const matching = needle
    ? payload.sites.filter((entry) => siteLabel(entry.site).toLowerCase().includes(needle))
    : payload.sites;
  const peak = matching.length > 0 ? totalBytes(matching[0]?.totals ?? payload.totals) : 0;
  const shown = showAllSites ? matching : matching.slice(0, SITE_LIMIT);
  const periodTotal = totalBytes(payload.totals);

  sitesNote.textContent = needle
    ? `${formatCount(matching.length)} of ${formatCount(payload.sites.length)}`
    : plural(payload.sites.length, "site", "sites");
  sitesEmpty.hidden = matching.length > 0;

  replaceChildren(siteList, [
    ...shown.map((entry) => element("li", {}, [siteRow(entry, peak, periodTotal)])),
    matching.length > shown.length
      ? element("li", { className: "site-more" }, [
          button("ghost-button", {
            text: `Show all ${formatCount(matching.length)} sites`,
            onClick: () => {
              showAllSites = true;
              if (overview) renderSites(overview);
              // The button that was clicked no longer exists. Land on the first row it
              // revealed rather than on <body>.
              const rows = siteList.querySelectorAll<HTMLButtonElement>(".site-row");
              rows[SITE_LIMIT]?.focus({ preventScroll: true });
            },
          }),
        ])
      : undefined,
  ]);

  if (focused !== null) {
    siteList
      .querySelector<HTMLButtonElement>(`.site-row[data-site="${CSS.escape(focused)}"]`)
      ?.focus({ preventScroll: true });
  }
}

function siteRow(entry: SiteUsage, peak: number, periodTotal: number): HTMLButtonElement {
  const own = totalBytes(entry.totals);
  const reserved = isReservedSite(entry.site);
  const estimated = entry.totals.down > 0 && measuredShare(entry.totals) < 0.75;
  const row = element("button", {
    className: "site-row",
    title: reserved
      ? "Requests that did not belong to a tab: browser services, service workers and other extensions."
      : `Open details for ${entry.site}`,
    dataset: { site: entry.site },
  });
  row.type = "button";
  if (selectedSite === entry.site) row.setAttribute("aria-current", "true");
  row.addEventListener("click", () => void openSite(entry.site, { source: row }));

  const icon = element("img", { className: "site-icon" });
  icon.width = 20;
  icon.height = 20;
  icon.alt = "";
  // Forty rows is forty decodes on a list most of which is below the fold.
  icon.loading = "lazy";
  if (!reserved) icon.src = faviconUrl(`https://${entry.site}/`);

  row.append(
    icon,
    element("span", { className: "site-main" }, [
      element("span", {
        className: "site-name",
        text: siteLabel(entry.site),
        dataset: reserved ? { reserved: "true" } : {},
      }),
      element("span", { className: "site-bar", ariaHidden: true }, [
        element("span", {
          className: "site-bar-fill",
          style: { width: `${peak > 0 ? Math.max(2, (own / peak) * 100) : 0}%` },
        }),
      ]),
    ]),
    element("span", { className: "site-figures" }, [
      element("span", { className: "site-bytes", text: bytes(own) }),
      element("span", {
        className: estimated ? "site-share site-estimate" : "site-share",
        text:
          `${formatPercent(periodTotal > 0 ? own / periodTotal : 0)} of total` +
          (estimated ? " · includes estimates" : ""),
      }),
    ]),
    // The rows have always opened a panel and never looked like it.
    element("span", { className: "site-go", text: "›", ariaHidden: true }),
  );
  return row;
}

/* ------------------------------------------------------------------ *
 * Site detail
 * ------------------------------------------------------------------ */

async function openSite(
  site: string,
  options: { source?: HTMLElement; fromHistory?: boolean } = {},
): Promise<void> {
  const opening = selectedSite === null;
  selectedSite = site;
  if (options.source) returnFocusTo = options.source;

  // Nothing to write when the browser's own history is what moved us here — the URL
  // already says this, and pushing over it would trap Back on the same entry.
  if (!options.fromHistory) {
    const hash = `#site=${encodeURIComponent(site)}`;
    // One history entry for the panel, not one per site. Pushing per site turns Back
    // into a walk through every row the user tried before the panel finally closes.
    if (opening) {
      history.pushState(null, "", hash);
      pushedDetailEntry = true;
    } else {
      history.replaceState(null, "", hash);
    }
  }

  if (overview) renderSites(overview);
  if (!(await loadDetail(site))) return;
  // Announced whether or not the panel is new, because swapping the site inside an
  // already-open panel changes every figure in it and moves nothing on screen.
  announce(`Site details for ${siteLabel(site)}.`);
  if (opening) revealDetail();
}

function revealDetail(): void {
  detailPanel.focus({ preventScroll: true });
  detailPanel.scrollIntoView({ behavior: scrollBehavior(), block: "nearest" });
}

function closeDetail(options: { fromHistory?: boolean } = {}): void {
  if (selectedSite === null) return;
  const hadFocus = focusWithin(detailPanel);
  const back = returnFocusTo;

  selectedSite = null;
  detail = null;
  detailBudget = null;
  detailError = null;
  detailPanel.hidden = true;
  returnFocusTo = null;

  if (options.fromHistory) {
    pushedDetailEntry = false;
  } else if (pushedDetailEntry) {
    pushedDetailEntry = false;
    // Walk the entry back rather than replacing it, so Back does not re-open the
    // panel the Close button just dismissed.
    history.back();
  } else {
    history.replaceState(null, "", location.pathname);
  }

  // The panel is hidden; without this, focus inside it has nowhere to go and Chrome
  // drops the user to <body> at the top of the document.
  if (hadFocus) {
    if (back?.isConnected) back.focus({ preventScroll: true });
    else siteSearch.focus({ preventScroll: true });
  }
  if (overview) renderSites(overview);
}

/** Fetches everything the panel shows. Returns false when nothing could be read. */
async function loadDetail(site: string): Promise<boolean> {
  try {
    const [payload, budgets, optimize] = await Promise.all([
      sendRequest({ type: "GET_SITE", site, period }),
      sendRequest({ type: "GET_BUDGETS" }),
      sendRequest({ type: "GET_OPTIMIZE" }),
    ]);
    detail = payload;
    detailBudget = budgets.statuses.find((status) => status.budget.site === site) ?? null;
    detailOptimize = optimize.optimize;
    detailError = null;
    // A limit already on the site is the window to edit, not whatever was last picked.
    if (detailBudget) {
      detailPeriod = detailBudget.budget.period;
      detailShape = detailBudget.budget.shape;
      paintGroup(detailPeriodTabs, detailPeriod);
      paintGroup(detailShapeTabs, detailShape);
    }
    renderDetail(payload);
    return true;
  } catch (error) {
    announce(errorMessage(error, "Could not read that site."));
    return false;
  }
}

function renderDetail(payload: SiteDetailPayload): void {
  detailPanel.hidden = false;
  const reserved = isReservedSite(payload.site);
  detailIcon.src = reserved ? "" : faviconUrl(`https://${payload.site}/`);
  detailSite.textContent = siteLabel(payload.site);

  const pieces = [`${bytes(totalBytes(payload.totals))} · ${payload.description}`];
  if (measuredShare(payload.totals) < 0.9) pieces.push("Includes some estimates");
  if (payload.visits.count > 0) {
    pieces.push(
      `${plural(payload.visits.count, "page load", "page loads")} · typical ${bytes(payload.visits.medianDown)}`,
    );
  }
  detailSub.textContent = pieces.join(" · ");

  renderDetailLimit();
  renderDetailSaver();

  chartInto(detailHours, payload.hours, "Today by hour");
  chartInto(detailDays, payload.days, "By day");
  replaceChildren(detailTypes, [
    stackedBar({
      segments: typeSegments(payload.byType),
      format: (value) => bytes(value),
      minShare: 0.02,
      caption: "Type of data",
    }),
  ]);

  // Two different absences with two different answers. The empty state used to be
  // tied to `trackHosts` alone, which was permanently true — so a site with no host
  // rows rendered a bare header row and nothing under it.
  const hostsOff = !payload.settings.trackHosts;
  const noHosts = payload.hosts.length === 0;
  detailHostsEmpty.hidden = !(hostsOff || noHosts);
  detailHostsTable.hidden = hostsOff || noHosts;
  detailHostsEmpty.textContent = hostsOff
    ? "Per-host detail is switched off, so nothing was recorded to show here."
    : "No host detail for this period yet.";

  replaceChildren(
    detailHostsBody,
    payload.hosts.slice(0, 25).map((host) =>
      element("tr", {}, [
        element("td", {}, [
          element("span", { className: "host-name", text: host.host, title: host.host }),
          host.thirdParty
            ? element("span", { className: "host-tag", text: "third party" })
            : undefined,
        ]),
        element("td", { className: "numeric", text: bytes(host.down + host.up) }),
        element("td", { className: "numeric", text: formatCount(host.requests) }),
      ]),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Acting on the site in front of you
 * ------------------------------------------------------------------ */

/** The window a share is a share *of*, as a status rather than as a mechanism. */
const LIMIT_WINDOW_LABELS: Record<BudgetPeriod, string> = {
  session: "this session's limit",
  day: "today's limit",
  week: "this week's limit",
  month: "this month's limit",
};

/**
 * Round figures per window, not one hardcoded size.
 *
 * A daily preset offered against a monthly plan is either meaningless or an order of
 * magnitude out, and both call sites in this extension used to send `period: "day"`
 * whatever the person actually wanted.
 */
const LIMIT_PRESETS: Record<BudgetPeriod, readonly number[]> = {
  session: [50_000_000, 200_000_000, 1_000_000_000],
  day: [50_000_000, 200_000_000, 1_000_000_000],
  week: [250_000_000, 1_000_000_000, 5_000_000_000],
  month: [1_000_000_000, 5_000_000_000, 20_000_000_000],
};

function statusWord(share: number): string {
  if (share >= 1) return "Over limit";
  if (share >= 0.85) return "Nearly full";
  return "Within limit";
}

function renderDetailLimit(): void {
  if (!detail) return;
  const site = detail.site;

  // `#background` and `#extensions` are ledger buckets, not origins: there is nothing
  // for a rule's `initiatorDomains` to name, so they cannot carry a limit of their
  // own. Saying which lever does reach them beats hiding the block.
  if (isReservedSite(site)) {
    detailLimitControls.hidden = true;
    replaceChildren(detailPresets, []);
    replaceChildren(detailLimitStatus, [
      element("p", {
        className: "field-hint",
        text: "These requests have no site of their own for a rule to name, so they cannot be limited individually. A limit over Everything covers them along with the rest.",
      }),
    ]);
    detailLimitHint.textContent = "";
    return;
  }

  detailLimitControls.hidden = false;
  const status = detailBudget;

  replaceChildren(detailLimitStatus, [
    detailError
      ? element("p", { className: "form-status", dataset: { tone: "error" }, text: detailError })
      : undefined,
    status ? limitStatusBlock(status) : undefined,
    status
      ? element("div", { className: "detail-presets" }, [
          status.snoozed
            ? button("ghost-button", {
                text: "Resume now",
                onClick: () => void limitAction({ type: "RESUME_BUDGET", site }, "Limit resumed."),
              })
            : button("ghost-button", {
                text: "Pause 1 hour",
                onClick: () =>
                  void limitAction(
                    { type: "SNOOZE_BUDGET", site, minutes: 60 },
                    "Limit paused for an hour.",
                  ),
              }),
          button("ghost-button", {
            text: "Remove limit",
            dataset: { danger: "true" },
            onClick: () => void limitAction({ type: "REMOVE_BUDGET", site }, "Limit removed."),
          }),
        ])
      : element("p", {
          className: "field-hint",
          text: "No limit on this site. A limit refuses requests before they are sent, so the bytes are never spent.",
        }),
  ]);

  replaceChildren(
    detailPresets,
    LIMIT_PRESETS[detailPeriod].map((size) =>
      button("ghost-button", {
        text: bytes(size),
        title: `Limit ${site} to ${bytes(size)} ${BUDGET_PERIOD_LABELS[detailPeriod]} — ${BUDGET_SHAPE_LABELS[detailShape].toLowerCase()}`,
        onClick: () => void applyLimit(site, size),
      }),
    ),
  );

  const consequence =
    detailShape === "hard"
      ? "A hard stop refuses every subresource the moment the allowance runs out. The page's own HTML still loads, so the site can say why it looks broken."
      : "Shedding weight drops video and audio at 60% of the allowance, images and web fonts at 85%, and everything but the page shell at 100%.";
  detailLimitHint.textContent = status
    ? `${consequence} Choosing a size replaces the current limit on this site.`
    : `${consequence} For an exact figure, use the limit form in Settings.`;
}

function limitStatusBlock(status: BudgetStatus): HTMLElement {
  const over = status.share >= 1;
  const resumesAt = status.budget.snoozedUntil;
  const resets =
    status.resetsAt === null
      ? "runs until this browser session ends"
      : `resets ${formatAgo(status.resetsAt)}`;

  return element("div", { className: "limit-status" }, [
    element("div", { className: "limit-status-head" }, [
      element("span", {
        className: "state-chip",
        text: status.snoozed ? "Paused" : statusWord(status.share),
        dataset: status.snoozed ? { tone: "paused" } : over ? { tone: "enforcing" } : {},
      }),
      element("span", {
        className: "limit-status-figure",
        text: `${formatPercent(status.share)} of ${LIMIT_WINDOW_LABELS[status.budget.period]} · ${resets}`,
      }),
    ]),
    element("div", { className: "limit-meter" }, [
      element("span", { className: "limit-meter-track", ariaHidden: true }, [
        element("span", {
          className: "limit-meter-fill",
          style: { width: `${Math.min(100, Math.max(0, status.share * 100))}%` },
          dataset: over ? { over: "true" } : {},
        }),
      ]),
      element("span", {
        className: "panel-note",
        text: `${bytes(status.used)} of ${bytes(status.allowance)}`,
      }),
    ]),
    element("p", {
      className: "field-hint",
      text: status.snoozed
        ? `Nothing is being refused while it is paused${resumesAt ? `; it resumes ${formatAgo(resumesAt)}` : ""}. Without the pause: ${TIER_DESCRIPTIONS[status.wouldBe]}`
        : TIER_DESCRIPTIONS[status.tier],
    }),
  ]);
}

async function applyLimit(site: string, size: number): Promise<void> {
  await limitAction(
    { type: "PUT_BUDGET", site, bytes: size, period: detailPeriod, shape: detailShape },
    `${siteLabel(site)} limited to ${bytes(size)} ${BUDGET_PERIOD_LABELS[detailPeriod]}.`,
  );
}

type LimitRequest = Extract<
  ExtensionRequest,
  { type: "PUT_BUDGET" | "REMOVE_BUDGET" | "SNOOZE_BUDGET" | "RESUME_BUDGET" }
>;

async function limitAction(request: LimitRequest, success: string): Promise<void> {
  try {
    const { statuses } = await sendRequest(request);
    detailBudget = statuses.find((status) => status.budget.site === request.site) ?? null;
    detailError = null;
    announce(success);
  } catch (error) {
    detailError = errorMessage(error, "That did not work.");
    announce(detailError);
  }
  rerenderKeepingFocus(detailLimitBlock, renderDetailLimit);
  // A per-site limit can be the plan's limit, and the plan panel says whether one
  // covering everything exists.
  void loadPlan();
}

function renderDetailSaver(): void {
  if (!detail) return;
  const site = detail.site;
  const settings = detailOptimize;

  if (isReservedSite(site)) {
    replaceChildren(detailSaver, [
      element("p", {
        className: "field-hint",
        text: "Data Saver acts on requests belonging to a page, so it does not reach these.",
      }),
    ]);
    detailAdvice.hidden = true;
    return;
  }

  if (!settings) {
    replaceChildren(detailSaver, [
      element("p", { className: "field-hint", text: "Data Saver settings could not be read." }),
    ]);
    detailAdvice.hidden = true;
    return;
  }

  if (!settings.enabled) {
    // Naming the mechanism and the exit, rather than "turn it on for a lighter
    // profile": the whole of what it does and the whole of how to undo it.
    replaceChildren(detailSaver, [
      element("p", {
        className: "field-hint",
        text: "Data Saver is off everywhere. It rewrites image requests to known CDNs so they return a smaller variant, refuses analytics beacons, and defers offscreen images and video. It applies to every site except the ones you exclude, and the switch that turns it on turns it back off.",
      }),
      element("p", { className: "detail-presets" }, [linkButton("Open Data Saver settings", "./settings.html#optimize-panel")]),
    ]);
    renderDetailAdvice();
    return;
  }

  const excluded = settings.exclusions.includes(site);
  const input = element("input");
  input.type = "checkbox";
  input.checked = !excluded;
  input.addEventListener("change", () => {
    input.disabled = true;
    void setSiteOptimize(site, input.checked);
  });

  replaceChildren(detailSaver, [
    element("label", { className: "switch-control preference-switch" }, [
      input,
      element("span", { className: "switch-track", ariaHidden: true }, [element("span")]),
      element("span", {
        className: "switch-label",
        text: excluded ? `Data Saver is off for ${site}` : `Data Saver is on for ${site}`,
      }),
    ]),
    element("p", {
      className: "field-hint",
      text: excluded
        ? "This site is on the never-optimize list: nothing here is rewritten, deferred or refused by Data Saver. Its page loads are also left out of the comparison table below."
        : "Image requests to known CDNs are asked for a smaller variant, analytics beacons are refused, and offscreen images and video wait until they are reached.",
    }),
  ]);
  renderDetailAdvice();
}

function linkButton(text: string, href: string): HTMLAnchorElement {
  const node = element("a", { className: "panel-link", text });
  node.href = href;
  return node;
}

async function setSiteOptimize(site: string, optimize: boolean): Promise<void> {
  try {
    const result = await sendRequest({ type: "SET_SITE_OPTIMIZE", site, optimize });
    detailOptimize = result.optimize;
    announce(optimize ? `Data Saver on for ${site}.` : `Data Saver off for ${site}.`);
  } catch (error) {
    announce(errorMessage(error, "Could not change Data Saver for that site."));
  }
  rerenderKeepingFocus(detailSaver, renderDetailSaver);
}

/**
 * Which optimizer, if any, is aimed at what this site actually spends its bytes on.
 *
 * Derived from `byType`, which the payload already carries. Where nothing in Data
 * Saver touches the dominant type, it says so — a recommendation engine that always
 * has a recommendation is a recommendation engine nobody believes twice.
 */
const ADVICE_FEATURE: Partial<Record<ResourceType, FeatureId>> = {
  media: "clickToLoadMedia",
  image: "lazyOffscreen",
  font: "systemFonts",
};

/** Below this the shares are noise: one 200 kB clip on a quiet site is not "71% video". */
const ADVICE_FLOOR_BYTES = 1_000_000;
const ADVICE_SHARE = 0.35;

function renderDetailAdvice(): void {
  const text = detail ? adviceFor(detail.byType) : null;
  detailAdvice.hidden = text === null;
  detailAdvice.textContent = text ?? "";
}

function adviceFor(byType: TypeBytes): string | null {
  const sorted = sortTypeBytes(byType);
  const total = sorted.reduce((sum, [, value]) => sum + value, 0);
  const top = sorted[0];
  if (!top || total < ADVICE_FLOOR_BYTES) return null;
  const [type, value] = top;
  const share = value / total;
  if (share < ADVICE_SHARE) return null;

  const label = RESOURCE_TYPE_LABELS[type].toLowerCase();
  const lead = `${formatPercent(share)} of this site's bytes are ${label}.`;
  const feature = ADVICE_FEATURE[type];
  const info = feature ? FEATURES_BY_ID.get(feature) : undefined;
  if (!info) {
    return `${lead} Nothing in Data Saver removes ${label}, so a limit is the only lever here.`;
  }
  return `${lead} The Data Saver setting aimed at that is "${info.label}", which is ${info.defaultOn ? "on" : "off"} by default.`;
}

/* ------------------------------------------------------------------ *
 * Data Saver results
 * ------------------------------------------------------------------ */

async function loadSavings(): Promise<void> {
  try {
    renderSavings(await sendRequest({ type: "GET_SAVINGS", days: trendDays }));
  } catch (error) {
    savingsNote.textContent = errorMessage(error, "Could not read the savings.");
  }
}

function renderSavings(report: SavingsReport): void {
  savingsNote.textContent = `${RANGE_LABELS[trendDays]} · ${formatDayShort(report.from)} – ${formatDayShort(report.to)}`;

  // Two tiles, and the split is the point. `savedMeasured` is a subtraction against an
  // original whose size is on file; `savedModelled` is the estimator's guess at what a
  // refused request would have weighed. Rendering their sum alone merges a measurement
  // with a model, which is the one thing README.md:133-141 forbids.
  const measured = splitBytes(report.savedMeasured, units);
  const modelled = splitBytes(report.savedModelled, units);
  replaceChildren(savingsStats, [
    statCard("Measured", measured.value, {
      unit: measured.unit,
      hint: "Original sizes on file, minus what the smaller version cost",
      ...(report.savedMeasured > 0 ? { tone: "saved" as const } : {}),
    }),
    statCard("Estimated", `~${modelled.value}`, {
      unit: modelled.unit,
      hint: "The size model's guess for requests refused before they had a size",
      tone: "estimate",
    }),
  ]);

  savingsHint.textContent = report.optimize.enabled
    ? `${plural(report.blocked, "request refused", "requests refused")} · ${plural(report.rewritten, "request made smaller", "requests made smaller")} · ${plural(report.baselines, "original size on file", "original sizes on file")}`
    : "Data Saver is off, so nothing was refused or rewritten in this window. The figures above cover whatever was recorded while it was on.";

  savingsCompareNote.textContent =
    report.optimize.holdoutPercent > 0
      ? `A ${report.optimize.holdoutPercent}% sample of page loads is deliberately left unoptimized, so both columns are real page loads rather than a model. The ± is the 95% interval; a site whose interval crosses zero is left out, because a difference that could be zero is not a saving.`
      : "The unoptimized control sample is switched off, so no new comparisons are being collected. Anything below was recorded while it was on.";

  savingsEmpty.hidden = report.deltas.length > 0;
  savingsTable.hidden = report.deltas.length === 0;
  savingsEmpty.textContent =
    report.optimize.holdoutPercent > 0
      ? "No site has enough loads on both sides yet. A comparison needs at least five optimized loads and one unoptimized one on the same site."
      : "No comparisons are on file, and none are being collected while the control sample is off.";

  replaceChildren(
    savingsBody,
    report.deltas.map((delta) =>
      element("tr", {}, [
        element("td", {}, [
          element("span", { className: "host-name", text: delta.site, title: delta.site }),
        ]),
        element("td", { className: "numeric", text: bytes(delta.optimizedMean) }),
        element("td", { className: "numeric", text: bytes(delta.controlMean) }),
        element("td", {
          className: "numeric",
          text: savedPerLoad(delta),
          dataset: delta.savedPerVisit < 0 ? { negative: "true" } : {},
        }),
        element("td", {
          className: "numeric",
          text: `${formatCount(delta.optimizedCount)} / ${formatCount(delta.controlCount)}`,
          title: "optimized loads / control loads",
        }),
      ]),
    ),
  );

  savingsExplainer.textContent =
    "Three different kinds of number, kept apart. A page-load comparison is the difference between two sets of real loads, from the control sample above. An observed original is arithmetic: the size of the un-rewritten variant, seen before, minus what the smaller one cost now. An estimate is the size model's guess at a request that was refused before it had a size, and it is the only one of the three that depends on this extension's own arithmetic about bytes that never arrived.";
}

/** Never `savedPerVisit` bare: the spread is what stops it reading as precise. */
function savedPerLoad(delta: VisitDeltaView): string {
  const magnitude = `${bytes(Math.abs(delta.savedPerVisit))} ± ${bytes(delta.savedPerVisitSpread)}`;
  return delta.savedPerVisit >= 0 ? magnitude : `${magnitude} heavier`;
}

/* ------------------------------------------------------------------ *
 * Plan and cycle
 * ------------------------------------------------------------------ */

/**
 * Where the billing cycle stands, measured.
 *
 * The cycle usage is the sum of the daily rows since the cycle began — `dailySeries`
 * returns the last N days ending today, and `elapsedDays` is exactly that count, so
 * the window lines up with the cycle without a second query shape.
 */
async function loadPlan(): Promise<void> {
  const settings = overview?.settings;
  if (!settings) return;
  try {
    const { elapsedDays, totalDays } = cycleElapsed(settings);
    const [series, budgets] = await Promise.all([
      sendRequest({ type: "GET_SERIES", days: elapsedDays }),
      sendRequest({ type: "GET_BUDGETS" }),
    ]);
    const used = series.points.reduce((sum, point) => sum + point.down + point.up, 0);
    const everything = budgets.statuses.find((status) => status.budget.site === ALL_SITES) ?? null;
    renderPlan(settings, used, elapsedDays, totalDays, everything);
  } catch (error) {
    planNote.textContent = errorMessage(error, "Could not read the cycle.");
  }
}

function renderPlan(
  settings: Settings,
  used: number,
  elapsedDays: number,
  totalDays: number,
  everything: BudgetStatus | null,
): void {
  const from = formatDayShort(cycleRange(settings).from);
  const resetsAt = cycleResetsAt(settings);
  const resetDay = formatDayShort(dayKeyFromMs(resetsAt));
  planNote.textContent = `Day ${elapsedDays} of ${totalDays} · began ${from}`;

  const plan = settings.planBytes;

  if (plan === null) {
    const anchor =
      settings.cycleStartDay === 0
        ? "the calendar month"
        : `the ${settings.cycleStartDay}${ordinalSuffix(settings.cycleStartDay)} of the month`;
    // Says what it will say, and why it cannot yet. The alternative — rendering the
    // plan as 0 B, 0% or 100% — is three different lies about a question nobody asked.
    replaceChildren(planBody, [
      element("p", { className: "plan-figure", text: `${bytes(used)} used since ${from}` }),
      element("p", {
        className: "field-hint",
        text: `No plan set, so there is nothing to measure that against. Given a plan size, this becomes how much of the cycle is spent, how much a day the rest of it allows, and where the cycle ends at the current rate.`,
      }),
      element("p", {
        className: "field-hint",
        text: `The cycle above runs from ${anchor}. Most carrier cycles do not reset on the 1st, and a figure anchored to the wrong day is never the figure on the bill.`,
      }),
      element("p", { className: "detail-presets" }, [
        linkButton("Set your plan in Settings", "./settings.html"),
      ]),
    ]);
    return;
  }

  const share = plan > 0 ? used / plan : 0;
  const remaining = Math.max(0, plan - used);
  const daysLeft = Math.max(1, totalDays - elapsedDays + 1);

  replaceChildren(planBody, [
    planError
      ? element("p", { className: "form-status", dataset: { tone: "error" }, text: planError })
      : undefined,
    element("p", {
      className: "plan-figure",
      text: `${bytes(used)} of ${bytes(plan)}`,
    }),
    element("div", { className: "limit-meter" }, [
      element("span", { className: "limit-meter-track", ariaHidden: true }, [
        element("span", {
          className: "limit-meter-fill",
          style: { width: `${Math.min(100, Math.max(0, share * 100))}%` },
          dataset: share >= 1 ? { over: "true" } : {},
        }),
      ]),
      element("span", {
        className: "panel-note",
        text: `${formatPercent(share)} of the plan · resets ${formatAgo(resetsAt)}, on ${resetDay}`,
      }),
    ]),
    element("p", {
      className: "field-hint",
      // Division, not a forecast: it says what an even spread would allow, which is a
      // fact about the plan rather than a claim about the days ahead.
      text:
        remaining > 0
          ? `${bytes(remaining)} left. Spread evenly over the ${plural(daysLeft, "day", "days")} remaining, that is ${bytes(remaining / daysLeft)} a day.`
          : `The plan is spent. Everything from here is over it.`,
    }),
    planEnforcementBlock(plan, everything, resetsAt),
  ]);
}

/**
 * Whether anything is actually enforcing the plan.
 *
 * `settings.planBytes` on its own produces no alert and refuses nothing: the alerting
 * path and the tier ladder both read the allowance the governor tracks, which comes
 * from a `Budget`. A plan with no matching budget over `ALL_SITES` is a number on a
 * screen, and the honest thing is to say so and offer the one message that fixes it.
 */
function planEnforcementBlock(
  plan: number,
  everything: BudgetStatus | null,
  cycleResets: number,
): HTMLElement {
  if (everything && everything.budget.bytes === plan) {
    return element("div", { className: "plan-enforcement" }, [
      element("p", {
        className: "field-hint",
        text: "A limit over Everything matches this plan, so alerts fire at 75%, 90% and 100% of it and requests are refused past 100%.",
      }),
      windowMismatchNote(everything, cycleResets),
    ]);
  }

  const message = everything
    ? `The limit over Everything is set to ${bytes(everything.budget.bytes)}, and your plan is ${bytes(plan)}. Alerts and enforcement follow the limit, not the plan.`
    : "Nothing is enforcing this plan. A limit over Everything is what turns it into alerts at 75%, 90% and 100%, and into refused requests past 100%.";

  return element("div", { className: "plan-enforcement" }, [
    element("p", { className: "field-hint", text: message }),
    element("p", { className: "detail-presets" }, [
      button("ghost-button", {
        text: everything
          ? `Set it to ${bytes(plan)} a month`
          : `Limit everything to ${bytes(plan)} a month`,
        onClick: () => void alignPlanBudget(plan),
      }),
    ]),
    everything ? windowMismatchNote(everything, cycleResets) : undefined,
  ]);
}

/**
 * Says when the limit's window and the plan's cycle are not the same window.
 *
 * A `month` budget now rolls over on the plan's reset day — `periodKeyFor` and
 * `periodResetsAt` both go through `startOfCycle` — so the common case is silent. What
 * is left is the deliberate one: an "everything" limit set to a day, a week or a
 * session while the plan counts a month. Both dates are then on screen together and
 * mean different things, and a reader who assumes they are the same window will read
 * the percentage against the wrong denominator.
 */
function windowMismatchNote(everything: BudgetStatus, cycleResets: number): HTMLElement | undefined {
  if (everything.resetsAt === null) return undefined;
  const limitDay = dayKeyFromMs(everything.resetsAt);
  const cycleDay = dayKeyFromMs(cycleResets);
  if (limitDay === cycleDay) return undefined;
  return element("p", {
    className: "field-hint",
    text: `The two windows do not line up: the limit's allowance resets on ${formatDayShort(limitDay)} and your cycle resets on ${formatDayShort(cycleDay)}. A monthly limit runs on the calendar month, so what it refuses against is the calendar month's total, not this cycle's.`,
  });
}

async function alignPlanBudget(plan: number): Promise<void> {
  try {
    await sendRequest({ type: "PUT_BUDGET", site: ALL_SITES, bytes: plan, period: "month" });
    planError = null;
    announce(`Everything is now limited to ${bytes(plan)} a month.`);
  } catch (error) {
    planError = errorMessage(error, "Could not set that limit.");
    announce(planError);
  }
  await loadPlan();
}

function ordinalSuffix(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return "th";
  if (day % 10 === 1) return "st";
  if (day % 10 === 2) return "nd";
  if (day % 10 === 3) return "rd";
  return "th";
}

/* ------------------------------------------------------------------ *
 * What is on disk
 * ------------------------------------------------------------------ */

async function loadStorage(): Promise<void> {
  try {
    renderStorage(await sendRequest({ type: "GET_STORAGE_REPORT" }));
  } catch (error) {
    replaceChildren(storageBody, [
      element("p", { className: "empty", text: errorMessage(error, "Could not read storage.") }),
    ]);
  }
}

function storageRow(label: string, value: string): HTMLElement {
  const head = element("th", { text: label });
  head.scope = "row";
  return element("tr", {}, [head, element("td", { className: "numeric", text: value })]);
}

function renderStorage(report: StorageReport): void {
  replaceChildren(storageBody, [
    // Not debug output. A rejected write leaves every total quietly behind the traffic
    // it claims to measure, and this is the only surface that can admit it.
    report.lastFlushError
      ? element("p", { className: "form-status", dataset: { tone: "error" } }, [
          `Some measurements were not written to disk. The last failure was ${formatAgo(report.lastFlushError.at)}: ${report.lastFlushError.message}. Totals from around then are lower than the traffic they describe.`,
        ])
      : undefined,
    element("table", { className: "table storage-table" }, [
      element("tbody", {}, [
        storageRow("Daily totals", plural(report.dailyRows, "row", "rows")),
        storageRow("Hourly totals", plural(report.hourlyRows, "row", "rows")),
        storageRow("Per-host detail", plural(report.hostRows, "row", "rows")),
        storageRow("Page loads", plural(report.visitRows, "row", "rows")),
        storageRow("Learned request sizes", plural(report.sizeModelRows, "key", "keys")),
        storageRow(
          "Original image sizes",
          report.baselineRows === undefined
            ? "not reported"
            : plural(report.baselineRows, "key", "keys"),
        ),
        storageRow(
          "Disk in use",
          report.bytesUsed === null ? "Chrome does not report it" : bytes(report.bytesUsed),
        ),
      ]),
    ]),
    element("p", {
      className: "field-hint",
      text: "Page-load rows hold the site and the origin, never a path or a query. Original image sizes are capped by count rather than by age, so they are the one store a shorter retention setting does not shorten.",
    }),
  ]);
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

async function loadTrend(): Promise<void> {
  try {
    const { points } = await sendRequest({ type: "GET_SERIES", days: trendDays });
    chartInto(trendSlot, points, `Daily usage over ${RANGE_LABELS[trendDays]}`);
  } catch (error) {
    announce(errorMessage(error, "Could not read the daily series."));
  }
}

function paintDashboardSettings(settings: Settings): void {
  units = settings.units;
  applyTheme(settings.theme);
}

onSettingsChanged((settings) => {
  paintDashboardSettings(settings);
  if (overview) {
    renderStats(overview);
    renderSites(overview);
  }
  void loadPlan();
});

async function load(): Promise<void> {
  try {
    const payload = await sendRequest({ type: "GET_OVERVIEW", period });
    overview = payload;
    paintDashboardSettings(payload.settings);
    periodDescription.textContent = payload.description;
    renderStats(payload);
    renderSites(payload);
    renderFreshness();
    typesNote.textContent = payload.description;
    replaceChildren(typesSlot, [
      stackedBar({
        segments: typeSegments(payload.byType),
        format: (value) => bytes(value),
        minShare: 0.015,
        caption: "Type of data",
      }),
    ]);
    // Skipped while the user is inside the panel: a refresh rebuilds the limit
    // controls, and a poll that lands between reaching for a preset and pressing it
    // is the popup's focus defect on a slower clock.
    if (selectedSite && !focusWithin(detailPanel)) await loadDetail(selectedSite);
  } catch (error) {
    const message = errorMessage(error, "Could not read usage.");
    announce(message);
    renderFreshness();
    // The basis describes cards that are no longer on screen.
    projectionBasis.hidden = true;
    replaceChildren(stats, [element("p", { className: "empty", text: message })]);
  }
}

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    await load();
    await Promise.all([loadTrend(), loadPlan()]);
  } finally {
    refreshing = false;
  }
}

function siteFromHash(): string | null {
  const match = /site=([^&]+)/.exec(location.hash);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

async function start(): Promise<void> {
  selectedSite = siteFromHash();
  bindControls();
  await load();
  // A deep link is a request for this panel, so focus lands in it — but without the
  // announcement, which on a fresh document would talk over the page's own heading.
  if (selectedSite && detail) revealDetail();
  await Promise.all([loadTrend(), loadSavings(), loadPlan(), loadStorage()]);
}

query<HTMLButtonElement>("#detail-close").addEventListener("click", () => closeDetail());

query<HTMLButtonElement>("#savings-range").addEventListener("click", () => {
  // The range control is in another panel entirely. Rather than duplicate it, send
  // the user to it with focus, so the coupling is discovered once instead of guessed.
  const checked =
    rangeTabs.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
    rangeTabs.querySelector<HTMLButtonElement>("[data-option]");
  rangeTabs.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
  checked?.focus({ preventScroll: true });
});

siteSearch.addEventListener("input", () => {
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    searchTimer = null;
    filter = siteSearch.value;
    showAllSites = false;
    if (overview) renderSites(overview);
  }, SEARCH_DEBOUNCE_MS);
});

addEventListener("hashchange", () => {
  const site = siteFromHash();
  if (site === selectedSite) return;
  if (site) void openSite(site, { fromHistory: true });
  else closeDetail({ fromHistory: true });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  void refresh();
  void loadSavings();
  void loadStorage();
});

// A dashboard left open in a second window used to show whatever it had loaded when
// it was opened, for as long as it stayed visible.
setInterval(() => {
  if (document.visibilityState === "visible") void refresh();
}, REFRESH_MS);

// Independent of the poll: the freshness note has to keep ageing when the poll is the
// thing that failed.
setInterval(renderFreshness, 5_000);

void start();

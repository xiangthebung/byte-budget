import "./dashboard.css";
import { barChart, stackedBar, type BarPoint, type StackSegment } from "./core/chart";
import { element, faviconUrl, query, replaceChildren } from "./core/dom";
import { formatBytes, formatCount, formatPercent, splitBytes } from "./core/format";
import {
  errorMessage,
  sendRequest,
  sortTypeBytes,
  type OverviewPayload,
  type SavingsReport,
  type SeriesPoint,
  type SiteDetailPayload,
  type SiteUsage,
} from "./core/messages";
import { formatDayShort, formatWeekday } from "./core/period";
import { applyTheme, onSettingsChanged } from "./core/settings";
import {
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

const RANGE_OPTIONS = [14, 30, 90] as const;
const RANGE_LABELS: Record<(typeof RANGE_OPTIONS)[number], string> = {
  14: "2 weeks",
  30: "30 days",
  90: "3 months",
};

const periodTabs = query<HTMLDivElement>("#period-tabs");
const rangeTabs = query<HTMLDivElement>("#range-tabs");
const periodDescription = query<HTMLParagraphElement>("#period-description");
const stats = query<HTMLElement>("#stats");
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
const detailHours = query<HTMLDivElement>("#detail-hours");
const detailDays = query<HTMLDivElement>("#detail-days");
const detailTypes = query<HTMLDivElement>("#detail-types");
const detailHostsBody = query<HTMLTableSectionElement>("#detail-hosts tbody");
const detailHostsEmpty = query<HTMLParagraphElement>("#detail-hosts-empty");
const savingsPanel = query<HTMLElement>("#savings-panel");
const savingsStats = query<HTMLDivElement>("#savings-stats");
const savingsNote = query<HTMLSpanElement>("#savings-note");
const savingsExplainer = query<HTMLParagraphElement>("#savings-explainer");
const savingsTable = query<HTMLTableElement>("#savings-table");
const savingsBody = query<HTMLTableSectionElement>("#savings-table tbody");
const savingsEmpty = query<HTMLParagraphElement>("#savings-empty");
const liveRegion = query<HTMLParagraphElement>("#live-region");

let period: Period = "today";
let trendDays: number = 30;
let units: Settings["units"] = "si";
let overview: OverviewPayload | null = null;
let selectedSite: string | null = null;
let filter = "";

function bytes(value: number): string {
  return formatBytes(value, units);
}

/* ------------------------------------------------------------------ *
 * Charts and labels
 * ------------------------------------------------------------------ */

const HOUR_BUCKET = /^\d{4}-\d{2}-\d{2}T(\d{2})$/;

function tickFor(bucket: string, total: number): string {
  const hour = HOUR_BUCKET.exec(bucket);
  if (hour) return `${hour[1]}`;
  return total <= 8 ? formatWeekday(bucket) : bucket.slice(8, 10);
}

function labelFor(bucket: string): string {
  const hour = HOUR_BUCKET.exec(bucket);
  if (hour) return `${formatDayShort(bucket.slice(0, 10))}, ${hour[1]}:00`;
  return formatDayShort(bucket);
}

function typeSegments(byType: OverviewPayload["byType"]): StackSegment[] {
  return sortTypeBytes(byType).map(([type, value]) => ({
    key: type,
    label: RESOURCE_TYPE_LABELS[type],
    value,
    hue: RESOURCE_TYPE_HUES[type],
  }));
}

function pointsFrom(series: readonly SeriesPoint[]): BarPoint[] {
  return series.map((point) => ({
    key: point.bucket,
    value: point.down + point.up,
    tick: tickFor(point.bucket, series.length),
    label: labelFor(point.bucket),
    overlay: point.saved,
  }));
}

function chartInto(node: HTMLElement, series: readonly SeriesPoint[], caption: string): void {
  if (series.length === 0) {
    replaceChildren(node, [element("p", { className: "stack-note", text: "Nothing recorded." })]);
    return;
  }
  const points = pointsFrom(series);
  replaceChildren(node, [
    element("div", { className: "dashboard-chart" }, [
      barChart({
        points,
        format: (value) => bytes(value),
        caption,
        tickEvery: points.length > 16 ? Math.ceil(points.length / 10) : 1,
      }),
    ]),
  ]);
}

/* ------------------------------------------------------------------ *
 * Period controls
 * ------------------------------------------------------------------ */

function renderPeriodTabs(): void {
  replaceChildren(
    periodTabs,
    PERIODS.map((value) => {
      const tab = element("button", { text: PERIOD_LABELS[value] });
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(value === period));
      tab.addEventListener("click", () => {
        if (value === period) return;
        period = value;
        renderPeriodTabs();
        void load();
      });
      return tab;
    }),
  );
}

function renderRangeTabs(): void {
  replaceChildren(
    rangeTabs,
    RANGE_OPTIONS.map((value) => {
      const tab = element("button", { text: RANGE_LABELS[value] });
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(value === trendDays));
      tab.addEventListener("click", () => {
        if (value === trendDays) return;
        trendDays = value;
        renderRangeTabs();
        void loadTrend();
        void loadSavings();
      });
      return tab;
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Overview
 * ------------------------------------------------------------------ */

function statCard(
  label: string,
  value: string,
  options: { unit?: string; hint?: string; tone?: "estimate" | "saved" } = {},
): HTMLElement {
  return element(
    "article",
    { className: "stat", dataset: options.tone ? { tone: options.tone } : {} },
    [
      element("p", { className: "stat-label", text: label }),
      element("p", { className: "stat-value" }, [
        value,
        options.unit ? element("span", { className: "unit", text: options.unit }) : undefined,
      ]),
      options.hint ? element("p", { className: "stat-hint", text: options.hint }) : undefined,
    ],
  );
}

function renderStats(payload: OverviewPayload): void {
  const total = totalBytes(payload.totals);
  const totalSplit = splitBytes(total, units);
  const measured = measuredShare(payload.totals);
  const top = payload.sites[0];
  const topBytes = top ? totalBytes(top.totals) : 0;
  const saved = payload.totals.saved;

  replaceChildren(stats, [
    statCard("Data used", totalSplit.value, {
      unit: totalSplit.unit,
      hint: `${formatCount(payload.sites.length)} ${payload.sites.length === 1 ? "site" : "sites"}`,
    }),
    statCard("Top site", top ? bytes(topBytes) : "–", {
      hint: top
        ? `${siteLabel(top.site)} · ${formatPercent(total > 0 ? topBytes / total : 0)}`
        : "No usage yet",
    }),
    statCard("Accuracy", formatPercent(measured), {
      hint: measured < 0.9 ? "Some usage is estimated" : "Measured directly",
      ...(measured < 0.9 ? { tone: "estimate" as const } : {}),
    }),
    statCard("Data saved", saved > 0 ? `~${bytes(saved)}` : "0 B", {
      hint:
        saved > 0
          ? "From lighter and skipped requests"
          : payload.totals.cacheAvoided > 0
            ? `Cache also saved ~${bytes(payload.totals.cacheAvoided)}`
            : "Turn on Data Saver or add a limit",
      ...(saved > 0 ? { tone: "saved" as const } : {}),
    }),
  ]);
}

/* ------------------------------------------------------------------ *
 * Sites
 * ------------------------------------------------------------------ */

function siteLabel(site: string): string {
  return isReservedSite(site) ? (RESERVED_SITE_LABELS[site] ?? site) : site;
}

function renderSites(payload: OverviewPayload): void {
  const needle = filter.trim().toLowerCase();
  const matching = needle
    ? payload.sites.filter((entry) => siteLabel(entry.site).toLowerCase().includes(needle))
    : payload.sites;
  const peak = matching.length > 0 ? totalBytes(matching[0]?.totals ?? payload.totals) : 0;

  sitesNote.textContent = needle
    ? `${formatCount(matching.length)} of ${formatCount(payload.sites.length)}`
    : `${formatCount(payload.sites.length)} ${payload.sites.length === 1 ? "site" : "sites"}`;
  sitesEmpty.hidden = matching.length > 0;

  replaceChildren(
    siteList,
    matching.map((entry) => element("li", {}, [siteRow(entry, peak, totalBytes(payload.totals))])),
  );
}

function siteRow(entry: SiteUsage, peak: number, periodTotal: number): HTMLButtonElement {
  const own = totalBytes(entry.totals);
  const reserved = isReservedSite(entry.site);
  const estimated = entry.totals.down > 0 && measuredShare(entry.totals) < 0.75;
  const row = element("button", {
    className: "site-row",
    title: reserved
      ? "Requests that did not belong to a tab: browser services, service workers and other extensions."
      : entry.site,
  });
  row.type = "button";
  if (selectedSite === entry.site) row.setAttribute("aria-current", "true");
  row.addEventListener("click", () => void selectSite(entry.site));

  const icon = element("img", { className: "site-icon" });
  icon.width = 20;
  icon.height = 20;
  icon.alt = "";
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
  );
  return row;
}

/* ------------------------------------------------------------------ *
 * Site detail
 * ------------------------------------------------------------------ */

async function selectSite(site: string): Promise<void> {
  selectedSite = site;
  location.hash = `site=${encodeURIComponent(site)}`;
  if (overview) renderSites(overview);
  try {
    renderDetail(await sendRequest({ type: "GET_SITE", site, period }));
  } catch (error) {
    liveRegion.textContent = errorMessage(error, "Could not read that site.");
  }
}

function renderDetail(detail: SiteDetailPayload): void {
  detailPanel.hidden = false;
  const reserved = isReservedSite(detail.site);
  detailIcon.src = reserved ? "" : faviconUrl(`https://${detail.site}/`);
  detailSite.textContent = siteLabel(detail.site);

  const pieces = [`${bytes(totalBytes(detail.totals))} · ${detail.description}`];
  if (measuredShare(detail.totals) < 0.9) pieces.push("Includes some estimates");
  if (detail.visits.count > 0) {
    pieces.push(
      `${formatCount(detail.visits.count)} ${detail.visits.count === 1 ? "page load" : "page loads"} · typical ${bytes(detail.visits.medianDown)}`,
    );
  }
  detailSub.textContent = pieces.join(" · ");

  chartInto(detailHours, detail.hours, "Today by hour");
  chartInto(detailDays, detail.days, "By day");
  replaceChildren(detailTypes, [
    stackedBar({
      segments: typeSegments(detail.byType),
      format: (value) => bytes(value),
      minShare: 0.02,
    }),
  ]);

  detailHostsEmpty.hidden = detail.settings.trackHosts;
  replaceChildren(
    detailHostsBody,
    detail.hosts.slice(0, 25).map((host) =>
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
  detailPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

query<HTMLButtonElement>("#detail-close").addEventListener("click", () => {
  selectedSite = null;
  detailPanel.hidden = true;
  history.replaceState(null, "", location.pathname);
  if (overview) renderSites(overview);
});

siteSearch.addEventListener("input", () => {
  filter = siteSearch.value;
  if (overview) renderSites(overview);
});

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
  savingsNote.textContent = `${formatDayShort(report.from)} – ${formatDayShort(report.to)}`;
  savingsPanel.hidden = !report.optimize.enabled && report.saved <= 0 && report.deltas.length === 0;
  const totalSplit = splitBytes(report.saved, units);

  replaceChildren(savingsStats, [
    statCard("Data saved", report.saved > 0 ? `~${totalSplit.value}` : totalSplit.value, {
      unit: totalSplit.unit,
      hint: report.saved > 0 ? "From lighter pages and less background traffic" : "Savings will appear as you browse",
      ...(report.saved > 0 ? { tone: "saved" as const } : {}),
    }),
  ]);

  savingsExplainer.textContent =
    "When Byte Budget has seen both versions of a request, it compares their real sizes. " +
    "If a request is stopped before loading, that part is clearly treated as an estimate.";
  savingsEmpty.hidden = report.deltas.length > 0;
  savingsTable.hidden = report.deltas.length === 0;
  savingsEmpty.textContent =
    report.optimize.holdoutPercent > 0
      ? "There is not enough browsing history for a page-by-page comparison yet."
      : "Page-by-page comparison is unavailable.";

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
          className: delta.savedPerVisit >= 0 ? "numeric" : "numeric site-estimate",
          text: `${delta.savedPerVisit >= 0 ? "" : "+"}${bytes(Math.abs(delta.savedPerVisit))}`,
        }),
        element("td", {
          className: "numeric",
          text: `${formatCount(delta.optimizedCount)} / ${formatCount(delta.controlCount)}`,
          title: "optimized loads / control loads",
        }),
      ]),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

async function loadTrend(): Promise<void> {
  try {
    const { points } = await sendRequest({ type: "GET_SERIES", days: trendDays });
    chartInto(trendSlot, points, `Daily usage over ${trendDays} days`);
  } catch (error) {
    liveRegion.textContent = errorMessage(error, "Could not read the daily series.");
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
});

async function load(): Promise<void> {
  try {
    const payload = await sendRequest({ type: "GET_OVERVIEW", period });
    overview = payload;
    paintDashboardSettings(payload.settings);
    periodDescription.textContent = payload.description;
    renderStats(payload);
    renderSites(payload);
    typesNote.textContent = payload.description;
    replaceChildren(typesSlot, [
      stackedBar({
        segments: typeSegments(payload.byType),
        format: (value) => bytes(value),
        minShare: 0.015,
      }),
    ]);
    if (selectedSite) await selectSite(selectedSite);
  } catch (error) {
    const message = errorMessage(error, "Could not read usage.");
    liveRegion.textContent = message;
    replaceChildren(stats, [element("p", { className: "empty", text: message })]);
  }
}

function siteFromHash(): string | null {
  const match = /site=([^&]+)/.exec(location.hash);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

async function start(): Promise<void> {
  selectedSite = siteFromHash();
  renderPeriodTabs();
  renderRangeTabs();
  await load();
  await Promise.all([loadTrend(), loadSavings()]);
}

addEventListener("hashchange", () => {
  const site = siteFromHash();
  if (site && site !== selectedSite) void selectSite(site);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  void load();
  void loadSavings();
});

void start();

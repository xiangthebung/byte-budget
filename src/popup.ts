/**
 * The popup: the period total, where it went, and which sites it went to.
 *
 * It polls while open. That looks wasteful and is the opposite: asking the worker
 * for an overview forces it to flush its buffer first, so a popup left open next
 * to a loading page shows the bytes arriving rather than a figure from whenever it
 * was opened. It also keeps the worker awake for exactly as long as someone is
 * looking at it, which is when that matters.
 */

import "./popup.css";
import { barChart, stackedBar, type BarPoint, type StackSegment } from "./core/chart";
import { button, element, faviconUrl, query, replaceChildren } from "./core/dom";
import { formatAgo, formatBytes, formatCount, formatPercent, splitBytes } from "./core/format";
import {
  errorMessage,
  sendRequest,
  sortTypeBytes,
  type BudgetStatus,
  type OverviewPayload,
} from "./core/messages";
import { BUDGET_PERIOD_LABELS } from "./limit/budgets";
import { TIER_LABELS } from "./limit/tiers";
import type { OptimizeSettings } from "./optimize/features";
import { applyTheme } from "./core/settings";
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

const REFRESH_MS = 2000;
const SITE_ROWS = 6;
const PERIOD_STORAGE_KEY = "ui.period";

const periodDescription = query<HTMLParagraphElement>("#period-description");
const totalValue = query<HTMLSpanElement>("#total-value");
const totalUnit = query<HTMLSpanElement>("#total-unit");
const periodTabs = query<HTMLDivElement>("#period-tabs");
const metaLine = query<HTMLParagraphElement>("#meta-line");
const currentCard = query<HTMLElement>("#current-card");
const currentIcon = query<HTMLImageElement>("#current-icon");
const currentSite = query<HTMLSpanElement>("#current-site");
const currentSub = query<HTMLSpanElement>("#current-sub");
const currentBytes = query<HTMLSpanElement>("#current-bytes");
const optimizeRow = query<HTMLElement>("#optimize-row");
const limitCard = query<HTMLElement>("#limit-card");
const limitSlot = query<HTMLDivElement>("#limit-slot");
const chartSlot = query<HTMLDivElement>("#chart-slot");
const chartNote = query<HTMLSpanElement>("#chart-note");
const typesSlot = query<HTMLDivElement>("#types-slot");
const siteList = query<HTMLOListElement>("#site-list");
const sitesNote = query<HTMLSpanElement>("#sites-note");
const emptyState = query<HTMLParagraphElement>("#empty-state");
const footerNote = query<HTMLSpanElement>("#footer-note");
const liveRegion = query<HTMLParagraphElement>("#live-region");

let period: Period = "today";
let units: Settings["units"] = "si";
let timer: ReturnType<typeof setInterval> | null = null;

function bytes(value: number): string {
  return formatBytes(value, units);
}

/* ------------------------------------------------------------------ *
 * Period tabs
 * ------------------------------------------------------------------ */

function renderTabs(): void {
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
        void chrome.storage.local.set({ [PERIOD_STORAGE_KEY]: value });
        renderTabs();
        void refresh();
      });
      return tab;
    }),
  );
}

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

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderHeadline(payload: OverviewPayload): void {
  const total = totalBytes(payload.totals);
  const split = splitBytes(total, units);
  totalValue.textContent = split.value;
  totalUnit.textContent = split.unit;
  periodDescription.textContent = payload.description;
}

function renderMeta(payload: OverviewPayload): void {
  const measured = measuredShare(payload.totals);
  const parts: (Node | string)[] = [
    element("span", {
      className: measured < 0.9 ? "meta-flag" : undefined,
      text:
        payload.totals.down <= 0
          ? "Ready to track"
          : measured < 0.9
            ? `${formatPercent(measured)} measured · the rest is estimated`
            : "Measured directly",
    }),
  ];

  if (payload.totals.cacheAvoided > 0) {
    parts.push(
      element("span", {
        text: `Cache saved ~${bytes(payload.totals.cacheAvoided)}`,
        title: "These files came from the browser cache instead of the network.",
      }),
    );
  }

  replaceChildren(metaLine, parts);
}

function renderCurrent(payload: OverviewPayload): void {
  const { site, origin, totals } = payload.current;
  if (!site || !origin) {
    currentCard.hidden = true;
    return;
  }
  currentCard.hidden = false;
  currentIcon.src = faviconUrl(`${origin}/`);
  currentSite.textContent = site;

  const total = totalBytes(payload.totals);
  const own = totalBytes(totals);
  currentBytes.textContent = bytes(own);
  currentSub.textContent =
    total > 0 ? `${formatPercent(own / total)} of this period` : "This tab, this period";
}

function renderChart(payload: OverviewPayload): void {
  const points: BarPoint[] = payload.series.map((point) => ({
    key: point.bucket,
    value: point.down + point.up,
    tick: tickFor(point.bucket),
    label: labelFor(point.bucket),
    overlay: point.saved,
  }));

  if (points.length === 0) {
    replaceChildren(chartSlot, [
      element("p", { className: "stack-note", text: "No history for this period yet." }),
    ]);
    chartNote.textContent = "";
    return;
  }

  const peak = points.reduce((max, point) => Math.max(max, point.value), 0);
  chartNote.textContent = peak > 0 ? `peak ${bytes(peak)}` : "";
  replaceChildren(chartSlot, [
    barChart({
      points,
      format: (value) => bytes(value),
      caption: payload.description,
      tickEvery: points.length > 16 ? Math.ceil(points.length / 8) : 1,
    }),
  ]);
}

function renderTypes(payload: OverviewPayload): void {
  const segments: StackSegment[] = sortTypeBytes(payload.byType).map(([type, value]) => ({
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
      caption: "What the bytes were",
    }),
  ]);
}

function renderSites(payload: OverviewPayload): void {
  const shown = payload.sites.slice(0, SITE_ROWS);
  const peak = shown.length > 0 ? totalBytes(shown[0]?.totals ?? payload.totals) : 0;
  const periodTotal = totalBytes(payload.totals);

  sitesNote.textContent =
    payload.sites.length > 0
      ? `${formatCount(payload.sites.length)} ${payload.sites.length === 1 ? "site" : "sites"}`
      : "";
  emptyState.hidden = payload.sites.length > 0;

  replaceChildren(
    siteList,
    shown.map((entry) => {
      const own = totalBytes(entry.totals);
      const reserved = isReservedSite(entry.site);
      const name = reserved ? (RESERVED_SITE_LABELS[entry.site] ?? entry.site) : entry.site;
      const estimated = entry.totals.down > 0 && measuredShare(entry.totals) < 0.75;

      const row = element("button", {
        className: "site-row",
        title: reserved
          ? "Requests that did not belong to a tab: browser services, service workers and other extensions."
          : `${name} — open in the dashboard`,
      });
      row.type = "button";
      row.addEventListener("click", () => openDashboard(reserved ? undefined : entry.site));

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
            text: name,
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
              (estimated ? " · estimated" : ""),
          }),
        ]),
      );
      return element("li", {}, [row]);
    }),
  );
}

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
 * Data limit
 * ------------------------------------------------------------------ */

/**
 * Presets rather than a number field.
 *
 * A byte count typed into a 420px panel is a chore, and the three sizes people
 * actually reach for are "enough for a normal day", "enough with some video", and
 * "stop me before a boxset". Anything finer belongs in Settings.
 */
const LIMIT_PRESETS: readonly { label: string; bytes: number }[] = [
  { label: "100 MB", bytes: 100_000_000 },
  { label: "500 MB", bytes: 500_000_000 },
  { label: "1 GB", bytes: 1_000_000_000 },
];

/* ------------------------------------------------------------------ *
 * Optimize
 * ------------------------------------------------------------------ */

async function renderOptimize(site: string | null, saved: number): Promise<void> {
  if (!site) {
    optimizeRow.hidden = true;
    return;
  }

  let settings: OptimizeSettings;
  try {
    settings = (await sendRequest({ type: "GET_OPTIMIZE" })).optimize;
  } catch {
    optimizeRow.hidden = true;
    return;
  }

  optimizeRow.hidden = false;
  const excluded = settings.exclusions.includes(site);
  const active = settings.enabled && !excluded;
  optimizeRow.dataset.active = String(active);

  if (!settings.enabled) {
    replaceChildren(optimizeRow, [
      element("span", { className: "optimize-copy" }, [
        element("span", { className: "optimize-title", text: "Data Saver is off" }),
        element("span", {
          className: "optimize-hint",
          text: "Turn it on for a safe, automatic lighter-page profile.",
        }),
      ]),
      button("ghost-button", {
        text: "Turn on",
        onClick: () => {
          void ask({
            type: "SAVE_OPTIMIZE",
            changes: { enabled: true },
          });
        },
      }),
    ]);
    return;
  }

  const toggle = element("input");
  toggle.type = "checkbox";
  toggle.checked = active;
  toggle.id = "optimize-site";
  toggle.addEventListener("change", () => {
    void ask({ type: "SET_SITE_OPTIMIZE", site, optimize: toggle.checked });
  });

  const label = element("label", { className: "optimize-copy" }, [
    element("span", {
      className: "optimize-title",
      text: active ? `Data Saver on for ${site}` : `Data Saver off for ${site}`,
    }),
    element("span", {
      className: "optimize-hint",
      text: active
        ? "Smaller images where a service offers them, less speculative loading."
        : "This site is on the never-optimize list.",
    }),
  ]);
  label.htmlFor = "optimize-site";

  replaceChildren(optimizeRow, [
    toggle,
    label,
    saved > 0
      ? element("span", {
          className: "optimize-saved",
          text: `~${bytes(saved)}`,
          title:
            "Bytes avoided this period, from refused and rewritten requests. Partly " +
            "estimated — the dashboard breaks it down.",
        })
      : undefined,
  ]);
}

async function renderLimit(site: string | null): Promise<void> {
  if (!site) {
    limitCard.hidden = true;
    return;
  }

  let status: BudgetStatus | null = null;
  try {
    const { statuses } = await sendRequest({ type: "GET_BUDGETS" });
    status = statuses.find((entry) => entry.budget.site === site) ?? null;
  } catch {
    limitCard.hidden = true;
    return;
  }

  limitCard.hidden = false;
  const enforcing = Boolean(status && status.tier !== "off");
  limitCard.dataset.enforcing = String(enforcing);

  if (!status) {
    replaceChildren(limitSlot, [
      element("p", { className: "limit-note", text: `No limit on ${site}.` }),
      element(
        "div",
        { className: "limit-actions" },
        LIMIT_PRESETS.map((preset) =>
          button(
            "ghost-button",
            {
              text: `${preset.label} a day`,
              onClick: () => void setLimit(site, preset.bytes),
            },
          ),
        ),
      ),
      button("limit-more", {
        text: "Manage limits",
        onClick: () => openSettings("limits-panel"),
      }),
    ]);
    return;
  }

  const over = status.share >= 1;
  const stateText = status.snoozed
    ? "Paused"
    : status.tier === "off"
      ? "Within limit"
      : TIER_LABELS[status.tier];

  replaceChildren(limitSlot, [
    element("p", { className: "limit-line" }, [
      element("span", {
        className: "limit-used",
        text: `${bytes(status.used)} of ${bytes(status.allowance)}`,
      }),
      element("span", {
        className: "limit-state",
        text: stateText,
        dataset: enforcing ? { tone: "enforcing" } : {},
      }),
    ]),
    element("span", { className: "limit-bar", ariaHidden: true }, [
      element("span", {
        className: "limit-bar-fill",
        style: { width: `${Math.min(100, Math.max(1, status.share * 100)).toFixed(1)}%` },
        dataset: over ? { over: "true" } : {},
      }),
    ]),
    element("p", {
      className: "limit-note",
      text: [
        `${formatPercent(status.share)} of ${BUDGET_PERIOD_LABELS[status.budget.period]}`,
        status.resetsAt ? `resets ${formatAgo(status.resetsAt)}` : "resets when the browser closes",
      ].join(" · "),
    }),
    element("div", { className: "limit-actions" }, [
      button("ghost-button", {
        text: "+25 MB today",
        onClick: () => void ask({ type: "GRANT_BYTES", site, bytes: 25_000_000 }),
      }),
      status.snoozed
        ? button("ghost-button", {
            text: "Resume",
            onClick: () => void ask({ type: "RESUME_BUDGET", site }),
          })
        : button("ghost-button", {
            text: "Pause 1 hour",
            onClick: () => void ask({ type: "SNOOZE_BUDGET", site, minutes: 60 }),
          }),
      button("ghost-button", {
        text: "Remove",
        onClick: () => void ask({ type: "REMOVE_BUDGET", site }),
      }),
    ]),
  ]);
}

async function setLimit(site: string, size: number): Promise<void> {
  await ask({ type: "PUT_BUDGET", site, bytes: size, period: "day" });
}

/** Sends a limit change and re-renders, reporting failure rather than swallowing it. */
async function ask(request: Parameters<typeof sendRequest>[0]): Promise<void> {
  try {
    await sendRequest(request);
    await refresh();
  } catch (error) {
    liveRegion.textContent = errorMessage(error, "Could not change the limit.");
    footerNote.textContent = errorMessage(error, "Could not change the limit.");
  }
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

async function refresh(): Promise<void> {
  try {
    const payload = await sendRequest({ type: "GET_OVERVIEW", period });
    units = payload.settings.units;
    applyTheme(payload.settings.theme);
    renderHeadline(payload);
    renderMeta(payload);
    renderCurrent(payload);
    renderChart(payload);
    renderTypes(payload);
    renderSites(payload);
    await renderOptimize(payload.current.site, payload.current.totals.saved);
    await renderLimit(payload.current.site);
    footerNote.textContent = "Your data stays on this device.";
  } catch (error) {
    liveRegion.textContent = errorMessage(error, "Could not read usage.");
    footerNote.textContent = errorMessage(error, "Could not read usage.");
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
}

async function start(): Promise<void> {
  const stored = await chrome.storage.local.get(PERIOD_STORAGE_KEY);
  const saved = stored[PERIOD_STORAGE_KEY] as Period | undefined;
  if (saved && (PERIODS as readonly string[]).includes(saved)) period = saved;

  renderTabs();
  await refresh();
  timer = setInterval(() => void refresh(), REFRESH_MS);
}

query<HTMLButtonElement>("#dashboard-button").addEventListener("click", () => openDashboard());
query<HTMLButtonElement>("#open-dashboard").addEventListener("click", () => openDashboard());

addEventListener("unload", () => {
  if (timer) clearInterval(timer);
});

void start();

import "./dashboard.css";
import { button, element, query, replaceChildren } from "./core/dom";
import {
  formatAgo,
  formatBytes,
  formatCount,
  formatPercent,
  parseByteSize,
} from "./core/format";
import { errorMessage, sendRequest, type BudgetStatus } from "./core/messages";
import { applyTheme, onSettingsChanged } from "./core/settings";
import { siteKeyFromHost } from "./core/sites";
import type { Settings } from "./core/types";
import { BUDGET_PERIOD_LABELS, BUDGET_SHAPE_LABELS } from "./limit/budgets";
import { TIER_LABELS } from "./limit/tiers";
import {
  SAVINGS_IMPACT_BY_FEATURE,
  type FeatureId,
  type OptimizeSettings,
  type SavingsImpact,
} from "./optimize/features";

const limitsTable = query<HTMLTableElement>("#limits-table");
const limitsBody = query<HTMLTableSectionElement>("#limits-table tbody");
const limitsEmpty = query<HTMLParagraphElement>("#limits-empty");
const limitsNote = query<HTMLSpanElement>("#limits-note");
const limitStatus = query<HTMLParagraphElement>("#limit-form-status");
const optimizeToggle = query<HTMLInputElement>("#optimize-toggle");
const optimizeBody = query<HTMLDivElement>("#optimize-body");
const optimizeNote = query<HTMLParagraphElement>("#optimize-note");
const mediaOnClickToggle = query<HTMLInputElement>("#media-on-click-toggle");
const preloadToggle = query<HTMLInputElement>("#preload-toggle");
const systemFontsToggle = query<HTMLInputElement>("#system-fonts-toggle");
const optimizeFeatureToggles = [mediaOnClickToggle, preloadToggle, systemFontsToggle];
const exclusionCount = query<HTMLSpanElement>("#exclusion-count");
const exclusionList = query<HTMLUListElement>("#exclusion-list");
const dataStatus = query<HTMLParagraphElement>("#data-status");
const settingsStatus = query<HTMLSpanElement>("#settings-status");
const badgeToggle = query<HTMLInputElement>("#badge-toggle");
const liveRegion = query<HTMLParagraphElement>("#live-region");

let units: Settings["units"] = "si";
let optimize: OptimizeSettings | null = null;

function bytes(value: number): string {
  return formatBytes(value, units);
}

/* ------------------------------------------------------------------ *
 * Relative savings cues
 * ------------------------------------------------------------------ */

const IMPACT_SCORE: Record<SavingsImpact, number> = { low: 1, medium: 2, high: 3 };

function renderImpactMeters(): void {
  for (const node of document.querySelectorAll<HTMLElement>("[data-impact-feature]")) {
    const feature = node.dataset.impactFeature as FeatureId | undefined;
    const impact = feature ? SAVINGS_IMPACT_BY_FEATURE[feature] : undefined;
    if (!impact) continue;
    const label = impact[0]?.toUpperCase() + impact.slice(1);
    const score = IMPACT_SCORE[impact];
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", `Expected data savings: ${label}`);
    replaceChildren(node, [
      element(
        "span",
        { className: "impact-bars", ariaHidden: true },
        [1, 2, 3].map((level) =>
          element("span", {
            className: "impact-segment",
            dataset: level <= score ? { filled: "true" } : {},
          }),
        ),
      ),
      element("span", { className: "impact-label", text: label }),
    ]);
  }
}

/* ------------------------------------------------------------------ *
 * Data limits
 * ------------------------------------------------------------------ */

async function loadLimits(): Promise<void> {
  try {
    const { statuses } = await sendRequest({ type: "GET_BUDGETS" });
    renderLimits(statuses);
  } catch (error) {
    limitStatus.textContent = errorMessage(error, "Could not read the limits.");
  }
}

function renderLimits(statuses: readonly BudgetStatus[]): void {
  limitsEmpty.hidden = statuses.length > 0;
  limitsTable.hidden = statuses.length === 0;
  limitsNote.textContent =
    statuses.length === 0
      ? ""
      : `${formatCount(statuses.length)} ${statuses.length === 1 ? "limit" : "limits"}`;

  replaceChildren(
    limitsBody,
    [...statuses].sort((a, b) => b.share - a.share).map((status) => limitRow(status)),
  );
}

function limitRow(status: BudgetStatus): HTMLTableRowElement {
  const site = status.budget.site;
  const over = status.share >= 1;
  const state = status.snoozed
    ? { text: "Paused", tone: "paused" }
    : status.tier === "off"
      ? { text: "Within limit", tone: "" }
      : { text: TIER_LABELS[status.tier], tone: "enforcing" };

  /*
   * `data-label` repeats the column heading on each cell so the narrow layout can
   * drop the header row and still say what each figure is: under 640px the six
   * columns become one card per limit (see `#limits-table` in `dashboard.css`).
   * The site and the actions are left unlabelled — the hostname is the card's
   * title and the buttons name themselves.
   */
  return element("tr", {}, [
    element("td", {}, [element("span", { className: "host-name", text: site, title: site })]),
    element("td", {
      dataset: { label: "Limit" },
      text: `${bytes(status.budget.bytes)} ${BUDGET_PERIOD_LABELS[status.budget.period]}`,
      title: BUDGET_SHAPE_LABELS[status.budget.shape],
    }),
    element("td", { className: "numeric", dataset: { label: "Used" } }, [
      element("span", { className: "limit-meter" }, [
        element("span", { text: `${bytes(status.used)} · ${formatPercent(status.share)}` }),
        element("span", { className: "limit-meter-track", ariaHidden: true }, [
          element("span", {
            className: "limit-meter-fill",
            style: { width: `${Math.min(100, Math.max(1, status.share * 100)).toFixed(1)}%` },
            dataset: over ? { over: "true" } : {},
          }),
        ]),
      ]),
    ]),
    element("td", { dataset: { label: "Status" } }, [
      element("span", {
        className: "state-chip",
        text: state.text,
        dataset: state.tone ? { tone: state.tone } : {},
      }),
    ]),
    element("td", {
      dataset: { label: "Resets" },
      text: status.resetsAt ? formatAgo(status.resetsAt) : "on browser close",
    }),
    element("td", {}, [
      element("span", { className: "row-actions" }, [
        button("ghost-button", {
          text: "+25 MB",
          title: "Add 25 MB for this window only",
          onClick: () => void changeLimit({ type: "GRANT_BYTES", site, bytes: 25_000_000 }),
        }),
        status.snoozed
          ? button("ghost-button", {
              text: "Resume",
              onClick: () => void changeLimit({ type: "RESUME_BUDGET", site }),
            })
          : button("ghost-button", {
              text: "Pause 1 h",
              onClick: () => void changeLimit({ type: "SNOOZE_BUDGET", site, minutes: 60 }),
            }),
        button("ghost-button", {
          text: "Remove",
          dataset: { danger: "true" },
          onClick: () => void changeLimit({ type: "REMOVE_BUDGET", site }),
        }),
      ]),
    ]),
  ]);
}

async function changeLimit(request: Parameters<typeof sendRequest>[0]): Promise<boolean> {
  try {
    const response = await sendRequest(request);
    if ("statuses" in response) renderLimits(response.statuses);
    limitStatus.textContent = "";
    return true;
  } catch (error) {
    limitStatus.textContent = errorMessage(error, "Could not change that limit.");
    return false;
  }
}

query<HTMLFormElement>("#limit-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const siteInput = query<HTMLInputElement>("#limit-site");
  const sizeInput = query<HTMLInputElement>("#limit-size");
  const site = siteKeyFromHost(siteInput.value.trim());
  const raw = sizeInput.value;
  const size = parseByteSize(raw);

  if (!site) {
    limitStatus.textContent = "Which site is the limit for?";
    return;
  }
  if (size === null || size <= 0) {
    limitStatus.textContent = `Could not read "${raw}". Try 500 MB or 1 GB.`;
    return;
  }

  limitStatus.textContent = "Saving…";
  void changeLimit({
    type: "PUT_BUDGET",
    site,
    bytes: size,
    period: "day",
    shape: "progressive",
  }).then((saved) => {
    if (!saved) return;
    siteInput.value = "";
    sizeInput.value = "";
    limitStatus.textContent = "Daily limit saved.";
  });
});

/* ------------------------------------------------------------------ *
 * Data Saver
 * ------------------------------------------------------------------ */

async function loadOptimize(): Promise<void> {
  try {
    const response = await sendRequest({ type: "GET_OPTIMIZE" });
    renderOptimize(response.optimize);
  } catch (error) {
    optimizeNote.textContent = errorMessage(error, "Could not read Data Saver.");
  }
}

async function changeOptimize(changes: Partial<OptimizeSettings>): Promise<void> {
  optimizeToggle.disabled = true;
  for (const toggle of optimizeFeatureToggles) toggle.disabled = true;
  optimizeNote.textContent = "Saving…";
  try {
    const response = await sendRequest({ type: "SAVE_OPTIMIZE", changes });
    renderOptimize(response.optimize);
    optimizeNote.textContent = "Saved";
  } catch (error) {
    const message = errorMessage(error, "Could not save Data Saver.");
    await loadOptimize();
    optimizeNote.textContent = message;
  } finally {
    optimizeToggle.disabled = false;
    for (const toggle of optimizeFeatureToggles) toggle.disabled = false;
  }
}

function renderOptimize(settings: OptimizeSettings): void {
  optimize = settings;
  optimizeToggle.checked = settings.enabled;
  optimizeBody.hidden = !settings.enabled;
  mediaOnClickToggle.checked = settings.features.clickToLoadMedia;
  preloadToggle.checked = settings.features.dropHints;
  systemFontsToggle.checked = settings.features.systemFonts;
  optimizeNote.dataset.active = String(settings.enabled);
  optimizeNote.textContent = "";
  exclusionCount.textContent =
    settings.exclusions.length === 0
      ? "None"
      : `${formatCount(settings.exclusions.length)} excluded`;

  replaceChildren(
    exclusionList,
    settings.exclusions.length === 0
      ? [element("li", { className: "field-hint", text: "No exceptions." })]
      : settings.exclusions.map((site) =>
          element("li", { className: "chip" }, [
            site,
            button("", {
              text: "×",
              ariaLabel: `Use Data Saver on ${site} again`,
              onClick: () =>
                void changeOptimize({
                  exclusions: settings.exclusions.filter((entry) => entry !== site),
                }),
            }),
          ]),
        ),
  );
}

function bindFeatureToggle(input: HTMLInputElement, feature: FeatureId): void {
  input.addEventListener("change", () => {
    void changeOptimize({
      features: { [feature]: input.checked } as OptimizeSettings["features"],
    });
  });
}

optimizeToggle.addEventListener("change", () => {
  void changeOptimize({ enabled: optimizeToggle.checked });
});
bindFeatureToggle(mediaOnClickToggle, "clickToLoadMedia");
bindFeatureToggle(preloadToggle, "dropHints");
bindFeatureToggle(systemFontsToggle, "systemFonts");

query<HTMLFormElement>("#exclusion-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = query<HTMLInputElement>("#exclusion-input");
  const site = siteKeyFromHost(input.value.trim());
  if (!site || !optimize) {
    optimizeNote.textContent = "Enter a website such as example.com.";
    return;
  }
  if (optimize.exclusions.includes(site)) {
    optimizeNote.textContent = `${site} is already excluded.`;
    return;
  }
  input.value = "";
  void changeOptimize({ exclusions: [...optimize.exclusions, site] });
});

/* ------------------------------------------------------------------ *
 * Appearance
 * ------------------------------------------------------------------ */

function selectorForDataset(key: string): string {
  const attribute = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return `[data-${attribute}]`;
}

function bindGroup<K extends keyof Settings>(
  id: string,
  datasetKey: string,
  key: K,
  parse: (raw: string) => Settings[K],
): void {
  const group = query<HTMLDivElement>(`#${id}`);
  const selector = selectorForDataset(datasetKey);

  const activate = (target: HTMLButtonElement) => {
    const raw = target.dataset[datasetKey];
    if (raw === undefined || target.getAttribute("aria-checked") === "true") return;
    void applySettings({ [key]: parse(raw) } as Partial<Settings>);
  };

  group.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>(selector);
    if (target) activate(target);
  });

  group.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      return;
    }
    const options = [...group.querySelectorAll<HTMLButtonElement>(selector)];
    const current = (event.target as HTMLElement).closest<HTMLButtonElement>(selector);
    if (!current || options.length === 0) return;
    event.preventDefault();
    const index = options.indexOf(current);
    const next =
      event.key === "Home"
        ? options[0]
        : event.key === "End"
          ? options.at(-1)
          : options[
              (index +
                (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) +
                options.length) %
                options.length
            ];
    if (!next) return;
    next.focus();
    activate(next);
  });
}

function paintGroup(id: string, datasetKey: string, value: string): void {
  const selector = selectorForDataset(datasetKey);
  for (const node of query<HTMLDivElement>(`#${id}`).querySelectorAll<HTMLButtonElement>(selector)) {
    const selected = node.dataset[datasetKey] === value;
    node.setAttribute("aria-checked", String(selected));
    node.tabIndex = selected ? 0 : -1;
  }
}

async function applySettings(changes: Partial<Settings>): Promise<void> {
  settingsStatus.textContent = "Saving…";
  try {
    const { settings } = await sendRequest({ type: "SAVE_SETTINGS", changes });
    paintSettings(settings);
    settingsStatus.textContent = "Saved";
  } catch (error) {
    const message = errorMessage(error, "Could not save that setting.");
    settingsStatus.textContent = message;
    liveRegion.textContent = message;
  }
}

function paintSettings(settings: Settings): void {
  units = settings.units;
  applyTheme(settings.theme);
  paintGroup("theme-group", "themeValue", settings.theme);
  badgeToggle.checked = settings.badge === "today";
}

async function loadSettings(): Promise<void> {
  try {
    const { settings } = await sendRequest({ type: "GET_SETTINGS" });
    paintSettings(settings);
  } catch (error) {
    liveRegion.textContent = errorMessage(error, "Could not read settings.");
  }
}

bindGroup("theme-group", "themeValue", "theme", (raw) => raw as Settings["theme"]);
badgeToggle.addEventListener("change", () => {
  void applySettings({ badge: badgeToggle.checked ? "today" : "off" });
});

/* ------------------------------------------------------------------ *
 * Privacy and data
 * ------------------------------------------------------------------ */

async function download(format: "csv" | "json"): Promise<void> {
  const days = Number(query<HTMLSelectElement>("#export-days").value) || 30;
  try {
    const file = await sendRequest({ type: "EXPORT", format, days });
    const blob = new Blob([file.body], { type: `${file.mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = element("a");
    link.href = url;
    link.download = file.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    dataStatus.textContent = `Wrote ${file.filename}.`;
  } catch (error) {
    dataStatus.textContent = errorMessage(error, "Could not export.");
  }
}

query<HTMLButtonElement>("#export-csv").addEventListener("click", () => void download("csv"));
query<HTMLButtonElement>("#export-json").addEventListener("click", () => void download("json"));
query<HTMLButtonElement>("#clear-data").addEventListener("click", () => {
  const confirmed = confirm(
    "Delete every recorded byte count? Settings are kept. This cannot be undone.",
  );
  if (!confirmed) return;
  void (async () => {
    try {
      await sendRequest({ type: "CLEAR_DATA" });
      dataStatus.textContent = "Deleted.";
    } catch (error) {
      dataStatus.textContent = errorMessage(error, "Could not delete.");
    }
  })();
});

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

onSettingsChanged((settings) => paintSettings(settings));

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  void loadLimits();
  void loadOptimize();
});

async function start(): Promise<void> {
  renderImpactMeters();
  await loadSettings();
  await Promise.all([loadLimits(), loadOptimize()]);
}

void start();

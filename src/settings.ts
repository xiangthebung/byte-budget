import "./dashboard.css";
import { bindGroup, button, element, paintGroup, query, replaceChildren } from "./core/dom";
import {
  formatAgo,
  formatBytes,
  formatCount,
  formatPercent,
  parseByteSize,
} from "./core/format";
import {
  errorMessage,
  sendRequest,
  type BudgetStatus,
  type StorageReport,
} from "./core/messages";
import { cycleElapsed, cycleRange, cycleResetsAt, formatDayShort } from "./core/period";
import { applyTheme, onSettingsChanged } from "./core/settings";
import { hostFromUrl, normalizeHost, siteKeyFromHost } from "./core/sites";
import {
  ALL_SITES,
  MAX_CYCLE_START_DAY,
  RETENTION_OPTIONS,
  type Settings,
} from "./core/types";
import { ALERT_THRESHOLDS, type AlertSettings } from "./limit/alerts";
import {
  BUDGET_PERIODS,
  BUDGET_PERIOD_LABELS,
  BUDGET_SHAPE_LABELS,
  PROGRESSIVE_THRESHOLDS,
  type BudgetPeriod,
  type BudgetShape,
} from "./limit/budgets";
import { TIER_DESCRIPTIONS, TIER_LABELS } from "./limit/tiers";
import { PACKS } from "./optimize/packs";
import {
  FEATURES,
  HOLDOUT_OPTIONS,
  SAVINGS_IMPACT_BY_FEATURE,
  type FeatureId,
  type FeatureInfo,
  type OptimizeSettings,
  type SavingsImpact,
} from "./optimize/features";

const planForm = query<HTMLFormElement>("#plan-form");
const planSizeInput = query<HTMLInputElement>("#plan-size");
const planCycleSelect = query<HTMLSelectElement>("#plan-cycle");
const planEcho = query<HTMLSpanElement>("#plan-echo");
const planNote = query<HTMLSpanElement>("#plan-note");
const planStatus = query<HTMLParagraphElement>("#plan-status");
const planShapeGroup = query<HTMLDivElement>("#plan-shape-group");
const planShapeHint = query<HTMLParagraphElement>("#plan-shape-hint");
const planAllowance = query<HTMLDivElement>("#plan-allowance");

const limitsTable = query<HTMLTableElement>("#limits-table");
const limitsBody = query<HTMLTableSectionElement>("#limits-table tbody");
const limitsEmpty = query<HTMLParagraphElement>("#limits-empty");
const limitsNote = query<HTMLSpanElement>("#limits-note");
const limitStatus = query<HTMLParagraphElement>("#limit-form-status");
const limitPeriodGroup = query<HTMLDivElement>("#limit-period-group");
const limitShapeField = query<HTMLDivElement>("#limit-shape-field");

const optimizeToggle = query<HTMLInputElement>("#optimize-toggle");
const optimizeBody = query<HTMLDivElement>("#optimize-body");
const optimizeNote = query<HTMLParagraphElement>("#optimize-note");
const featureGroups = query<HTMLDivElement>("#feature-groups");
const packList = query<HTMLDivElement>("#pack-list");
const packsIntro = query<HTMLParagraphElement>("#packs-intro");
const holdoutGroup = query<HTMLDivElement>("#holdout-group");
const holdoutHint = query<HTMLParagraphElement>("#holdout-hint");
const exclusionCount = query<HTMLSpanElement>("#exclusion-count");
const exclusionList = query<HTMLUListElement>("#exclusion-list");

const alertOptions = query<HTMLDivElement>("#alert-options");
const alertsStatus = query<HTMLSpanElement>("#alerts-status");
const alertsPlanNote = query<HTMLParagraphElement>("#alerts-plan-note");

const settingsStatus = query<HTMLSpanElement>("#settings-status");
const unitsHint = query<HTMLSpanElement>("#units-hint");
const periodOptions = query<HTMLDivElement>("#period-options");

const privacyOptions = query<HTMLDivElement>("#privacy-options");
const dataStatus = query<HTMLParagraphElement>("#data-status");
const deleteScopeNote = query<HTMLParagraphElement>("#delete-scope-note");
const deleteActions = query<HTMLDivElement>("#delete-actions");
const deleteStatus = query<HTMLParagraphElement>("#delete-status");
const storageDetails = query<HTMLDetailsElement>("#storage-details");
const storageReportBlock = query<HTMLDivElement>("#storage-report");

const liveRegion = query<HTMLParagraphElement>("#live-region");

let units: Settings["units"] = "si";
let settings: Settings | null = null;
let optimize: OptimizeSettings | null = null;
let statuses: readonly BudgetStatus[] = [];
let alerts: AlertSettings | null = null;

function bytes(value: number): string {
  return formatBytes(value, units);
}

/** Every optimize input, so a save can disable the lot without naming them. */
const optimizeInputs: HTMLInputElement[] = [];

function ordinal(day: number): string {
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/* ------------------------------------------------------------------ *
 * Shared controls
 * ------------------------------------------------------------------ */

interface SwitchOptions {
  id: string;
  label: string;
  hint?: string;
  onChange: (checked: boolean) => void;
}

/** A labelled switch inside a `.field`, matching the Toolbar control's markup. */
function switchField(options: SwitchOptions): { field: HTMLDivElement; input: HTMLInputElement } {
  const input = element("input");
  input.type = "checkbox";
  input.id = options.id;
  input.addEventListener("change", () => options.onChange(input.checked));

  const field = element("div", { className: "field" }, [
    element("label", { className: "switch-control preference-switch" }, [
      input,
      element("span", { className: "switch-track", ariaHidden: true }, [element("span")]),
      element("span", { className: "switch-label", text: options.label }),
    ]),
    options.hint ? element("span", { className: "field-hint", text: options.hint }) : null,
  ]);
  return { field, input };
}

interface CheckOptions {
  id: string;
  symbol: string;
  symbolIsText: boolean;
  title: string;
  hint: string;
  /** Rendered under the hint, for what the shipped description does not say. */
  note?: string;
  impact?: FeatureId;
  onChange: (checked: boolean) => void;
}

/** One `.advanced-option` card: checkbox, glyph, title, description. */
function checkCard(options: CheckOptions): { card: HTMLLabelElement; input: HTMLInputElement } {
  const input = element("input");
  input.type = "checkbox";
  input.id = options.id;
  input.addEventListener("change", () => options.onChange(input.checked));

  const card = element("label", { className: "advanced-option" }, [
    input,
    element("span", {
      className: options.symbolIsText ? "advanced-symbol advanced-symbol-text" : "advanced-symbol",
      text: options.symbol,
      ariaHidden: true,
    }),
    element("span", { className: "advanced-copy" }, [
      element("span", { className: "advanced-heading" }, [
        element("span", { className: "advanced-title", text: options.title }),
        options.impact
          ? element("span", {
              className: "impact-meter",
              dataset: { impactFeature: options.impact },
            })
          : null,
      ]),
      element("span", { className: "advanced-hint", text: options.hint }),
      options.note ? element("span", { className: "advanced-hint", text: options.note }) : null,
    ]),
  ]);
  return { card, input };
}

function fillSelect(
  node: HTMLSelectElement,
  options: readonly { value: string; label: string }[],
  value: string,
): void {
  replaceChildren(
    node,
    options.map((entry) => {
      const option = element("option", { text: entry.label });
      option.value = entry.value;
      return option;
    }),
  );
  node.value = value;
}

/** A `<th>` with the `scope` a screen reader needs to pair it with its column. */
function headerCell(text: string, numeric = false): HTMLTableCellElement {
  const cell = element("th", numeric ? { className: "numeric", text } : { text });
  cell.scope = "col";
  return cell;
}

/** A `.field` holding a label and an empty segmented group, wired by `bindGroup`. */
function groupField(
  id: string,
  label: string,
  hint?: string,
): { field: HTMLDivElement; group: HTMLDivElement } {
  const labelNode = element("span", { className: "field-label", text: label });
  labelNode.id = `${id}-label`;
  const group = element("div", { className: "segmented" });
  group.id = id;
  group.setAttribute("aria-labelledby", labelNode.id);
  const field = element("div", { className: "field" }, [
    labelNode,
    group,
    hint ? element("span", { className: "field-hint", text: hint }) : null,
  ]);
  return { field, group };
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
 * Reading a site out of what someone typed
 * ------------------------------------------------------------------ */

/**
 * Both forms on this page used to accept anything `siteKeyFromHost` did not return
 * `""` for, which is almost anything.
 *
 * `"YouTube"` has no public suffix, so it came back as the site key `youtube` — a
 * budget that can never match a request, sitting in the table at 0% forever. A pasted
 * `https://youtube.com/watch` tripped the IPv6 colon guard in `sites.ts` and the whole
 * URL became the key, with the same result. Both said "Daily limit saved."
 *
 * So the shape is checked here rather than inferred from a non-empty return, and the
 * two cases people actually type — a pasted address, and a bare name with no ending —
 * are handled and named rather than silently accepted. An IP address and `localhost`
 * are deliberately allowed: they are real origins a person can be metered on, and
 * `siteKeyFromHost` keys them unchanged.
 */
type SiteInput = { site: string } | { error: string };

const HOST_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const DOMAIN_ENDING = /^[a-z]{2,}$/;

function siteFromInput(raw: string): SiteInput {
  const text = raw.trim();
  if (!text) return { error: "Which website is it for?" };

  let host: string;
  if (text.includes("://")) {
    const parsed = hostFromUrl(text);
    if (!parsed) return { error: "Only http and https addresses can be used here." };
    host = parsed;
  } else {
    // What the address bar hands over when you copy: no scheme, but a path and a query.
    host = normalizeHost(text.split(/[/?#]/)[0] ?? "");
  }

  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);

  const colon = host.indexOf(":");
  if (colon >= 0) {
    const port = host.slice(colon + 1);
    // A port is dropped; an IPv6 literal is refused. `sites.ts` cannot key one — its
    // colon guard sends the whole string through untouched — and Chrome matches a rule
    // by domain name, so the limit would exist and never fire.
    if (!/^\d+$/.test(port)) {
      return { error: "Byte Budget matches sites by name, so an IPv6 address cannot be used." };
    }
    host = host.slice(0, colon);
  }

  if (!host) return { error: "Which website is it for?" };
  if (!HOST_SHAPE.test(host)) {
    return { error: `"${text}" is not a website address. One looks like example.com.` };
  }

  const labels = host.split(".");
  const ending = labels[labels.length - 1] ?? "";
  if (host !== "localhost" && !IPV4.test(host)) {
    if (labels.length < 2) {
      return { error: `"${host}" has no domain ending. Try "${host}.com", or paste the address.` };
    }
    if (!DOMAIN_ENDING.test(ending)) {
      return { error: `"${host}" does not end in something like .com or .org.` };
    }
  }

  const site = siteKeyFromHost(host);
  if (!site) return { error: "Which website is it for?" };
  return { site };
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

/**
 * What the plan size does, beyond being reported against.
 *
 * `Settings.planBytes` on its own changes nothing the governor can act on: it counts
 * usage only for sites that have a `Budget`, and the plan alert reads the allowance
 * keyed `ALL_SITES`. So every path here that writes the plan size also writes — or
 * removes — that budget, and this is the choice of what the budget then does.
 *
 * `watch` is the honest name for "no budget at all": nothing is refused, and the plan
 * alert has nothing to check. It is offered because typing a plan size is not consent
 * to have the browser start refusing things, and hidden if it is not offered.
 */
type PlanEnforcement = BudgetShape | "watch";

const PLAN_ENFORCEMENT_LABELS: Record<PlanEnforcement, string> = {
  watch: "Just measure",
  progressive: "Shed weight",
  hard: "Hard stop",
};

const PLAN_ENFORCEMENT_HINTS: Record<PlanEnforcement, string> = {
  watch:
    "Nothing is ever refused, and there is no allowance for an alert to check — so plan alerts stay quiet. The dashboard still measures the cycle against the plan.",
  progressive:
    "Across every site: video and audio stop at 60% of the plan, images and web fonts at 85%, everything but the page itself at 100%.",
  hard:
    "Nothing changes until the plan is spent. After that only pages themselves load, until the allowance rolls over, or you pause it, or you add bytes to this window.",
};

/**
 * Default for a plan that has never had an allowance.
 *
 * `hard` rather than `progressive`, which is the default everywhere else: a per-site
 * budget shedding video at 60% affects the one site someone chose to cap, and the same
 * shape on the budget over everything would stop video on every site for the last 40%
 * of the month — a consequence nobody asked for by answering "how big is your plan".
 */
let planEnforcement: PlanEnforcement = "hard";

function totalStatus(): BudgetStatus | null {
  return statuses.find((status) => status.budget.site === ALL_SITES) ?? null;
}

function cycleDayOptions(): { value: string; label: string }[] {
  const options = [{ value: "0", label: "The 1st (calendar month)" }];
  for (let day = 2; day <= MAX_CYCLE_START_DAY; day++) {
    options.push({ value: String(day), label: `The ${ordinal(day)}` });
  }
  return options;
}

function paintPlanEcho(): void {
  const raw = planSizeInput.value.trim();
  if (!raw) {
    planEcho.textContent = "Empty removes the plan.";
    return;
  }
  const size = parseByteSize(raw);
  // Echoed on every keystroke, because the one thing a size field cannot do is take a
  // number and mean a different one. "1,5 GB" is 1.5 GB in most of the world and 15 GB
  // in some parsers; whichever this build reads it as, it says so before you save.
  planEcho.textContent =
    size === null || size <= 0 ? "Cannot read that as a size." : `Reads as ${bytes(size)}.`;
}

function paintPlan(): void {
  if (!settings) return;

  if (document.activeElement !== planSizeInput) {
    planSizeInput.value = settings.planBytes === null ? "" : bytes(settings.planBytes);
    paintPlanEcho();
  }
  // 0 and 1 name the same reset date — `cycleAnchor` collapses them — so the picker
  // offers one of the two and a stored 1 paints as it.
  planCycleSelect.value = String(settings.cycleStartDay === 1 ? 0 : settings.cycleStartDay);

  const total = totalStatus();
  if (total) planEnforcement = total.budget.shape;
  else if (settings.planBytes !== null) planEnforcement = "watch";
  paintGroup(planShapeGroup, planEnforcement);
  planShapeHint.textContent = PLAN_ENFORCEMENT_HINTS[planEnforcement];

  planNote.textContent =
    settings.planBytes === null
      ? "No plan set"
      : `${bytes(settings.planBytes)} · resets ${formatAgo(cycleResetsAt(settings))}`;

  replaceChildren(planAllowance, planAllowanceBlock(settings, total));
  // The alerts panel's warning depends on whether that allowance exists, and this is
  // the only place that knows it just changed.
  paintAlertNote();
}

function planAllowanceBlock(current: Settings, total: BudgetStatus | null): Node[] {
  if (current.planBytes === null) {
    return [
      element("p", {
        className: "empty friendly-empty",
        text: "No plan set. Until there is one the dashboard can only show totals: no share of a plan, no projection, and nothing for a plan alert to check.",
      }),
    ];
  }

  const range = cycleRange(current);
  const elapsed = cycleElapsed(current);
  const nodes: Node[] = [
    element("p", {
      className: "field-hint",
      text: `This cycle started ${formatDayShort(range.from)} — day ${formatCount(
        elapsed.elapsedDays,
      )} of ${formatCount(elapsed.totalDays)}, resets ${formatAgo(cycleResetsAt(current))}.`,
    }),
  ];

  if (!total) {
    nodes.push(
      element("p", {
        className: "field-hint",
        text: `${PLAN_ENFORCEMENT_LABELS.watch} is selected, so there is no allowance over everything. Nothing is refused and plan alerts have nothing to measure against.`,
      }),
    );
    return nodes;
  }

  nodes.push(allowanceCard(total));

  // No disclaimer here any more. A `month` budget's window is now placed by
  // `startOfCycle`, the same function the projection and the "resets in N days" line
  // use, so the allowance rolls over on the reset day rather than on the 1st. This
  // used to print a paragraph admitting the two disagreed; saying it now would be the
  // mirror of the defect that started this audit — a document describing a product
  // that does not exist.
  return nodes;
}

function allowanceCard(status: BudgetStatus): HTMLElement {
  const state = statusWords(status);
  return element("div", { className: "exception-settings" }, [
    element("div", { className: "exception-head" }, [
      element("span", { className: "field-label", text: "Allowance over everything" }),
      element("span", {
        className: "summary-note",
        text: status.resetsAt
          ? `${BUDGET_PERIOD_LABELS[status.budget.period]} · resets ${formatAgo(status.resetsAt)}`
          : BUDGET_PERIOD_LABELS[status.budget.period],
      }),
    ]),
    meter(status),
    element("p", {}, [
      element("span", {
        className: "state-chip",
        text: state.text,
        dataset: state.tone ? { tone: state.tone } : {},
      }),
      status.tier === "off" ? null : ` ${TIER_LABELS[status.tier]} — ${TIER_DESCRIPTIONS[status.tier]}`,
    ]),
    // No Remove here. Removing this budget is what "Just measure" above does, and it
    // has to be that control rather than this button, because dropping the allowance
    // without saying so leaves plan alerts silently checking nothing.
    element("div", { className: "row-actions" }, rowActions(status, false)),
  ]);
}

async function savePlan(): Promise<void> {
  const raw = planSizeInput.value.trim();
  const cycleStartDay = Number(planCycleSelect.value);
  const size = raw ? parseByteSize(raw) : null;

  if (raw && (size === null || size <= 0)) {
    planStatus.textContent = `Could not read "${raw}" as a size. Try 15 GB or 500 MB.`;
    return;
  }

  // Captured before anything renders. `paintPlan` re-derives this from the stored
  // budgets, and between the settings write and the budget write there is no budget yet
  // — so reading the global afterwards would turn a chosen "Hard stop" into "Just
  // measure" and quietly save a plan with no allowance behind it.
  const enforcement = planEnforcement;

  planStatus.textContent = "Saving…";
  try {
    const response = await sendRequest({
      type: "SAVE_SETTINGS",
      changes: { planBytes: size, cycleStartDay },
    });
    paintSettings(response.settings);
    await applyPlanAllowance(size, enforcement);
    planStatus.textContent =
      size === null
        ? "Plan removed."
        : `Plan saved: ${bytes(size)}, resetting ${
            response.settings.cycleStartDay === 0
              ? "on the 1st"
              : `on ${ordinal(response.settings.cycleStartDay)}`
          }.`;
  } catch (error) {
    const message = errorMessage(error, "Could not save the plan.");
    planStatus.textContent = message;
    liveRegion.textContent = message;
  }
}

/**
 * Keeps the `ALL_SITES` budget in step with the plan size.
 *
 * Called from every path that writes `planBytes`, including the one that clears it.
 * A plan whose allowance was left behind would keep enforcing and alerting on a figure
 * the settings no longer hold, and a plan with no allowance is a plan alert that can
 * never fire — which is the default-on alert doing nothing for everyone.
 */
async function applyPlanAllowance(
  planBytes: number | null,
  enforcement: PlanEnforcement,
): Promise<void> {
  const response =
    planBytes === null || enforcement === "watch"
      ? await sendRequest({ type: "REMOVE_BUDGET", site: ALL_SITES })
      : await sendRequest({
          type: "PUT_BUDGET",
          site: ALL_SITES,
          bytes: planBytes,
          period: "month",
          shape: enforcement,
        });
  renderLimits(response.statuses);
}

async function choosePlanEnforcement(value: PlanEnforcement): Promise<void> {
  planEnforcement = value;
  paintGroup(planShapeGroup, value);
  planShapeHint.textContent = PLAN_ENFORCEMENT_HINTS[value];
  if (!settings || settings.planBytes === null) {
    planStatus.textContent = "Set a plan size for this to apply to.";
    return;
  }
  planStatus.textContent = "Saving…";
  try {
    await applyPlanAllowance(settings.planBytes, value);
    planStatus.textContent = "Saved.";
  } catch (error) {
    planStatus.textContent = errorMessage(error, "Could not change the allowance.");
  }
}

planForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void savePlan();
});
planSizeInput.addEventListener("input", paintPlanEcho);

/* ------------------------------------------------------------------ *
 * Site limits
 * ------------------------------------------------------------------ */

/** The site being edited in place, so a refresh cannot pull the field out. */
let editingSite: string | null = null;
let deferredStatuses: readonly BudgetStatus[] | null = null;

let formPeriod: BudgetPeriod = "day";
let formHard = false;

const PERIOD_OPTION_LABELS: Record<BudgetPeriod, string> = {
  session: "Session",
  day: "Day",
  week: "Week",
  month: "Month",
};

/** What "add some more" is called for each window. */
const GRANT_WINDOW_LABELS: Record<BudgetPeriod, string> = {
  session: "this session",
  day: "today",
  week: "this week",
  month: "this month",
};

async function loadLimits(): Promise<void> {
  try {
    const { statuses: loaded } = await sendRequest({ type: "GET_BUDGETS" });
    renderLimits(loaded);
  } catch (error) {
    limitStatus.textContent = errorMessage(error, "Could not read the limits.");
  }
}

function renderLimits(loaded: readonly BudgetStatus[]): void {
  statuses = loaded;
  // An open editor is a field with a half-typed number in it. A refresh arriving from
  // the visibility listener would otherwise replace the row and lose it mid-edit.
  if (editingSite) {
    deferredStatuses = loaded;
    return;
  }

  const rows = loaded.filter((status) => status.budget.site !== ALL_SITES);
  limitsEmpty.hidden = rows.length > 0;
  limitsTable.hidden = rows.length === 0;
  limitsNote.textContent =
    rows.length === 0
      ? ""
      : `${formatCount(rows.length)} ${rows.length === 1 ? "limit" : "limits"}`;

  replaceChildren(
    limitsBody,
    [...rows].sort((a, b) => b.share - a.share).map((status) => limitRow(status)),
  );
  paintPlan();
}

function endEditing(): void {
  const pending = deferredStatuses;
  editingSite = null;
  deferredStatuses = null;
  if (pending) renderLimits(pending);
}

/**
 * The status column says what the user's position is, and the tier below it says what
 * that costs.
 *
 * It used to print the tier name alone — "Page shell only" — which is the mechanism,
 * names no state, and never contains the word "over".
 */
function statusWords(status: BudgetStatus): { text: string; tone: string } {
  if (status.snoozed) {
    const until = status.budget.snoozedUntil;
    return { text: until ? `Paused · resumes ${formatAgo(until)}` : "Paused", tone: "paused" };
  }
  if (status.share >= 1) return { text: "Over limit", tone: "enforcing" };
  if (status.share >= 0.85) return { text: "Nearly full", tone: "enforcing" };
  return { text: "Within limit", tone: "" };
}

function meter(status: BudgetStatus): HTMLElement {
  const over = status.share >= 1;
  return element("span", { className: "limit-meter" }, [
    element("span", {
      text: `${bytes(status.used)} of ${bytes(status.allowance)} · ${formatPercent(status.share)}`,
    }),
    element("span", { className: "limit-meter-track", ariaHidden: true }, [
      element("span", {
        className: "limit-meter-fill",
        style: { width: `${Math.min(100, Math.max(1, status.share * 100)).toFixed(1)}%` },
        dataset: over ? { over: "true" } : {},
      }),
    ]),
  ]);
}

/**
 * How much "add a bit more" adds.
 *
 * A quarter of the allowance, floored at 5 MB and capped at 500 MB, rounded to
 * something a person would say out loud. The old figure was a hard-coded 25 MB against
 * whatever the budget happened to be: on the 800 kB budget in the browser test it
 * multiplied the allowance by 32 and effectively deleted the limit, and on 10 GB a
 * month it was a quarter of one percent.
 */
function grantSize(allowance: number): number {
  const raw = Math.min(500_000_000, Math.max(5_000_000, allowance * 0.25));
  const step = 10 ** Math.max(6, Math.floor(Math.log10(raw)));
  return Math.max(step, Math.round(raw / step) * step);
}

function rowActions(status: BudgetStatus, removable = true): HTMLElement[] {
  const site = status.budget.site;
  const size = grantSize(status.allowance);
  const actions: HTMLElement[] = [
    button("ghost-button", {
      text: `+${bytes(size)} ${GRANT_WINDOW_LABELS[status.budget.period]}`,
      title: `Raises the allowance to ${bytes(status.allowance + size)} until it resets. ${
        status.budget.period === "session" ? "Only for this session." : "Only for this window."
      }`,
      onClick: () => void changeLimit({ type: "GRANT_BYTES", site, bytes: size }),
    }),
    status.snoozed
      ? button("ghost-button", {
          text: "Resume",
          title: "Start enforcing this limit again now",
          onClick: () => void changeLimit({ type: "RESUME_BUDGET", site }),
        })
      : button("ghost-button", {
          text: "Pause 1 h",
          title: "Stop refusing anything for an hour. The counter keeps running.",
          onClick: () => void changeLimit({ type: "SNOOZE_BUDGET", site, minutes: 60 }),
        }),
  ];

  if (removable) {
    actions.push(
      button("ghost-button", {
        text: "Remove",
        dataset: { danger: "true" },
        title: "Deletes the limit and lifts anything it is refusing right now",
        onClick: () => void changeLimit({ type: "REMOVE_BUDGET", site }),
      }),
    );
  }
  return actions;
}

function limitRow(status: BudgetStatus): HTMLTableRowElement {
  const site = status.budget.site;
  const state = statusWords(status);

  /*
   * `data-label` repeats the column heading on each cell so the narrow layout can
   * drop the header row and still say what each figure is: under 640px the six
   * columns become one card per limit (see `#limits-table` in `dashboard.css`).
   * The site and the actions are left unlabelled — the hostname is the card's
   * title and the buttons name themselves.
   */
  // Built before the button, because the button's job is to replace this cell's
  // contents with the editor and it needs somewhere to put them.
  const limitCell = element("td", { dataset: { label: "Limit" } });
  replaceChildren(limitCell, [
    element("span", { className: "limit-meter" }, [
      // Wrapped so the button keeps its own width: `.limit-meter` is a grid, and a
      // grid item stretches to the 130px column.
      element("span", {}, [
        button("ghost-button", {
          text: `${bytes(status.budget.bytes)} ${BUDGET_PERIOD_LABELS[status.budget.period]}`,
          ariaLabel: `Change the allowance for ${site}`,
          title: "Change this allowance",
          onClick: () => startEditing(status, limitCell),
        }),
      ]),
      element("span", {
        className: "field-hint",
        text: BUDGET_SHAPE_LABELS[status.budget.shape],
      }),
    ]),
  ]);

  return element("tr", {}, [
    element("td", {}, [element("span", { className: "host-name", text: site, title: site })]),
    limitCell,
    element("td", { className: "numeric", dataset: { label: "Used" } }, [meter(status)]),
    element("td", { dataset: { label: "Status" } }, [
      element("span", { className: "limit-meter" }, [
        // The chip is wrapped rather than placed straight into the grid: it is
        // `inline-block`, and a grid item stretches to the column width, which would
        // draw a 130px-wide pill around a two-word status.
        element("span", {}, [
          element("span", {
            className: "state-chip",
            text: state.text,
            dataset: state.tone ? { tone: state.tone } : {},
          }),
        ]),
        status.tier === "off"
          ? null
          : element("span", {
              className: "field-hint",
              text: TIER_LABELS[status.tier],
              title: TIER_DESCRIPTIONS[status.tier],
            }),
      ]),
    ]),
    element("td", {
      dataset: { label: "Resets" },
      text: status.resetsAt ? formatAgo(status.resetsAt) : "on browser close",
    }),
    element("td", {}, [element("span", { className: "row-actions" }, rowActions(status))]),
  ]);
}

/* ------------------------------------------------------------------ *
 * Editing an allowance in place
 * ------------------------------------------------------------------ */

interface ByteUnit {
  readonly label: string;
  readonly factor: number;
}

const SI_EDIT_UNITS: readonly ByteUnit[] = [
  { label: "kB", factor: 1000 },
  { label: "MB", factor: 1_000_000 },
  { label: "GB", factor: 1_000_000_000 },
];

const IEC_EDIT_UNITS: readonly ByteUnit[] = [
  { label: "KiB", factor: 1024 },
  { label: "MiB", factor: 1024 ** 2 },
  { label: "GiB", factor: 1024 ** 3 },
];

function editUnits(): readonly ByteUnit[] {
  return units === "iec" ? IEC_EDIT_UNITS : SI_EDIT_UNITS;
}

/** The allowance as a number and a unit, so the field opens on what is already set. */
function splitForEdit(value: number): { amount: number; label: string } {
  const list = editUnits();
  let chosen = list[0] ?? { label: "B", factor: 1 };
  for (const unit of list) {
    if (value >= unit.factor) chosen = unit;
  }
  return { amount: Math.round((value / chosen.factor) * 1000) / 1000, label: chosen.label };
}

/**
 * Turns the allowance cell into a field.
 *
 * Without this, raising 800 MB to 1 GB meant retyping the domain into the add form —
 * which happens to overwrite the existing budget, with nothing in the UI saying so. The
 * row's own period and shape are sent back unchanged: an edit is a change of size, and
 * a form that quietly reset a monthly hard cap to a progressive daily one would be
 * worse than no editing at all.
 */
function startEditing(status: BudgetStatus, cell: HTMLTableCellElement): void {
  editingSite = status.budget.site;

  const start = splitForEdit(status.budget.bytes);
  const amount = element("input", { className: "search-input" });
  amount.type = "number";
  amount.min = "0";
  amount.step = "any";
  amount.value = String(start.amount);
  amount.setAttribute("aria-label", `Allowance for ${status.budget.site}`);

  const unit = element("select", { className: "select" });
  fillSelect(
    unit,
    editUnits().map((entry) => ({ value: entry.label, label: entry.label })),
    start.label,
  );
  unit.setAttribute("aria-label", "Unit");

  const cancelEdit = (): void => {
    const pending = deferredStatuses;
    editingSite = null;
    deferredStatuses = null;
    renderLimits(pending ?? statuses);
  };

  const save = element("button", { className: "primary-button", text: "Save" });
  save.type = "submit";

  const form = element("form", { className: "exclusion-form" }, [
    amount,
    unit,
    save,
    button("ghost-button", { text: "Cancel", onClick: cancelEdit }),
  ]);

  form.addEventListener("submit", (submit) => {
    submit.preventDefault();
    const factor = editUnits().find((entry) => entry.label === unit.value)?.factor;
    const value = amount.valueAsNumber;
    if (factor === undefined || !Number.isFinite(value) || value <= 0) {
      limitStatus.textContent = "Give the allowance a size above zero.";
      return;
    }
    editingSite = null;
    limitStatus.textContent = "Saving…";
    void changeLimit({
      type: "PUT_BUDGET",
      site: status.budget.site,
      bytes: Math.round(value * factor),
      period: status.budget.period,
      shape: status.budget.shape,
    }).then((saved) => {
      endEditing();
      if (!saved) return;
      limitStatus.textContent = `${status.budget.site} is now ${bytes(
        Math.round(value * factor),
      )} ${BUDGET_PERIOD_LABELS[status.budget.period]}.`;
    });
  });

  form.addEventListener("keydown", (key) => {
    if (key.key !== "Escape") return;
    key.preventDefault();
    cancelEdit();
  });

  replaceChildren(cell, [form]);
  amount.focus();
  amount.select();
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
  const parsed = siteFromInput(siteInput.value);
  const raw = sizeInput.value;
  const size = parseByteSize(raw);

  if ("error" in parsed) {
    limitStatus.textContent = parsed.error;
    siteInput.focus();
    return;
  }
  if (size === null || size <= 0) {
    limitStatus.textContent = `Could not read "${raw}" as a size. Try 500 MB or 1.5 GB.`;
    sizeInput.focus();
    return;
  }

  const site = parsed.site;
  const replacing = statuses.some((status) => status.budget.site === site);
  const shape: BudgetShape = formHard ? "hard" : "progressive";

  limitStatus.textContent = "Saving…";
  void changeLimit({ type: "PUT_BUDGET", site, bytes: size, period: formPeriod, shape }).then(
    (saved) => {
      if (!saved) return;
      siteInput.value = "";
      sizeInput.value = "";
      // Names the site key that was actually stored, which is the only signal that a
      // pasted URL was trimmed to a domain — and says when an existing limit was
      // replaced, which the form used to do silently.
      limitStatus.textContent = `${replacing ? "Replaced the limit on" : "Limit set for"} ${site}: ${bytes(
        size,
      )} ${BUDGET_PERIOD_LABELS[formPeriod]}, ${BUDGET_SHAPE_LABELS[shape].toLowerCase()}.`;
    },
  );
});

/* ------------------------------------------------------------------ *
 * Data Saver
 * ------------------------------------------------------------------ */

const VISIBILITY_GROUPS: readonly {
  key: FeatureInfo["visibility"];
  title: string;
  note: string;
}[] = [
  {
    key: "invisible",
    title: "Nothing on the page changes",
    note: "Only what the page is allowed to ask for changes. If one of these breaks something, it is a bug.",
  },
  {
    key: "subtle",
    title: "You may notice these",
    note: "Content can arrive later than it would have, or at a lower resolution than the page asked for.",
  },
  {
    key: "noticeable",
    title: "You will see these",
    note: "These change what a page looks like or how it behaves. They save the most.",
  },
];

const FEATURE_SYMBOLS: Record<FeatureId, { text: string; isText: boolean }> = {
  saveData: { text: "SD", isText: true },
  blockBeacons: { text: "×", isText: false },
  trimSrcset: { text: "px", isText: true },
  lazyOffscreen: { text: "↓", isText: false },
  tameMedia: { text: "II", isText: true },
  clickToLoadMedia: { text: "▶", isText: false },
  dropHints: { text: "↗", isText: false },
  systemFonts: { text: "Aa", isText: true },
};

/**
 * What a feature's shipped description does not say.
 *
 * `saveData` is the reason this exists. Its description is accurate about what the
 * header does and says nothing about what sending it costs: Chrome retired Lite mode,
 * so desktop Chrome has no setting that produces `Save-Data: on` — which makes an
 * install that sends it a rare and stable bit for anyone fingerprinting. The privacy
 * policy now says as much, and a control the policy describes has to exist on the page.
 */
const FEATURE_NOTES: Partial<Record<FeatureId, string>> = {
  saveData:
    "Cost: it also makes this browser easier to recognise. Desktop Chrome has no setting that sends this header, so sending it is a rare, stable signal a tracker can use. It is on by default; the image services below remove the same kind of bytes without announcing anything.",
};

const PACK_SYMBOLS: Record<string, string> = {
  twimg: "X",
  wikimedia: "W",
  photon: "WP",
  shopify: "Sh",
  shopifyWidth: "Sh",
  cloudinary: "Cl",
};

const featureInputs = new Map<FeatureId, HTMLInputElement>();
const packInputs = new Map<string, HTMLInputElement>();
const groupCounts = new Map<FeatureInfo["visibility"], HTMLSpanElement>();

/**
 * Built once, from `FEATURES`.
 *
 * Three of the eight used to be hand-written into the markup — exactly the three that
 * ship off — so `saveData`, `blockBeacons`, `trimSrcset`, `lazyOffscreen` and
 * `tameMedia` were on for everyone with no control anywhere. Iterating the table means
 * a feature added there cannot be forgotten here, and the `visibility` field it already
 * carries gives the ordering: what you cannot see first, what you can see last.
 *
 * Built once rather than per render, for the reason `bindGroup` documents: a rebuild on
 * every save destroys the checkbox the user just clicked, between the click and the
 * confirmation.
 */
function buildFeatureRows(): void {
  replaceChildren(
    featureGroups,
    VISIBILITY_GROUPS.map((group) => {
      const count = element("span", { className: "summary-note" });
      groupCounts.set(group.key, count);
      const cards = FEATURES.filter((feature) => feature.visibility === group.key).map(
        (feature) => {
          const symbol = FEATURE_SYMBOLS[feature.id];
          const note = FEATURE_NOTES[feature.id];
          const { card, input } = checkCard({
            id: `feature-${feature.id}`,
            symbol: symbol.text,
            symbolIsText: symbol.isText,
            title: feature.label,
            hint: feature.description,
            ...(note ? { note } : {}),
            ...(SAVINGS_IMPACT_BY_FEATURE[feature.id] ? { impact: feature.id } : {}),
            onChange: (checked) =>
              void changeOptimize({
                features: { [feature.id]: checked } as OptimizeSettings["features"],
              }),
          });
          featureInputs.set(feature.id, input);
          optimizeInputs.push(input);
          return card;
        },
      );

      return element("div", { className: "exception-settings" }, [
        element("div", { className: "exception-head" }, [
          element("span", { className: "field-label", text: group.title }),
          count,
        ]),
        element("p", { text: group.note }),
        element("div", { className: "advanced-options" }, cards),
      ]);
    }),
  );
}

/**
 * Per-pack switches.
 *
 * `OptimizeSettings.packs` is normalised, persisted and drives the redirect rules, and
 * until now no surface read or wrote it. When a rewrite comes back wrong the person
 * sees a broken picture with nothing saying an extension touched the URL, and the only
 * lever was excluding the whole site — which also gives up every other saving on it.
 */
function buildPackRows(): void {
  packsIntro.textContent =
    "Image services that serve a smaller version of the same file from the same path. Byte Budget rewrites the request before it is sent, so the smaller file is what crosses the wire. If pictures from one service look wrong, switch that service off rather than excluding the whole site.";

  replaceChildren(
    packList,
    PACKS.map((pack) => {
      const { card, input } = checkCard({
        id: `pack-${pack.id}`,
        symbol: PACK_SYMBOLS[pack.id] ?? pack.label.slice(0, 2),
        symbolIsText: true,
        title: pack.label,
        hint: pack.description,
        note: `Only ${pack.hosts.join(", ")}.`,
        onChange: (checked) => void changeOptimize({ packs: { [pack.id]: checked } }),
      });
      packInputs.set(pack.id, input);
      optimizeInputs.push(input);
      return card;
    }),
  );
}

function holdoutText(percent: number): string {
  if (percent === 0) {
    return "No page loads are held back. Savings are then the estimator's guess at what a refused request weighed, plus arithmetic wherever the original size of a rewritten image is already on file. The dashboard says which part is which.";
  }
  return `${percent}% of page loads are deliberately left unoptimized, so "saved" can be the difference between two sets of real page loads rather than a model of one. A held-back load costs the bytes the optimizer would have removed — real money on a metered connection. A site also gets up to three of them before this rate applies, so there is something to compare against at all.`;
}

/* ------------------------------------------------------------------ *
 * Data Saver: loading and painting
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
  // Disabling the control that was just pressed drops focus to `<body>`, and there are
  // fourteen of these now rather than three — so a keyboard user would Tab back from
  // the top of the page after every single toggle. Held here and restored below.
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  optimizeToggle.disabled = true;
  for (const input of optimizeInputs) input.disabled = true;
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
    for (const input of optimizeInputs) input.disabled = false;
    if (focused?.isConnected) focused.focus();
  }
}

/**
 * Paints state onto controls that already exist.
 *
 * Nothing with a `checked` state is rebuilt here — that is what would destroy the box
 * the user just clicked. The exclusion chips are the exception and have to be, because
 * their membership is the state.
 */
function renderOptimize(next: OptimizeSettings): void {
  optimize = next;
  optimizeToggle.checked = next.enabled;
  // The master switch collapses the panel, as it always has: with it off there are no
  // rules and no content script, so every control below it is describing something that
  // is not happening. The controls are built either way, so nothing here rebuilds them.
  optimizeBody.hidden = !next.enabled;
  optimizeNote.dataset.active = String(next.enabled);
  optimizeNote.textContent = "";

  for (const [id, input] of featureInputs) input.checked = next.features[id];
  for (const [id, input] of packInputs) input.checked = next.packs[id] ?? false;

  for (const group of VISIBILITY_GROUPS) {
    const inGroup = FEATURES.filter((feature) => feature.visibility === group.key);
    const on = inGroup.filter((feature) => next.features[feature.id]).length;
    const count = groupCounts.get(group.key);
    if (count) count.textContent = `${formatCount(on)} of ${formatCount(inGroup.length)} on`;
  }

  paintGroup(holdoutGroup, next.holdoutPercent);
  holdoutHint.textContent = holdoutText(next.holdoutPercent);

  exclusionCount.textContent =
    next.exclusions.length === 0 ? "None" : `${formatCount(next.exclusions.length)} excluded`;

  replaceChildren(
    exclusionList,
    next.exclusions.length === 0
      ? [element("li", { className: "field-hint", text: "No exceptions." })]
      : next.exclusions.map((site) =>
          element("li", { className: "chip" }, [
            site,
            button("", {
              text: "×",
              ariaLabel: `Use Data Saver on ${site} again`,
              onClick: () =>
                void changeOptimize({
                  exclusions: next.exclusions.filter((entry) => entry !== site),
                }),
            }),
          ]),
        ),
  );
}

optimizeToggle.addEventListener("change", () => {
  void changeOptimize({ enabled: optimizeToggle.checked });
});

query<HTMLFormElement>("#exclusion-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = query<HTMLInputElement>("#exclusion-input");
  const parsed = siteFromInput(input.value);
  if ("error" in parsed) {
    optimizeNote.textContent = parsed.error;
    return;
  }
  if (!optimize) {
    optimizeNote.textContent = "Data Saver settings are still loading.";
    return;
  }
  if (optimize.exclusions.includes(parsed.site)) {
    optimizeNote.textContent = `${parsed.site} is already an exception.`;
    return;
  }
  input.value = "";
  void changeOptimize({ exclusions: [...optimize.exclusions, parsed.site] });
});

/* ------------------------------------------------------------------ *
 * Alerts
 * ------------------------------------------------------------------ */

const alertInputs = new Map<keyof AlertSettings, HTMLInputElement>();

function buildAlertRows(): void {
  const rows: HTMLElement[] = [];
  const add = (key: keyof AlertSettings, label: string, hint: string): void => {
    const { field, input } = switchField({
      id: `alert-${key}`,
      label,
      hint,
      onChange: (checked) => void changeAlerts({ [key]: checked } as Partial<AlertSettings>),
    });
    alertInputs.set(key, input);
    rows.push(field);
  };
  add(
    "plan",
    "My whole plan",
    "The allowance over everything, from the plan above. On by default: a plan running out is the thing nobody is watching for.",
  );
  add(
    "sites",
    "A single site's limit",
    "Off by default: a limit you typed on a site you chose is one you expect to reach.",
  );
  replaceChildren(alertOptions, rows);
}

async function loadAlerts(): Promise<void> {
  try {
    const response = await sendRequest({ type: "GET_ALERTS" });
    renderAlerts(response.alerts);
  } catch (error) {
    alertsStatus.textContent = errorMessage(error, "Could not read the alert settings.");
  }
}

async function changeAlerts(changes: Partial<AlertSettings>): Promise<void> {
  alertsStatus.textContent = "Saving…";
  try {
    const response = await sendRequest({ type: "SAVE_ALERTS", changes });
    renderAlerts(response.alerts);
    alertsStatus.textContent = "Saved";
  } catch (error) {
    alertsStatus.textContent = errorMessage(error, "Could not save the alert settings.");
    await loadAlerts();
  }
}

function renderAlerts(next: AlertSettings): void {
  alerts = next;
  for (const [key, input] of alertInputs) input.checked = next[key];
  paintAlertNote();
}

/**
 * Says when plan alerts are switched on with nothing to alert on.
 *
 * That is the default state of a fresh install — the preference ships on and there is
 * no plan — and it is invisible from anywhere else, because the alert path simply finds
 * no `ALL_SITES` reading and returns.
 */
function paintAlertNote(): void {
  if (!alerts) {
    alertsPlanNote.textContent = "";
    return;
  }
  // Printed from `ALERT_THRESHOLDS` rather than typed into the markup, so the sentence
  // cannot end up describing a ladder the alerting module no longer uses.
  const thresholds = ALERT_THRESHOLDS.map((threshold) => formatPercent(threshold)).join(", ");
  const base = `Thresholds are fixed at ${thresholds}, and only the highest one crossed is sent — one large download cannot produce three notifications at once.`;
  alertsPlanNote.textContent =
    alerts.plan && !totalStatus()
      ? `${base} Plan alerts are on, but there is no allowance over everything for them to measure: set a plan size above and choose "${PLAN_ENFORCEMENT_LABELS.progressive}" or "${PLAN_ENFORCEMENT_LABELS.hard}".`
      : base;
}

/* ------------------------------------------------------------------ *
 * Appearance, units and periods
 * ------------------------------------------------------------------ */

async function applySettings(changes: Partial<Settings>): Promise<void> {
  settingsStatus.textContent = "Saving…";
  try {
    const response = await sendRequest({ type: "SAVE_SETTINGS", changes });
    paintSettings(response.settings);
    settingsStatus.textContent = "Saved";
  } catch (error) {
    const message = errorMessage(error, "Could not save that setting.");
    settingsStatus.textContent = message;
    liveRegion.textContent = message;
  }
}

let trackHostsInput: HTMLInputElement | null = null;

function paintSettings(next: Settings): void {
  settings = next;
  units = next.units;
  applyTheme(next.theme);
  paintGroup(query<HTMLDivElement>("#theme-group"), next.theme);
  paintGroup(query<HTMLDivElement>("#badge-group"), next.badge);
  paintGroup(query<HTMLDivElement>("#units-group"), next.units);
  paintGroup(query<HTMLDivElement>("#week-start-group"), next.weekStart);
  paintGroup(query<HTMLDivElement>("#week-mode-group"), next.weekMode);
  paintGroup(query<HTMLDivElement>("#month-mode-group"), next.monthMode);
  paintGroup(query<HTMLDivElement>("#retention-group"), next.retentionDays);
  if (trackHostsInput) trackHostsInput.checked = next.trackHosts;
  paintPlan();
  paintDeleteScope();
  // Re-rendered because every figure in them is formatted with `units`.
  if (!editingSite) renderLimits(statuses);
}

async function loadSettings(): Promise<void> {
  try {
    const response = await sendRequest({ type: "GET_SETTINGS" });
    paintSettings(response.settings);
  } catch (error) {
    liveRegion.textContent = errorMessage(error, "Could not read settings.");
  }
}

/* ------------------------------------------------------------------ *
 * Privacy and data
 * ------------------------------------------------------------------ */

const RETENTION_LABELS: Record<number, string> = {
  30: "30 days",
  90: "90 days",
  400: "400 days",
  0: "Forever",
};

function buildPrivacyOptions(): void {
  const retention = groupField(
    "retention-group",
    "Keep daily usage for",
    "Hourly detail is kept for 3 days whatever this says. Shortening it deletes the days outside the window at the next tidy-up, which runs every six hours.",
  );

  const hosts = switchField({
    id: "track-hosts-toggle",
    label: "Record which hosts a site's bytes came from",
    hint: "Off makes the per-site drill-down poorer and the database smaller. Rows already recorded stay until they age out.",
    onChange: (checked) => void applySettings({ trackHosts: checked }),
  });
  trackHostsInput = hosts.input;

  replaceChildren(privacyOptions, [retention.field, hosts.field]);

  bindGroup<number>({
    container: retention.group,
    options: RETENTION_OPTIONS.map((days) => ({
      value: days,
      label: RETENTION_LABELS[days] ?? `${days} days`,
    })),
    value: RETENTION_OPTIONS[0],
    onSelect: (value) => void applySettings({ retentionDays: value }),
  });
}

function paintDeleteScope(): void {
  const kept = settings
    ? (RETENTION_LABELS[settings.retentionDays] ?? `${settings.retentionDays} days`)
    : "";
  deleteScopeNote.textContent = `This deletes every recorded byte count in this profile: the daily and hourly rows, the per-host rows, one row per page load, the learned size estimator and the observed image sizes. Limits, exceptions and the settings on this page are kept. To remove only the older days instead, shorten "Keep daily usage for" above${
    kept ? ` — it is ${kept} now` : ""
  }.`;
}

let deleteArmed = false;

function renderDeleteActions(): void {
  if (!deleteArmed) {
    replaceChildren(deleteActions, [
      button("ghost-button", {
        text: "Delete all recorded usage",
        dataset: { danger: "true" },
        onClick: () => {
          deleteArmed = true;
          renderDeleteActions();
        },
      }),
    ]);
    return;
  }

  const confirmButton = button("ghost-button", {
    text: "Yes, delete everything recorded",
    dataset: { danger: "true" },
    onClick: () => void performDelete(),
  });
  replaceChildren(deleteActions, [
    confirmButton,
    button("ghost-button", {
      text: "Cancel",
      onClick: () => {
        deleteArmed = false;
        deleteStatus.textContent = "";
        renderDeleteActions();
      },
    }),
  ]);
  // Two steps in the page rather than one `confirm()` dialog: the sentence above says
  // what goes and what stays, which a modal cannot without being read as boilerplate.
  deleteStatus.textContent = "This cannot be undone, and nothing is exported first.";
  confirmButton.focus();
}

async function performDelete(): Promise<void> {
  deleteStatus.textContent = "Deleting…";
  try {
    await sendRequest({ type: "CLEAR_DATA" });
    deleteArmed = false;
    renderDeleteActions();
    deleteStatus.textContent = "Deleted. Every limit now starts its current window from zero.";
    await Promise.all([loadLimits(), loadStorageReport()]);
  } catch (error) {
    deleteStatus.textContent = errorMessage(error, "Could not delete.");
  }
}

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

/* ------------------------------------------------------------------ *
 * What this costs on disk
 * ------------------------------------------------------------------ */

let storageLoaded = false;

/**
 * `GET_STORAGE_REPORT` has been implemented, with row counts and `storage.estimate()`,
 * and no surface has ever sent it. Read on demand rather than at load: the handler
 * flushes the ledger and counts every store, which is not work to do on a page someone
 * opened to change the theme.
 */
async function loadStorageReport(): Promise<void> {
  if (!storageDetails.open) return;
  replaceChildren(storageReportBlock, [element("p", { className: "field-hint", text: "Reading…" })]);
  try {
    const report = await sendRequest({ type: "GET_STORAGE_REPORT" });
    storageLoaded = true;
    renderStorageReport(report);
  } catch (error) {
    storageLoaded = false;
    replaceChildren(storageReportBlock, [
      element("p", {
        className: "field-hint",
        text: errorMessage(error, "Could not read the storage report."),
      }),
    ]);
  }
}

function renderStorageReport(report: StorageReport): void {
  const rows: [string, string, string][] = [
    ["Days of usage", formatCount(report.dailyRows), "One row per site per day"],
    ["Hours of usage", formatCount(report.hourlyRows), "One row per site per hour, kept 3 days"],
    ["Host rows", formatCount(report.hostRows), "Which hosts a site's bytes came from"],
    ["Page loads", formatCount(report.visitRows), "Site and origin only — no path, no query"],
    ["Learned sizes", formatCount(report.sizeModelRows), "The estimator, per host and type"],
    [
      "Observed image sizes",
      report.baselineRows === undefined ? "not reported" : formatCount(report.baselineRows),
      "Original sizes of images a pack can rewrite. Not covered by the retention setting.",
    ],
  ];

  const table = element("table", { className: "table" }, [
    element("thead", {}, [
      element("tr", {}, [
        headerCell("Store"),
        headerCell("Rows", true),
        headerCell("What it holds"),
      ]),
    ]),
    element(
      "tbody",
      {},
      rows.map(([label, value, description]) =>
        element("tr", {}, [
          element("td", { text: label }),
          element("td", { className: "numeric", text: value }),
          element("td", { className: "field-hint", text: description }),
        ]),
      ),
    ),
  ]);

  const nodes: Node[] = [
    element("div", { className: "table-scroll" }, [table]),
    element("p", {
      className: "field-hint",
      text:
        report.bytesUsed === null
          ? "The browser does not report how much disk this is using."
          : `The browser estimates ${bytes(
              report.bytesUsed,
            )} on disk for this extension, rounded for privacy and including the settings.`,
    }),
  ];

  if (report.lastFlushError) {
    // Rendered as the admission it is. A rejected write leaves every total quietly
    // behind the traffic it claims to measure, and a service worker's console is not a
    // surface anyone opens.
    nodes.push(
      element("p", { className: "empty friendly-empty" }, [
        element("span", {
          className: "state-chip",
          text: "Some counts did not land",
          dataset: { tone: "enforcing" },
        }),
        ` The last write that failed was ${formatAgo(report.lastFlushError.at)}: ${
          report.lastFlushError.message
        }. Those counts were put back in the buffer and retried, so they are not lost — but every total read between then and the retry was low by that much.`,
      ]),
    );
  }

  replaceChildren(storageReportBlock, nodes);
}

storageDetails.addEventListener("toggle", () => {
  if (storageDetails.open && !storageLoaded) void loadStorageReport();
});

/* ------------------------------------------------------------------ *
 * Controls that exist for the life of the page
 * ------------------------------------------------------------------ */

/**
 * Every single-choice control, wired once.
 *
 * `bindGroup` builds the option elements, so calling it from a render path would
 * replace the button the user is standing on between one keypress and the next.
 * Re-rendering calls `paintGroup`, which only moves the checked state and the roving
 * tabindex.
 */
function bindControls(): void {
  bindGroup<Settings["theme"]>({
    container: query<HTMLDivElement>("#theme-group"),
    options: [
      { value: "auto", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
    value: "auto",
    onSelect: (value) => void applySettings({ theme: value }),
  });

  bindGroup<Settings["badge"]>({
    container: query<HTMLDivElement>("#badge-group"),
    options: [
      { value: "off", label: "Off" },
      { value: "session", label: "Session" },
      { value: "today", label: "Today" },
    ],
    value: "off",
    onSelect: (value) => void applySettings({ badge: value }),
  });

  bindGroup<Settings["units"]>({
    container: query<HTMLDivElement>("#units-group"),
    options: [
      { value: "si", label: "kB / MB / GB" },
      { value: "iec", label: "KiB / MiB / GiB" },
    ],
    value: "si",
    onSelect: (value) => void applySettings({ units: value }),
  });
  unitsHint.textContent =
    "A data plan is quoted in decimal units (1 GB = 1000 MB); a file manager counts binary ones (1 GiB = 1024 MiB). The same bytes read as 15 GB or 14 GiB, which is why the unit is always printed.";

  const weekStart = groupField("week-start-group", "A week starts on");
  const weekMode = groupField("week-mode-group", '"7 days" means');
  const monthMode = groupField(
    "month-mode-group",
    '"30 days" means',
    "A calendar month is not the same window as your plan's cycle. The cycle is the one the projection uses.",
  );
  replaceChildren(periodOptions, [weekStart.field, weekMode.field, monthMode.field]);

  bindGroup<Settings["weekStart"]>({
    container: weekStart.group,
    options: [
      { value: 0, label: "Sunday" },
      { value: 1, label: "Monday" },
    ],
    value: 1,
    onSelect: (value) => void applySettings({ weekStart: value }),
  });

  bindGroup<Settings["weekMode"]>({
    container: weekMode.group,
    options: [
      { value: "rolling", label: "The last 7 days" },
      { value: "calendar", label: "This week so far" },
    ],
    value: "rolling",
    onSelect: (value) => void applySettings({ weekMode: value }),
  });

  bindGroup<Settings["monthMode"]>({
    container: monthMode.group,
    options: [
      { value: "rolling", label: "The last 30 days" },
      { value: "calendar", label: "This month so far" },
    ],
    value: "rolling",
    onSelect: (value) => void applySettings({ monthMode: value }),
  });

  bindGroup<PlanEnforcement>({
    container: planShapeGroup,
    options: (["watch", "progressive", "hard"] as const).map((value) => ({
      value,
      label: PLAN_ENFORCEMENT_LABELS[value],
    })),
    value: planEnforcement,
    onSelect: (value) => void choosePlanEnforcement(value),
  });

  bindGroup<BudgetPeriod>({
    container: limitPeriodGroup,
    options: BUDGET_PERIODS.map((period) => ({
      value: period,
      label: PERIOD_OPTION_LABELS[period],
      title: `Allowance ${BUDGET_PERIOD_LABELS[period]}`,
    })),
    value: formPeriod,
    onSelect: (value) => {
      formPeriod = value;
      paintGroup(limitPeriodGroup, value);
    },
  });

  bindGroup<number>({
    container: holdoutGroup,
    options: HOLDOUT_OPTIONS.map((percent) => ({
      value: percent,
      label: percent === 0 ? "Off" : `${percent}%`,
    })),
    value: 10,
    onSelect: (value) => void changeOptimize({ holdoutPercent: value }),
  });

  const hard = switchField({
    id: "limit-hard",
    label: "Hard cap",
    hint: `${BUDGET_SHAPE_LABELS.hard}.`,
    onChange: (checked) => {
      formHard = checked;
    },
  });
  replaceChildren(limitShapeField, [hard.field]);

  fillSelect(planCycleSelect, cycleDayOptions(), "0");
  planCycleSelect.addEventListener("change", () => {
    if (!settings) return;
    // Saved on change rather than waiting for the button: the two fields are edited
    // independently, and a reset day nobody pressed Save on would be a wrong date on
    // every cycle figure in the product.
    void applySettings({ cycleStartDay: Number(planCycleSelect.value) });
  });

  buildFeatureRows();
  buildPackRows();
  buildAlertRows();
  buildPrivacyOptions();
  renderDeleteActions();
  buildTierTable();
  renderImpactMeters();
}

function buildTierTable(): void {
  query<HTMLParagraphElement>("#limit-shape-explainer").textContent = `"${BUDGET_SHAPE_LABELS.progressive}" walks down these steps as the allowance fills. "${BUDGET_SHAPE_LABELS.hard}" skips all of them until 100%, and then applies the last one.`;

  replaceChildren(
    query<HTMLTableSectionElement>("#tier-table tbody"),
    [...PROGRESSIVE_THRESHOLDS]
      .sort((a, b) => a.at - b.at)
      .map((threshold) =>
        element("tr", {}, [
          element("td", { text: formatPercent(threshold.at) }),
          element("td", { text: TIER_LABELS[threshold.tier] }),
          element("td", { className: "field-hint", text: TIER_DESCRIPTIONS[threshold.tier] }),
        ]),
      ),
  );
}

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

onSettingsChanged((next) => paintSettings(next));

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  void loadLimits();
  void loadOptimize();
  void loadAlerts();
  if (storageDetails.open) void loadStorageReport();
});

async function start(): Promise<void> {
  bindControls();
  await loadSettings();
  await Promise.all([loadLimits(), loadOptimize(), loadAlerts()]);
  paintAlertNote();
}

void start();

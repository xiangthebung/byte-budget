import "./settings.css";
import {
  bindGroup,
  button,
  element,
  paintGroup,
  query,
  queryAll,
  replaceChildren,
  setGroupOptionsLocked,
} from "./core/dom";
import {
  formatAgo,
  formatBytes,
  formatCount,
  formatPercent,
  parseByteSize,
} from "./core/format";
import { applyDocumentLanguage, t } from "./core/i18n";
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
  SETTINGS_SECTIONS,
  type Settings,
  type SettingsSection,
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
import { lockNotice, setControlsEnabled } from "./plus/lock";
import { PRICE_MONTHLY, PRICE_YEARLY, TRIAL_DAYS } from "./plus/plans";
import {
  FREE_BUDGET_PERIODS,
  FREE_REPORT_DAYS,
  FREE_SITE_LIMITS,
  unknownStatus,
  type PlusPage,
  type PlusStatus,
} from "./plus/tier";
import {
  FEATURES,
  HOLDOUT_OPTIONS,
  SAVER_LEVELS,
  SAVINGS_IMPACT_BY_FEATURE,
  featuresForLevel,
  levelOf,
  type FeatureId,
  type FeatureInfo,
  type OptimizeSettings,
  type SaverLevel,
  type SavingsImpact,
} from "./optimize/features";

const planSizeInput = query<HTMLInputElement>("#plan-size");
const planCycleSelect = query<HTMLSelectElement>("#plan-cycle");
const planEcho = query<HTMLSpanElement>("#plan-echo");
const planStatus = query<HTMLParagraphElement>("#plan-status");
const planShapeGroup = query<HTMLDivElement>("#plan-shape-group");
const planShapeHint = query<HTMLSpanElement>("#plan-shape-hint");
const planAllowance = query<HTMLDivElement>("#plan-allowance");

const limitsList = query<HTMLUListElement>("#limits-list");
const limitsEmpty = query<HTMLParagraphElement>("#limits-empty");
const limitStatus = query<HTMLParagraphElement>("#limit-form-status");
const limitPeriodGroup = query<HTMLDivElement>("#limit-period-group");
const limitShapeGroup = query<HTMLDivElement>("#limit-shape-group");
const limitShapeHint = query<HTMLSpanElement>("#limit-shape-hint");

const optimizeToggle = query<HTMLInputElement>("#optimize-toggle");
const optimizeBody = query<HTMLDivElement>("#optimize-body");
const optimizeNote = query<HTMLParagraphElement>("#optimize-note");
const saverState = query<HTMLSpanElement>("#saver-state");
const saverLevelGroup = query<HTMLDivElement>("#saver-level-group");
const saverLevelHint = query<HTMLSpanElement>("#saver-level-hint");
const saverLevelCustom = query<HTMLSpanElement>("#saver-level-custom");
const featureGroups = query<HTMLDivElement>("#feature-groups");
const packList = query<HTMLDivElement>("#pack-list");
const packsIntro = query<HTMLParagraphElement>("#packs-intro");
const holdoutGroup = query<HTMLDivElement>("#holdout-group");
const holdoutHint = query<HTMLSpanElement>("#holdout-hint");
const exclusionCount = query<HTMLSpanElement>("#exclusion-count");
const exclusionList = query<HTMLUListElement>("#exclusion-list");

const alertOptions = query<HTMLDivElement>("#alert-options");
const alertsStatus = query<HTMLParagraphElement>("#alerts-status");
const alertsPlanNote = query<HTMLParagraphElement>("#alerts-plan-note");

const settingsStatus = query<HTMLParagraphElement>("#settings-status");
const unitsHint = query<HTMLSpanElement>("#units-hint");
const periodOptions = query<HTMLDivElement>("#period-options");

const privacyOptions = query<HTMLDivElement>("#privacy-options");
const dataStatus = query<HTMLParagraphElement>("#data-status");
const deleteScopeNote = query<HTMLSpanElement>("#delete-scope-note");
const deleteActions = query<HTMLDivElement>("#delete-actions");
const deleteStatus = query<HTMLParagraphElement>("#delete-status");
const storageDetails = query<HTMLDetailsElement>("#storage-details");
const storageReportBlock = query<HTMLDivElement>("#storage-report");

const unitsGroup = query<HTMLDivElement>("#units-group");
const exportDaysSelect = query<HTMLSelectElement>("#export-days");

const saverAdvancedLock = query<HTMLDivElement>("#saver-advanced-lock");
const limitFormLock = query<HTMLDivElement>("#limit-form-lock");
const appearanceAdvancedLock = query<HTMLDivElement>("#appearance-advanced-lock");
const exportLock = query<HTMLDivElement>("#export-lock");
const limitForm = query<HTMLFormElement>("#limit-form");
const plusState = query<HTMLDivElement>("#plus-state");
const plusList = query<HTMLUListElement>("#plus-list");
const plusActions = query<HTMLDivElement>("#plus-actions");
const plusStatusLine = query<HTMLParagraphElement>("#plus-status");

const railPlanValue = query<HTMLSpanElement>("#rail-value-plan");
const railSaverValue = query<HTMLSpanElement>("#rail-value-saver");
const railLimitsValue = query<HTMLSpanElement>("#rail-value-limits");
const railPlusValue = query<HTMLSpanElement>("#rail-value-plus");

const liveRegion = query<HTMLParagraphElement>("#live-region");

let units: Settings["units"] = "si";
let settings: Settings | null = null;
let optimize: OptimizeSettings | null = null;
let statuses: readonly BudgetStatus[] = [];
let alerts: AlertSettings | null = null;
/**
 * Free until a check says otherwise, which is also what an install with no network
 * reads as. See the failure policy at the head of `plus/gate.ts`: the worker never
 * downgrades a successful answer, so anything this page is handed is either the truth
 * or the last truth there was.
 */
let plus: PlusStatus = unknownStatus();
/** Site limits that exist, not counting the plan's own. Drives the free-tier ceiling. */
let siteLimitCount = 0;

function bytes(value: number): string {
  return formatBytes(value, units);
}

/** Every optimize input, so a save can disable the lot without naming them. */
const optimizeInputs: HTMLInputElement[] = [];

/**
 * The ordinal is four whole messages rather than four suffixes.
 *
 * A suffix bolted onto a number is the fragment a translator cannot work with: the
 * position of the marker differs by language and some languages have none. Each branch
 * hands over the complete word, so a locale with no ordinal returns `$DAY$` alone. The
 * choice of branch stays here because it is English grammar, and picking it wrongly
 * would put "21th" on the reset-day picker.
 */
function ordinal(day: number): string {
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) return t("settingsOrdinalOther", String(day));
  switch (day % 10) {
    case 1:
      return t("settingsOrdinalFirst", String(day));
    case 2:
      return t("settingsOrdinalSecond", String(day));
    case 3:
      return t("settingsOrdinalThird", String(day));
    default:
      return t("settingsOrdinalOther", String(day));
  }
}

/* ------------------------------------------------------------------ *
 * The markup's own strings
 * ------------------------------------------------------------------ */

/**
 * Replaces the English in `settings.html` with the current locale's messages.
 *
 * Chrome substitutes `__MSG_name__` in the manifest and in CSS and nowhere else, so
 * every word in an extension page has to be written by script. The attributes name a
 * message per element rather than per surface, which is what keeps `settings.html`
 * readable: the words stay next to the markup they belong to and a reviewer can still
 * see what the page says.
 *
 * Three attributes, because the markup carries three kinds of string. There is no
 * `data-i18n-title` handler: every tooltip on this page is built in script, and a
 * branch for markup that does not exist is a branch nothing would notice breaking.
 *
 * Called before anything else in `start()`. Running it after the first render would
 * leave whichever pane painted first in the wrong language until its next refresh.
 */
function localizeMarkup(): void {
  for (const node of queryAll<HTMLElement>("[data-i18n]")) {
    const key = node.dataset.i18n;
    if (key) node.textContent = t(key);
  }
  for (const node of queryAll<HTMLElement>("[data-i18n-label]")) {
    const key = node.dataset.i18nLabel;
    if (key) node.setAttribute("aria-label", t(key));
  }
  for (const node of queryAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    const key = node.dataset.i18nPlaceholder;
    if (key) node.placeholder = t(key);
  }
  // The export ranges are one message with the day count substituted in, so the option
  // carries its number in `value` and the label is built from it.
  for (const option of queryAll<HTMLOptionElement>("#export-days option")) {
    option.textContent = t("settingsExportRangeDays", option.value);
  }
}

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

/**
 * `SETTINGS_SECTIONS` is shared, not local, because the popup and the dashboard link
 * into these sections by name and this page decides what the names are.
 *
 * The first entry is the fallback: a missing fragment, and one from an older build
 * that named a panel this page no longer has, both open on the plan. Falling back
 * rather than showing nothing is the only sensible answer to a fragment nobody here
 * wrote — but it is also silent, which is why the names are in one place now.
 */
type Pane = SettingsSection;

const DEFAULT_PANE: Pane = SETTINGS_SECTIONS[0];

function paneFromHash(): Pane {
  const name = location.hash.replace(/^#/, "");
  return (SETTINGS_SECTIONS as readonly string[]).includes(name)
    ? (name as Pane)
    : DEFAULT_PANE;
}

/**
 * Shows one section and hides the rest.
 *
 * Nothing is built or destroyed here — every control on all six panes exists from
 * startup and is only ever painted after that, which is the same rule `bindGroup`
 * documents for its own options. A section that built itself on first view would take
 * the focused control with it every time someone came back to it, and the state a
 * half-typed field holds is not in the settings.
 *
 * `aria-current="true"`, not `"page"`. These are links to parts of the document that
 * is already open, and the Dashboard/Settings bar above them uses `"page"` for the
 * thing that really is one — two elements claiming to be the current page is a
 * screen reader being told something that cannot be true. Not `aria-selected`
 * either: that is a claim about a tab in a tablist, which this deliberately is not.
 *
 * `moveFocus` is false on the first paint and true from then on. Choosing a section
 * changes everything below the heading and nothing at the point of the click, so
 * without it a screen reader announces the link and then reads on into a pane that is
 * no longer there; with it on load, the page would open having stolen focus from the
 * address bar.
 */
function showPane(pane: Pane, moveFocus: boolean): void {
  for (const section of queryAll<HTMLElement>(".pane")) {
    section.hidden = section.dataset.pane !== pane;
  }
  for (const item of queryAll<HTMLAnchorElement>(".rail-item")) {
    if (item.dataset.pane === pane) item.setAttribute("aria-current", "true");
    else item.removeAttribute("aria-current");
  }
  if (!moveFocus) return;
  const heading = document.querySelector<HTMLElement>(`#pane-${pane} .pane-title`);
  heading?.focus();
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

interface RowOptions {
  /** Rendered as a `<label for>` when `control` names an input id, so the text toggles it. */
  labelFor?: string;
  label?: string;
  /** Small print under the label. */
  sub?: string;
  /** A second line of small print, for what the shipped description does not say. */
  note?: string;
  /** A decorative glyph before the label. */
  glyph?: { text: string; isText: boolean };
  /** Feature id, when the row should carry a relative-savings meter. */
  impact?: FeatureId;
  className?: string;
}

/**
 * One line of a settings group: what it is on the left, the control on the right.
 *
 * The page used to say what a control did in a paragraph above it and again in a hint
 * below it. A row says it once, in the two lines beside the control, and the reason a
 * setting exists — which is what most of those paragraphs were — moved to the note
 * under the group or into a disclosure.
 */
function row(options: RowOptions, control: Node): HTMLDivElement {
  const label = options.labelFor
    ? element("label", { className: "row-label", text: options.label ?? "" })
    : element("span", { className: "row-label", text: options.label ?? "" });
  if (options.labelFor && label instanceof HTMLLabelElement) label.htmlFor = options.labelFor;

  const heading = options.impact
    ? element("span", { className: "row-heading" }, [
        label,
        element("span", {
          className: "impact-meter",
          dataset: { impactFeature: options.impact },
        }),
      ])
    : label;

  const className = `${options.className ?? "row"}${options.glyph ? " row-glyphed" : ""}`;

  return element("div", { className }, [
    options.glyph
      ? element("span", {
          className: options.glyph.isText
            ? "advanced-symbol advanced-symbol-text"
            : "advanced-symbol",
          text: options.glyph.text,
          ariaHidden: true,
        })
      : null,
    element("div", { className: "row-copy" }, [
      options.label === undefined ? null : heading,
      options.sub ? element("span", { className: "row-sub", text: options.sub }) : null,
      options.note ? element("span", { className: "row-sub", text: options.note }) : null,
    ]),
    element("div", { className: "row-control" }, [control]),
  ]);
}

/**
 * The switch itself, matching the markup `settings.html` writes by hand.
 *
 * A `span` rather than the `label` this control is elsewhere: the row's own label
 * already names the input. `settings.css` stretches the input over the track, so the
 * track is still what a click lands on.
 */
function switchControl(id: string, onChange: (checked: boolean) => void): HTMLInputElement {
  const input = element("input");
  input.type = "checkbox";
  input.id = id;
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}

function switchBox(input: HTMLInputElement): HTMLSpanElement {
  return element("span", { className: "switch-control" }, [
    input,
    element("span", { className: "switch-track", ariaHidden: true }, [element("span")]),
  ]);
}

/** A row whose control is a switch, wired to `onChange`. */
function switchRow(
  options: RowOptions & { id: string; label: string; onChange: (checked: boolean) => void },
): { row: HTMLDivElement; input: HTMLInputElement } {
  const input = switchControl(options.id, options.onChange);
  return { row: row({ ...options, labelFor: options.id }, switchBox(input)), input };
}

/** A row whose control is a segmented group, for `bindGroup` to fill. */
function groupRow(
  id: string,
  options: RowOptions & { label: string },
): { row: HTMLDivElement; group: HTMLDivElement } {
  const group = element("div", { className: "segmented" });
  group.id = id;
  const node = row({ ...options, className: "row" }, group);
  const label = query<HTMLElement>(".row-label", node);
  label.id = `${id}-label`;
  group.setAttribute("aria-labelledby", label.id);
  return { row: node, group };
}

/** A rounded card holding one or more rows. */
function group(children: (Node | null)[]): HTMLDivElement {
  return element("div", { className: "group" }, children);
}

function groupTitle(text: string, note?: HTMLElement): HTMLHeadingElement {
  return element("h4", { className: "group-title", text }, note ? [" ", note] : []);
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

/* ------------------------------------------------------------------ *
 * Relative savings cues
 * ------------------------------------------------------------------ */

const IMPACT_SCORE: Record<SavingsImpact, number> = { low: 1, medium: 2, high: 3 };

/**
 * Named rather than capitalised from the impact id.
 *
 * The label used to be the enum value with its first letter upper-cased, which is a
 * rule about English orthography applied to a word that is about to be translated —
 * `toUpperCase()` on a locale where the word does not begin with a letter, or where
 * title case is not how a label is written, produces something nobody chose.
 */
const IMPACT_LABEL_KEYS: Record<SavingsImpact, string> = {
  low: "settingsImpactLow",
  medium: "settingsImpactMedium",
  high: "settingsImpactHigh",
};

function renderImpactMeters(): void {
  for (const node of document.querySelectorAll<HTMLElement>("[data-impact-feature]")) {
    const feature = node.dataset.impactFeature as FeatureId | undefined;
    const impact = feature ? SAVINGS_IMPACT_BY_FEATURE[feature] : undefined;
    if (!impact) continue;
    const label = t(IMPACT_LABEL_KEYS[impact]);
    const score = IMPACT_SCORE[impact];
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", t("settingsImpactAria", label));
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
 * budget that can never match a request, sitting in the list at 0% forever. A pasted
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
  if (!text) return { error: t("settingsSiteErrorEmpty") };

  let host: string;
  if (text.includes("://")) {
    const parsed = hostFromUrl(text);
    if (!parsed) return { error: t("settingsSiteErrorScheme") };
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
      return { error: t("settingsSiteErrorIpv6") };
    }
    host = host.slice(0, colon);
  }

  if (!host) return { error: t("settingsSiteErrorEmpty") };
  if (!HOST_SHAPE.test(host)) {
    return { error: t("settingsSiteErrorShape", text) };
  }

  const labels = host.split(".");
  const ending = labels[labels.length - 1] ?? "";
  if (host !== "localhost" && !IPV4.test(host)) {
    if (labels.length < 2) {
      // One message, not a sentence with the host spliced in twice: the suggestion has
      // to be able to move relative to the complaint, and in some languages it does.
      return { error: t("settingsSiteErrorNoEnding", host) };
    }
    if (!DOMAIN_ENDING.test(ending)) {
      return { error: t("settingsSiteErrorBadEnding", host) };
    }
  }

  const site = siteKeyFromHost(host);
  if (!site) return { error: t("settingsSiteErrorEmpty") };
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

const PLAN_ENFORCEMENT_LABEL_KEYS: Record<PlanEnforcement, string> = {
  watch: "settingsPlanShapeWatch",
  progressive: "settingsPlanShapeProgressive",
  hard: "settingsPlanShapeHard",
};

const PLAN_ENFORCEMENT_HINT_KEYS: Record<PlanEnforcement, string> = {
  watch: "settingsPlanShapeWatchHint",
  progressive: "settingsPlanShapeProgressiveHint",
  hard: "settingsPlanShapeHardHint",
};

function planEnforcementLabel(value: PlanEnforcement): string {
  return t(PLAN_ENFORCEMENT_LABEL_KEYS[value]);
}

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
  const options = [{ value: "0", label: t("settingsPlanCycleCalendar") }];
  for (let day = 2; day <= MAX_CYCLE_START_DAY; day++) {
    options.push({ value: String(day), label: t("settingsPlanCycleDay", ordinal(day)) });
  }
  return options;
}

function paintPlanEcho(): void {
  const raw = planSizeInput.value.trim();
  if (!raw) {
    planEcho.textContent = t("settingsPlanEchoEmpty");
    return;
  }
  const size = parseByteSize(raw);
  if (size === null || size <= 0) {
    planEcho.textContent = t("settingsPlanEchoUnreadable");
    return;
  }
  // Echoed on every keystroke, because the one thing a size field cannot do is take a
  // number and mean a different one. "1,5 GB" is 1.5 GB in most of the world and 15 GB
  // in some parsers; whichever this build reads it as, it says so before you save.
  //
  // And it says nothing when the field already holds exactly what the product would
  // print. "Reads as 15.0 GB" under a field reading 15.0 GB is a warning about a
  // disagreement that is not there, and a page whose every control carries a line of
  // small print is the page this one replaced.
  const reading = bytes(size);
  planEcho.textContent = reading === raw ? "" : t("settingsPlanEchoReads", reading);
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
  planShapeHint.textContent = t(PLAN_ENFORCEMENT_HINT_KEYS[planEnforcement]);

  railPlanValue.textContent =
    settings.planBytes === null
      ? t("settingsPlanNoteUnset")
      : t("settingsPlanNote", [bytes(settings.planBytes), formatAgo(cycleResetsAt(settings))]);

  replaceChildren(planAllowance, planAllowanceBlock(settings, total));
  // The alerts pane's warning depends on whether that allowance exists, and this is
  // the only place that knows it just changed.
  paintAlertNote();
}

function planAllowanceBlock(current: Settings, total: BudgetStatus | null): Node[] {
  if (current.planBytes === null) {
    return [
      element("p", {
        className: "empty friendly-empty",
        text: t("settingsPlanEmpty"),
      }),
    ];
  }

  const range = cycleRange(current);
  const elapsed = cycleElapsed(current);
  const nodes: Node[] = [
    groupTitle(t("settingsCycleTitle")),
    element("p", {
      className: "group-note group-note-lead",
      text: t("settingsPlanCycleLine", [
        formatDayShort(range.from),
        formatCount(elapsed.elapsedDays),
        formatCount(elapsed.totalDays),
        formatAgo(cycleResetsAt(current)),
      ]),
    }),
  ];

  if (!total) {
    nodes.push(
      element("p", {
        className: "empty friendly-empty",
        text: t("settingsPlanNoAllowance", planEnforcementLabel("watch")),
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
  return group([
    element("div", { className: "row row-stack" }, [
      element("div", { className: "limit-head" }, [
        element("span", { className: "limit-site", text: t("settingsAllowanceLabel") }),
        element("span", {
          className: "state-chip",
          text: state.text,
          dataset: state.tone ? { tone: state.tone } : {},
        }),
      ]),
      meter(status),
      element("span", {
        className: "row-sub",
        text: status.resetsAt
          ? t("settingsAllowanceResets", [
              BUDGET_PERIOD_LABELS[status.budget.period],
              formatAgo(status.resetsAt),
            ])
          : BUDGET_PERIOD_LABELS[status.budget.period],
      }),
      status.tier === "off"
        ? null
        : element("span", {
            className: "row-sub",
            text: t("settingsAllowanceTier", [
              TIER_LABELS[status.tier],
              TIER_DESCRIPTIONS[status.tier],
            ]),
          }),
      // No Remove here. Removing this budget is what "Just track it" above does, and it
      // has to be that control rather than this button, because dropping the allowance
      // without saying so leaves plan alerts silently checking nothing.
      element("div", { className: "row-actions" }, rowActions(status, false)),
    ]),
  ]);
}

/**
 * Writes the plan size, and is reached by leaving the field rather than by a button.
 *
 * The Save button it replaces was the only one on the page: the reset day, the
 * enforcement choice and every switch already saved themselves, so a person who
 * changed the size and moved on had no way to know that one field alone had not
 * stuck. `change` fires on blur and on Enter, and only when the value actually
 * differs from what the field last held, so tabbing past it saves nothing.
 *
 * Emptying the field still removes the plan, which is a real deletion reached by
 * leaving a field. It is announced rather than silent — the status line under the
 * group says so — and it is undone by typing the number again, which is the whole of
 * what was lost.
 */
async function savePlan(): Promise<void> {
  const raw = planSizeInput.value.trim();
  const cycleStartDay = Number(planCycleSelect.value);
  const size = raw ? parseByteSize(raw) : null;

  if (raw && (size === null || size <= 0)) {
    planStatus.textContent = t("settingsPlanSizeUnreadable", raw);
    planStatus.dataset.tone = "error";
    return;
  }
  planStatus.dataset.tone = "";

  // Captured before anything renders. `paintPlan` re-derives this from the stored
  // budgets, and between the settings write and the budget write there is no budget yet
  // — so reading the global afterwards would turn a chosen "Stop at the limit" into
  // "Just track it" and quietly save a plan with no allowance behind it.
  const enforcement = planEnforcement;

  planStatus.textContent = t("settingsSaving");
  try {
    const response = await sendRequest({
      type: "SAVE_SETTINGS",
      changes: { planBytes: size, cycleStartDay },
    });
    paintSettings(response.settings);
    await applyPlanAllowance(size, enforcement);
    // Two whole sentences rather than one with a preposition spliced into it. "on the
    // 1st" and "on the 17th" are not interchangeable fragments in every language, and a
    // sentence assembled from them cannot be reordered by whoever translates it.
    planStatus.textContent =
      size === null
        ? t("settingsPlanRemoved")
        : response.settings.cycleStartDay === 0
          ? t("settingsPlanSavedCalendar", bytes(size))
          : t("settingsPlanSavedDay", [bytes(size), ordinal(response.settings.cycleStartDay)]);
  } catch (error) {
    const message = errorMessage(error, t("settingsPlanSaveError"));
    planStatus.textContent = message;
    planStatus.dataset.tone = "error";
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
  planShapeHint.textContent = t(PLAN_ENFORCEMENT_HINT_KEYS[value]);
  if (!settings || settings.planBytes === null) {
    planStatus.textContent = t("settingsPlanNeedsSize");
    return;
  }
  planStatus.textContent = t("settingsSaving");
  try {
    await applyPlanAllowance(settings.planBytes, value);
    planStatus.textContent = t("settingsSavedSentence");
  } catch (error) {
    planStatus.textContent = errorMessage(error, t("settingsAllowanceChangeError"));
    planStatus.dataset.tone = "error";
  }
}

planSizeInput.addEventListener("input", paintPlanEcho);
planSizeInput.addEventListener("change", () => void savePlan());
planSizeInput.addEventListener("keydown", (event) => {
  // Enter already fires `change` on the way out of the field in every engine this ships
  // to, but only after the default action — which in a page with no form is nothing.
  // Blurring makes the save happen where the key was pressed rather than whenever focus
  // next moves, which is what someone pressing Enter is asking for.
  if (event.key === "Enter") planSizeInput.blur();
});

/* ------------------------------------------------------------------ *
 * Site limits
 * ------------------------------------------------------------------ */

/** The site being edited in place, so a refresh cannot pull the field out. */
let editingSite: string | null = null;
let deferredStatuses: readonly BudgetStatus[] | null = null;

let formPeriod: BudgetPeriod = "day";
let formShape: BudgetShape = "progressive";

const PERIOD_OPTION_KEYS: Record<BudgetPeriod, string> = {
  session: "settingsPeriodSession",
  day: "settingsPeriodDay",
  week: "settingsPeriodWeek",
  month: "settingsPeriodMonth",
};

const LIMIT_SHAPE_LABEL_KEYS: Record<BudgetShape, string> = {
  progressive: "settingsPlanShapeProgressive",
  hard: "settingsPlanShapeHard",
};

const LIMIT_SHAPE_HINT_KEYS: Record<BudgetShape, string> = {
  progressive: "settingsLimitShapeProgressiveHint",
  hard: "settingsLimitShapeHardHint",
};

/**
 * The whole "add some more" label, per window.
 *
 * This used to be the four window names alone — "today", "this week" — joined onto a
 * byte figure at the call site. That is the fragment a translation cannot move: the
 * size goes before the window in English and after it in plenty of languages, and a
 * translator handed "today" on its own has no way to say so.
 */
const GRANT_LABEL_KEYS: Record<BudgetPeriod, string> = {
  session: "settingsGrantSession",
  day: "settingsGrantDay",
  week: "settingsGrantWeek",
  month: "settingsGrantMonth",
};

async function loadLimits(): Promise<void> {
  try {
    const { statuses: loaded } = await sendRequest({ type: "GET_BUDGETS" });
    renderLimits(loaded);
  } catch (error) {
    limitStatus.textContent = errorMessage(error, t("settingsLimitsReadError"));
    limitStatus.dataset.tone = "error";
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
  limitsList.hidden = rows.length === 0;
  // Singular and plural are two whole messages. Joining a count to a noun chosen by a
  // ternary is English-only arithmetic: other languages pick the form from the number
  // itself, and several have more than two forms to pick from.
  // Named at zero rather than left blank. Three of the six rail items carry their
  // current value, and an item that carries one only sometimes reads as an item still
  // loading — next to "No plan set" and "Off", which both state their empty case.
  railLimitsValue.textContent =
    rows.length === 0
      ? t("settingsLimitsNoteNone")
      : t(
          rows.length === 1 ? "settingsLimitsNoteOne" : "settingsLimitsNoteMany",
          formatCount(rows.length),
        );

  replaceChildren(
    limitsList,
    [...rows].sort((a, b) => b.share - a.share).map((status) => limitCard(status)),
  );
  // The free tier's ceiling is on this count, so the locks are re-applied whenever it
  // moves — removing a limit while at the ceiling has to unlock the form again, and it
  // is the only thing that does.
  siteLimitCount = rows.length;
  renderLocks();
  paintPlan();
}

function endEditing(): void {
  const pending = deferredStatuses;
  editingSite = null;
  deferredStatuses = null;
  if (pending) renderLimits(pending);
}

/**
 * The status chip says what the user's position is, and the tier below it says what
 * that costs.
 *
 * It used to print the tier name alone — "Page shell only" — which is the mechanism,
 * names no state, and never contains the word "over".
 */
function statusWords(status: BudgetStatus): { text: string; tone: string } {
  if (status.snoozed) {
    const until = status.budget.snoozedUntil;
    return {
      text: until
        ? t("settingsStatusPausedUntil", formatAgo(until))
        : t("settingsStatusPaused"),
      tone: "paused",
    };
  }
  if (status.share >= 1) return { text: t("settingsStatusOver"), tone: "enforcing" };
  if (status.share >= 0.85) return { text: t("settingsStatusNearly"), tone: "enforcing" };
  return { text: t("settingsStatusWithin"), tone: "" };
}

function meter(status: BudgetStatus): HTMLElement {
  const over = status.share >= 1;
  return element("span", { className: "limit-meter" }, [
    element("span", {
      text: t("settingsMeter", [
        bytes(status.used),
        bytes(status.allowance),
        formatPercent(status.share),
      ]),
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
      text: t(GRANT_LABEL_KEYS[status.budget.period], bytes(size)),
      title: t(
        status.budget.period === "session"
          ? "settingsGrantTitleSession"
          : "settingsGrantTitleWindow",
        bytes(status.allowance + size),
      ),
      onClick: () => void changeLimit({ type: "GRANT_BYTES", site, bytes: size }),
    }),
    status.snoozed
      ? button("ghost-button", {
          text: t("settingsResume"),
          title: t("settingsResumeTitle"),
          onClick: () => void changeLimit({ type: "RESUME_BUDGET", site }),
        })
      : button("ghost-button", {
          text: t("settingsPause"),
          title: t("settingsPauseTitle"),
          onClick: () => void changeLimit({ type: "SNOOZE_BUDGET", site, minutes: 60 }),
        }),
  ];

  if (removable) {
    actions.push(
      button("ghost-button", {
        text: t("settingsRemove"),
        dataset: { danger: "true" },
        title: t("settingsRemoveTitle"),
        onClick: () => void changeLimit({ type: "REMOVE_BUDGET", site }),
      }),
    );
  }
  return actions;
}

/**
 * One limit, as a card.
 *
 * This was six table columns with a `data-label` on every cell and a media query that
 * turned the table back into one card per limit under 640px — which is what it always
 * was. Five of the six columns hold a different kind of thing about one site, so
 * nothing was gained by lining them up vertically, and the header row was six words of
 * chrome above a table that is usually one row long.
 */
function limitCard(status: BudgetStatus): HTMLLIElement {
  const site = status.budget.site;
  const state = statusWords(status);

  // Built before the button, because the button's job is to replace this block's
  // contents with the editor and it needs somewhere to put them.
  const allowanceBlock = element("div", { className: "limit-allowance" });
  replaceChildren(allowanceBlock, [
    button("ghost-button", {
      text: t("settingsLimitAllowanceButton", [
        bytes(status.budget.bytes),
        BUDGET_PERIOD_LABELS[status.budget.period],
      ]),
      ariaLabel: t("settingsLimitEditAria", site),
      title: t("settingsLimitEditTitle"),
      onClick: () => startEditing(status, allowanceBlock),
    }),
    element("span", {
      className: "row-sub",
      text: BUDGET_SHAPE_LABELS[status.budget.shape],
    }),
  ]);

  return element("li", { className: "limit-card" }, [
    element("div", { className: "limit-head" }, [
      element("span", { className: "limit-site host-name", text: site, title: site }),
      element("span", {
        className: "state-chip",
        text: state.text,
        dataset: state.tone ? { tone: state.tone } : {},
      }),
    ]),
    allowanceBlock,
    meter(status),
    element("span", {
      className: "row-sub",
      text: t(
        "settingsLimitResets",
        status.resetsAt ? formatAgo(status.resetsAt) : t("settingsResetsOnClose"),
      ),
    }),
    element("div", { className: "row-actions" }, rowActions(status)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Editing an allowance in place
 * ------------------------------------------------------------------ */

interface ByteUnit {
  readonly label: string;
  readonly factor: number;
}

/*
 * The unit symbols below are not messages, and neither are the two options in the
 * Units picker that choose between them.
 *
 * They are the symbols `formatBytes` prints on every figure in the product, and that
 * function has one table of them in `core/format.ts`. Translating the picker while
 * every number beside it still read "GB" would make the control describe something
 * the page does not show. They are also this select's values — the factor is looked
 * up by matching the chosen string — so a localised label would have to be decoupled
 * from the value first, which is a change to how the editor works rather than to what
 * it says.
 */
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
 * Turns the allowance block into a field.
 *
 * Without this, raising 800 MB to 1 GB meant retyping the domain into the add form —
 * which happens to overwrite the existing budget, with nothing in the UI saying so. The
 * row's own period and shape are sent back unchanged: an edit is a change of size, and
 * a form that quietly reset a monthly hard cap to a progressive daily one would be
 * worse than no editing at all.
 */
function startEditing(status: BudgetStatus, block: HTMLElement): void {
  editingSite = status.budget.site;

  const start = splitForEdit(status.budget.bytes);
  const amount = element("input", { className: "search-input" });
  amount.type = "number";
  amount.min = "0";
  amount.step = "any";
  amount.value = String(start.amount);
  amount.setAttribute("aria-label", t("settingsEditAmountAria", status.budget.site));

  const unit = element("select", { className: "select" });
  fillSelect(
    unit,
    editUnits().map((entry) => ({ value: entry.label, label: entry.label })),
    start.label,
  );
  unit.setAttribute("aria-label", t("settingsEditUnitAria"));

  const cancelEdit = (): void => {
    const pending = deferredStatuses;
    editingSite = null;
    deferredStatuses = null;
    renderLimits(pending ?? statuses);
  };

  const save = element("button", { className: "primary-button", text: t("settingsEditSave") });
  save.type = "submit";

  const form = element("form", { className: "exclusion-form" }, [
    amount,
    unit,
    save,
    button("ghost-button", { text: t("settingsCancel"), onClick: cancelEdit }),
  ]);

  form.addEventListener("submit", (submit) => {
    submit.preventDefault();
    const factor = editUnits().find((entry) => entry.label === unit.value)?.factor;
    const value = amount.valueAsNumber;
    if (factor === undefined || !Number.isFinite(value) || value <= 0) {
      limitStatus.textContent = t("settingsEditSizeInvalid");
      limitStatus.dataset.tone = "error";
      return;
    }
    editingSite = null;
    limitStatus.textContent = t("settingsSaving");
    limitStatus.dataset.tone = "";
    void changeLimit({
      type: "PUT_BUDGET",
      site: status.budget.site,
      bytes: Math.round(value * factor),
      period: status.budget.period,
      shape: status.budget.shape,
    }).then((saved) => {
      endEditing();
      if (!saved) return;
      limitStatus.textContent = t("settingsEditSaved", [
        status.budget.site,
        bytes(Math.round(value * factor)),
        BUDGET_PERIOD_LABELS[status.budget.period],
      ]);
    });
  });

  form.addEventListener("keydown", (key) => {
    if (key.key !== "Escape") return;
    key.preventDefault();
    cancelEdit();
  });

  replaceChildren(block, [form]);
  amount.focus();
  amount.select();
}

async function changeLimit(request: Parameters<typeof sendRequest>[0]): Promise<boolean> {
  try {
    const response = await sendRequest(request);
    if ("statuses" in response) renderLimits(response.statuses);
    limitStatus.textContent = "";
    limitStatus.dataset.tone = "";
    return true;
  } catch (error) {
    limitStatus.textContent = errorMessage(error, t("settingsLimitChangeError"));
    limitStatus.dataset.tone = "error";
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
    limitStatus.dataset.tone = "error";
    siteInput.focus();
    return;
  }
  if (size === null || size <= 0) {
    limitStatus.textContent = t("settingsLimitSizeUnreadable", raw);
    limitStatus.dataset.tone = "error";
    sizeInput.focus();
    return;
  }

  const site = parsed.site;
  const replacing = statuses.some((status) => status.budget.site === site);
  const shape = formShape;

  limitStatus.textContent = t("settingsSaving");
  limitStatus.dataset.tone = "";
  void changeLimit({ type: "PUT_BUDGET", site, bytes: size, period: formPeriod, shape }).then(
    (saved) => {
      if (!saved) return;
      siteInput.value = "";
      sizeInput.value = "";
      // Names the site key that was actually stored, which is the only signal that a
      // pasted URL was trimmed to a domain — and says when an existing limit was
      // replaced, which the form used to do silently.
      //
      // Two whole sentences, not one built from a leading clause chosen by a ternary:
      // "Replaced the limit on" and "Limit set for" are the start of a sentence in
      // English and need not be anywhere near the start of one elsewhere.
      limitStatus.textContent = t(replacing ? "settingsLimitReplaced" : "settingsLimitCreated", [
        site,
        bytes(size),
        BUDGET_PERIOD_LABELS[formPeriod],
        BUDGET_SHAPE_LABELS[shape].toLowerCase(),
      ]);
    },
  );
});

/* ------------------------------------------------------------------ *
 * Data Saver
 * ------------------------------------------------------------------ */

const SAVER_LEVEL_LABEL_KEYS: Record<SaverLevel, string> = {
  light: "settingsLevelLight",
  balanced: "settingsLevelBalanced",
  maximum: "settingsLevelMaximum",
};

const SAVER_LEVEL_HINT_KEYS: Record<SaverLevel, string> = {
  light: "settingsLevelLightHint",
  balanced: "settingsLevelBalancedHint",
  maximum: "settingsLevelMaximumHint",
};

const VISIBILITY_GROUPS: readonly {
  key: FeatureInfo["visibility"];
  titleKey: string;
  noteKey: string;
}[] = [
  {
    key: "invisible",
    titleKey: "settingsGroupInvisibleTitle",
    noteKey: "settingsGroupInvisibleNote",
  },
  {
    key: "subtle",
    titleKey: "settingsGroupSubtleTitle",
    noteKey: "settingsGroupSubtleNote",
  },
  {
    key: "noticeable",
    titleKey: "settingsGroupNoticeableTitle",
    noteKey: "settingsGroupNoticeableNote",
  },
];

/**
 * Decorative glyphs, so they carry no message.
 *
 * Each is rendered `aria-hidden`, next to the feature's own label — nothing here is
 * read out and nothing here is a word. Sending them to a translator would ask for a
 * decision about a mark that has no meaning to translate.
 */
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
const FEATURE_NOTE_KEYS: Partial<Record<FeatureId, string>> = {
  saveData: "settingsFeatureSaveDataNote",
};

/** Decorative glyphs, for the reason given above `FEATURE_SYMBOLS`. */
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
 * These are all inside Advanced now, under the three-way level picker that sets them in
 * one go. They stayed switches rather than becoming a read-only list because the
 * feature descriptions are the honest ones — "images and frames added after the page
 * loads", not "faster pages" — and someone who has read them has earned the ability to
 * act on one.
 *
 * Built once rather than per render, for the reason `bindGroup` documents: a rebuild on
 * every save destroys the checkbox the user just clicked, between the click and the
 * confirmation.
 */
function buildFeatureRows(): void {
  replaceChildren(
    featureGroups,
    VISIBILITY_GROUPS.flatMap((visibility) => {
      const count = element("span", { className: "summary-note" });
      groupCounts.set(visibility.key, count);
      const rows = FEATURES.filter((feature) => feature.visibility === visibility.key).map(
        (feature) => {
          const noteKey = FEATURE_NOTE_KEYS[feature.id];
          // The label and description are the feature table's own, already localised
          // there. Copying them into this page's catalogue would give a translator two
          // of each and the product two answers to what a feature is called.
          const built = switchRow({
            id: `feature-${feature.id}`,
            label: feature.label,
            sub: feature.description,
            glyph: FEATURE_SYMBOLS[feature.id],
            ...(noteKey ? { note: t(noteKey) } : {}),
            ...(SAVINGS_IMPACT_BY_FEATURE[feature.id] ? { impact: feature.id } : {}),
            onChange: (checked) =>
              void changeOptimize({
                features: { [feature.id]: checked } as OptimizeSettings["features"],
              }),
          });
          featureInputs.set(feature.id, built.input);
          optimizeInputs.push(built.input);
          return built.row;
        },
      );

      return [
        groupTitle(t(visibility.titleKey), count),
        element("p", { className: "group-note group-note-lead", text: t(visibility.noteKey) }),
        group(rows),
      ];
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
  packsIntro.textContent = t("settingsPacksIntro");

  replaceChildren(
    packList,
    PACKS.map((pack) => {
      // As with the features: the pack's own label and description come from the pack
      // table and are not repeated in this page's catalogue.
      const built = switchRow({
        id: `pack-${pack.id}`,
        label: pack.label,
        sub: pack.description,
        note: t("settingsPackHosts", pack.hosts.join(", ")),
        glyph: { text: PACK_SYMBOLS[pack.id] ?? pack.label.slice(0, 2), isText: true },
        onChange: (checked) => void changeOptimize({ packs: { [pack.id]: checked } }),
      });
      packInputs.set(pack.id, built.input);
      optimizeInputs.push(built.input);
      return built.row;
    }),
  );
}

/**
 * The consent disclosure for the holdout.
 *
 * This is the only place a person is told that measuring this extension's own savings
 * spends their data, so the sentence naming the cost is the load-bearing one and the
 * message's description says so to whoever translates it.
 */
function holdoutText(percent: number): string {
  if (percent === 0) return t("settingsHoldoutOffHint");
  return t("settingsHoldoutOnHint", String(percent));
}

/* ------------------------------------------------------------------ *
 * Data Saver: loading and painting
 * ------------------------------------------------------------------ */

async function loadOptimize(): Promise<void> {
  try {
    const response = await sendRequest({ type: "GET_OPTIMIZE" });
    renderOptimize(response.optimize);
  } catch (error) {
    optimizeNote.textContent = errorMessage(error, t("settingsOptimizeReadError"));
  }
}

async function changeOptimize(changes: Partial<OptimizeSettings>): Promise<void> {
  // Disabling the control that was just pressed drops focus to `<body>`, and there are
  // fourteen of these now rather than three — so a keyboard user would Tab back from
  // the top of the page after every single toggle. Held here and restored below.
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  optimizeToggle.disabled = true;
  for (const input of optimizeInputs) input.disabled = true;
  optimizeNote.textContent = t("settingsSaving");
  try {
    const response = await sendRequest({ type: "SAVE_OPTIMIZE", changes });
    renderOptimize(response.optimize);
    optimizeNote.textContent = t("settingsSaved");
  } catch (error) {
    const message = errorMessage(error, t("settingsOptimizeSaveError"));
    await loadOptimize();
    optimizeNote.textContent = message;
  } finally {
    optimizeToggle.disabled = false;
    for (const input of optimizeInputs) input.disabled = false;
    // After the blanket re-enable, never before it. That loop puts every optimize input
    // back to `disabled = false` including the fourteen behind the paid tier, so
    // without this a free install could open Advanced, toggle the master switch, and
    // find the whole matrix live — the lock undone by the one control that is not
    // behind it.
    renderLocks();
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
  // The master switch collapses everything below it, as it always has: with it off
  // there are no rules and no content script, so every control under it is describing
  // something that is not happening. The controls are built either way, so nothing
  // here rebuilds them.
  optimizeBody.hidden = !next.enabled;
  optimizeNote.dataset.active = String(next.enabled);
  optimizeNote.textContent = "";
  saverState.textContent = t(next.enabled ? "settingsSaverStateOn" : "settingsSaverStateOff");

  const level = levelOf(next.features);
  // `paintGroup` with a value matching no option checks nothing and leaves one way into
  // the group, which is exactly the Custom state: no level is the truth, and rounding
  // to the nearest one would silently undo the selection it is describing.
  paintGroup(saverLevelGroup, level ?? "");
  saverLevelCustom.hidden = level !== null;
  saverLevelHint.textContent = level
    ? t(SAVER_LEVEL_HINT_KEYS[level])
    : t("settingsLevelCustomHint");
  railSaverValue.textContent = !next.enabled
    ? t("settingsRailOff")
    : level
      ? t(SAVER_LEVEL_LABEL_KEYS[level])
      : t("settingsLevelCustom");

  for (const [id, input] of featureInputs) input.checked = next.features[id];
  for (const [id, input] of packInputs) input.checked = next.packs[id] ?? false;

  for (const visibility of VISIBILITY_GROUPS) {
    const inGroup = FEATURES.filter((feature) => feature.visibility === visibility.key);
    const on = inGroup.filter((feature) => next.features[feature.id]).length;
    const count = groupCounts.get(visibility.key);
    if (count) {
      count.textContent = t("settingsGroupCount", [
        formatCount(on),
        formatCount(inGroup.length),
      ]);
    }
  }

  paintGroup(holdoutGroup, next.holdoutPercent);
  holdoutHint.textContent = holdoutText(next.holdoutPercent);

  exclusionCount.textContent =
    next.exclusions.length === 0
      ? t("settingsExclusionsNone")
      : t("settingsExclusionsCount", formatCount(next.exclusions.length));

  // Nothing at all when the list is empty. The count beside the heading already says
  // "None", and a body repeating it in a sentence is the page saying one fact twice —
  // which is most of what made the old one long.
  replaceChildren(
    exclusionList,
    next.exclusions.length === 0
      ? []
      : next.exclusions.map((site) =>
          element("li", { className: "chip" }, [
            site,
            button("", {
              // A glyph, not a word: the accessible name beside it is what is read.
              text: "×",
              ariaLabel: t("settingsExclusionRemoveAria", site),
              onClick: () =>
                void changeOptimize({
                  exclusions: next.exclusions.filter((entry) => entry !== site),
                }),
            }),
          ]),
        ),
  );

  // `paintGroup` above moves the checked state on the holdout group, and the level
  // picker's own options are free — but the holdout's are not, and `paintGroup` does
  // not know that. Re-applying here keeps the two in step from every path that paints
  // this section, not only from the one that saves.
  renderLocks();
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
    optimizeNote.textContent = t("settingsOptimizeLoading");
    return;
  }
  if (optimize.exclusions.includes(parsed.site)) {
    optimizeNote.textContent = t("settingsExclusionDuplicate", parsed.site);
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
    const built = switchRow({
      id: `alert-${key}`,
      label,
      sub: hint,
      onChange: (checked) => void changeAlerts({ [key]: checked } as Partial<AlertSettings>),
    });
    alertInputs.set(key, built.input);
    rows.push(built.row);
  };
  add("plan", t("settingsAlertPlanLabel"), t("settingsAlertPlanHint"));
  add("sites", t("settingsAlertSitesLabel"), t("settingsAlertSitesHint"));
  replaceChildren(alertOptions, rows);
}

async function loadAlerts(): Promise<void> {
  try {
    const response = await sendRequest({ type: "GET_ALERTS" });
    renderAlerts(response.alerts);
  } catch (error) {
    alertsStatus.textContent = errorMessage(error, t("settingsAlertsReadError"));
  }
}

async function changeAlerts(changes: Partial<AlertSettings>): Promise<void> {
  alertsStatus.textContent = t("settingsSaving");
  try {
    const response = await sendRequest({ type: "SAVE_ALERTS", changes });
    renderAlerts(response.alerts);
    alertsStatus.textContent = t("settingsSaved");
  } catch (error) {
    alertsStatus.textContent = errorMessage(error, t("settingsAlertsSaveError"));
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
  const base = t("settingsAlertsThresholds", thresholds);
  // Two complete sentences joined by a space, rather than one message with a clause
  // spliced into it: the second only appears in one state, and a translator who gets
  // whole sentences can order the words inside each of them.
  alertsPlanNote.textContent =
    alerts.plan && !totalStatus()
      ? `${base} ${t("settingsAlertsNoAllowance", [
          planEnforcementLabel("progressive"),
          planEnforcementLabel("hard"),
        ])}`
      : base;
}

/* ------------------------------------------------------------------ *
 * Appearance, units and periods
 * ------------------------------------------------------------------ */

async function applySettings(changes: Partial<Settings>): Promise<void> {
  settingsStatus.textContent = t("settingsSaving");
  try {
    const response = await sendRequest({ type: "SAVE_SETTINGS", changes });
    paintSettings(response.settings);
    settingsStatus.textContent = t("settingsSaved");
  } catch (error) {
    const message = errorMessage(error, t("settingsSaveError"));
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
    liveRegion.textContent = errorMessage(error, t("settingsReadError"));
  }
}

/* ------------------------------------------------------------------ *
 * Privacy and data
 * ------------------------------------------------------------------ */

/**
 * How long usage is kept, in words.
 *
 * One message with the count substituted in covers every finite option and the
 * fallback the table used to carry separately — three messages differing only in a
 * number is the shape that comes back translated three different ways. Zero is not a
 * duration and gets its own word.
 */
function retentionLabel(days: number): string {
  return days === 0 ? t("settingsRetentionForever") : t("settingsRetentionDays", String(days));
}

function buildPrivacyOptions(): void {
  const retention = groupRow("retention-group", {
    label: t("settingsRetentionLabel"),
    sub: t("settingsRetentionHint"),
  });

  const hosts = switchRow({
    id: "track-hosts-toggle",
    label: t("settingsTrackHostsLabel"),
    sub: t("settingsTrackHostsHint"),
    onChange: (checked) => void applySettings({ trackHosts: checked }),
  });
  trackHostsInput = hosts.input;

  replaceChildren(privacyOptions, [retention.row, hosts.row]);

  bindGroup<number>({
    container: retention.group,
    options: RETENTION_OPTIONS.map((days) => ({ value: days, label: retentionLabel(days) })),
    value: RETENTION_OPTIONS[0],
    onSelect: (value) => void applySettings({ retentionDays: value }),
  });
}

function paintDeleteScope(): void {
  const kept = settings ? retentionLabel(settings.retentionDays) : "";
  // Two whole sentences rather than one with a tail appended before the full stop. The
  // clause naming the current retention sits inside the sentence in English and need
  // not anywhere else, and a message that ends mid-sentence cannot be translated at
  // all. The retention control is named through a placeholder so the two cannot drift:
  // pointing at a label that no longer exists is worse than not pointing at one.
  deleteScopeNote.textContent = kept
    ? t("settingsDeleteScopeKept", [t("settingsRetentionLabel"), kept])
    : t("settingsDeleteScope", t("settingsRetentionLabel"));
}

let deleteArmed = false;

function renderDeleteActions(): void {
  if (!deleteArmed) {
    replaceChildren(deleteActions, [
      button("ghost-button", {
        text: t("settingsDeleteButton"),
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
    text: t("settingsDeleteConfirm"),
    dataset: { danger: "true" },
    onClick: () => void performDelete(),
  });
  replaceChildren(deleteActions, [
    confirmButton,
    button("ghost-button", {
      text: t("settingsCancel"),
      onClick: () => {
        deleteArmed = false;
        deleteStatus.textContent = "";
        renderDeleteActions();
      },
    }),
  ]);
  // Two steps in the page rather than one `confirm()` dialog: the sentence above says
  // what goes and what stays, which a modal cannot without being read as boilerplate.
  deleteStatus.textContent = t("settingsDeleteWarning");
  deleteStatus.dataset.tone = "error";
  confirmButton.focus();
}

async function performDelete(): Promise<void> {
  deleteStatus.textContent = t("settingsDeleting");
  try {
    await sendRequest({ type: "CLEAR_DATA" });
    deleteArmed = false;
    renderDeleteActions();
    deleteStatus.textContent = t("settingsDeleted");
    deleteStatus.dataset.tone = "";
    await Promise.all([loadLimits(), loadStorageReport()]);
  } catch (error) {
    deleteStatus.textContent = errorMessage(error, t("settingsDeleteError"));
    deleteStatus.dataset.tone = "error";
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
    dataStatus.textContent = t("settingsExportWrote", file.filename);
  } catch (error) {
    dataStatus.textContent = errorMessage(error, t("settingsExportError"));
    dataStatus.dataset.tone = "error";
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
  replaceChildren(storageReportBlock, [
    element("p", { className: "group-note", text: t("settingsStorageReading") }),
  ]);
  try {
    const report = await sendRequest({ type: "GET_STORAGE_REPORT" });
    storageLoaded = true;
    renderStorageReport(report);
  } catch (error) {
    storageLoaded = false;
    replaceChildren(storageReportBlock, [
      element("p", {
        className: "group-note",
        text: errorMessage(error, t("settingsStorageError")),
      }),
    ]);
  }
}

function renderStorageReport(report: StorageReport): void {
  const rows: [string, string, string][] = [
    [
      t("settingsStorageDailyLabel"),
      formatCount(report.dailyRows),
      t("settingsStorageDailyDesc"),
    ],
    [
      t("settingsStorageHourlyLabel"),
      formatCount(report.hourlyRows),
      t("settingsStorageHourlyDesc"),
    ],
    [
      t("settingsStorageHostsLabel"),
      formatCount(report.hostRows),
      t("settingsStorageHostsDesc"),
    ],
    [
      t("settingsStorageVisitsLabel"),
      formatCount(report.visitRows),
      t("settingsStorageVisitsDesc"),
    ],
    [
      t("settingsStorageModelLabel"),
      formatCount(report.sizeModelRows),
      t("settingsStorageModelDesc"),
    ],
    [
      t("settingsStorageBaselinesLabel"),
      report.baselineRows === undefined
        ? t("settingsStorageNotReported")
        : formatCount(report.baselineRows),
      t("settingsStorageBaselinesDesc"),
    ],
  ];

  const table = element("table", { className: "table" }, [
    element("thead", {}, [
      element("tr", {}, [
        headerCell(t("settingsStorageColStore")),
        headerCell(t("settingsStorageColRows"), true),
        headerCell(t("settingsStorageColHolds")),
      ]),
    ]),
    element(
      "tbody",
      {},
      rows.map(([label, value, description]) =>
        element("tr", {}, [
          element("td", { text: label }),
          element("td", { className: "numeric", text: value }),
          element("td", { className: "row-sub", text: description }),
        ]),
      ),
    ),
  ]);

  const nodes: Node[] = [
    element("div", { className: "table-scroll" }, [table]),
    element("p", {
      className: "group-note",
      text:
        report.bytesUsed === null
          ? t("settingsStorageNoEstimate")
          : t("settingsStorageEstimate", bytes(report.bytesUsed)),
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
          text: t("settingsFlushErrorChip"),
          dataset: { tone: "enforcing" },
        }),
        // The leading space is the gap after the chip, not part of the sentence. The
        // worker's own error text is substituted in untranslated: it is a fact about
        // what failed, not prose this product wrote.
        ` ${t("settingsFlushError", [
          formatAgo(report.lastFlushError.at),
          report.lastFlushError.message,
        ])}`,
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
      { value: "auto", label: t("settingsThemeAuto") },
      { value: "light", label: t("settingsThemeLight") },
      { value: "dark", label: t("settingsThemeDark") },
    ],
    value: "auto",
    onSelect: (value) => void applySettings({ theme: value }),
  });

  bindGroup<Settings["badge"]>({
    container: query<HTMLDivElement>("#badge-group"),
    options: [
      { value: "off", label: t("settingsBadgeOff") },
      { value: "session", label: t("settingsBadgeSession") },
      { value: "today", label: t("settingsBadgeToday") },
    ],
    value: "off",
    onSelect: (value) => void applySettings({ badge: value }),
  });

  // The two option labels are the unit symbols themselves — see the note above
  // `SI_EDIT_UNITS` for why those are not messages.
  bindGroup<Settings["units"]>({
    container: query<HTMLDivElement>("#units-group"),
    options: [
      { value: "si", label: "kB / MB / GB" },
      { value: "iec", label: "KiB / MiB / GiB" },
    ],
    value: "si",
    onSelect: (value) => void applySettings({ units: value }),
  });
  unitsHint.textContent = t("settingsUnitsHint");

  const weekStart = groupRow("week-start-group", { label: t("settingsWeekStartLabel") });
  const weekMode = groupRow("week-mode-group", { label: t("settingsWeekModeLabel") });
  const monthMode = groupRow("month-mode-group", {
    label: t("settingsMonthModeLabel"),
    sub: t("settingsMonthModeHint"),
  });
  replaceChildren(periodOptions, [weekStart.row, weekMode.row, monthMode.row]);

  bindGroup<Settings["weekStart"]>({
    container: weekStart.group,
    options: [
      { value: 0, label: t("settingsWeekSunday") },
      { value: 1, label: t("settingsWeekMonday") },
    ],
    value: 1,
    onSelect: (value) => void applySettings({ weekStart: value }),
  });

  bindGroup<Settings["weekMode"]>({
    container: weekMode.group,
    options: [
      { value: "rolling", label: t("settingsWeekRolling") },
      { value: "calendar", label: t("settingsWeekCalendar") },
    ],
    value: "rolling",
    onSelect: (value) => void applySettings({ weekMode: value }),
  });

  bindGroup<Settings["monthMode"]>({
    container: monthMode.group,
    options: [
      { value: "rolling", label: t("settingsMonthRolling") },
      { value: "calendar", label: t("settingsMonthCalendar") },
    ],
    value: "rolling",
    onSelect: (value) => void applySettings({ monthMode: value }),
  });

  bindGroup<PlanEnforcement>({
    container: planShapeGroup,
    options: (["watch", "progressive", "hard"] as const).map((value) => ({
      value,
      label: planEnforcementLabel(value),
    })),
    value: planEnforcement,
    onSelect: (value) => void choosePlanEnforcement(value),
  });

  bindGroup<BudgetPeriod>({
    container: limitPeriodGroup,
    options: BUDGET_PERIODS.map((period) => ({
      value: period,
      label: t(PERIOD_OPTION_KEYS[period]),
      title: t("settingsLimitPeriodTitle", BUDGET_PERIOD_LABELS[period]),
    })),
    value: formPeriod,
    onSelect: (value) => {
      formPeriod = value;
      paintGroup(limitPeriodGroup, value);
    },
  });

  // The same question the plan asks, at the scope of one site, and asked the same way.
  // It replaced a switch labelled "Hard cap" whose off state named nothing at all, so
  // the choice that most people want — cut back rather than stop dead — was the one
  // with no words on it.
  bindGroup<BudgetShape>({
    container: limitShapeGroup,
    options: (["progressive", "hard"] as const).map((value) => ({
      value,
      label: t(LIMIT_SHAPE_LABEL_KEYS[value]),
    })),
    value: formShape,
    onSelect: (value) => {
      formShape = value;
      paintGroup(limitShapeGroup, value);
      limitShapeHint.textContent = t(LIMIT_SHAPE_HINT_KEYS[value]);
    },
  });
  limitShapeHint.textContent = t(LIMIT_SHAPE_HINT_KEYS[formShape]);

  bindGroup<SaverLevel>({
    container: saverLevelGroup,
    options: SAVER_LEVELS.map((level) => ({
      value: level,
      label: t(SAVER_LEVEL_LABEL_KEYS[level]),
    })),
    value: "balanced",
    onSelect: (value) => void changeOptimize({ features: featuresForLevel(value) }),
  });

  bindGroup<number>({
    container: holdoutGroup,
    options: HOLDOUT_OPTIONS.map((percent) => ({
      value: percent,
      label: percent === 0 ? t("settingsHoldoutOff") : t("settingsHoldoutPercent", String(percent)),
    })),
    value: 10,
    onSelect: (value) => void changeOptimize({ holdoutPercent: value }),
  });

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
  // Named with this page's own words for the two shapes, not the shared ones. The
  // sentence points at the two segments a person just chose between a few rows above,
  // and pointing at them by a different name would describe a control that is not
  // there.
  query<HTMLParagraphElement>("#limit-shape-explainer").textContent = t("settingsTierExplainer", [
    t("settingsPlanShapeProgressive"),
    t("settingsPlanShapeHard"),
  ]);

  replaceChildren(
    query<HTMLTableSectionElement>("#tier-table tbody"),
    [...PROGRESSIVE_THRESHOLDS]
      .sort((a, b) => a.at - b.at)
      .map((threshold) =>
        element("tr", {}, [
          element("td", { text: formatPercent(threshold.at) }),
          element("td", { text: TIER_LABELS[threshold.tier] }),
          element("td", { className: "row-sub", text: TIER_DESCRIPTIONS[threshold.tier] }),
        ]),
      ),
  );
}

/* ------------------------------------------------------------------ *
 * Plus
 *
 * Two jobs, kept apart on purpose. `renderLocks` decides what a free install may
 * touch and is the only thing that disables a control; `renderPlusPane` describes the
 * subscription and is the only thing that offers one. Mixing them is how a lock ends
 * up selling something on a pane and a pane ends up disabling something elsewhere.
 * ------------------------------------------------------------------ */

/**
 * The lock notice, addressed at this page's own Plus section.
 *
 * A wrapper rather than four copies of the fragment: `#plus` is a route into the
 * document that is already open, and the dashboard's copy of this passes
 * `settings.html#plus` instead.
 */
function lock(note: string): HTMLElement {
  return lockNotice(note, "#plus");
}

/**
 * Applies every ceiling this page owns.
 *
 * Called from each render path rather than once at startup, because two of the four
 * depend on state that changes — the limit ceiling on how many limits exist, and all of
 * them on a subscription that can start or lapse while the page is open. It is
 * idempotent, so calling it more often than necessary costs nothing.
 */
function renderLocks(): void {
  const unlocked = plus.plus;
  // Every locked segment on this page leads to the same place, one section away.
  const toPlus = (): void => {
    location.hash = "#plus";
  };
  const lockedGroup = (container: HTMLDivElement, isLocked: (value: string) => boolean): void => {
    setGroupOptionsLocked(container, {
      isLocked,
      reason: t("corePlusLockedOption"),
      onActivate: toPlus,
    });
  };

  // 1. Data Saver: the eight switches, the six image services, the holdout rate.
  replaceChildren(
    saverAdvancedLock,
    unlocked ? [] : [lock(t("settingsPlusLockSaverAdvanced"))],
  );
  setControlsEnabled(featureGroups, unlocked);
  setControlsEnabled(packList, unlocked);
  lockedGroup(holdoutGroup, () => !unlocked);

  // 2. Site limits: the count, and the windows.
  //
  // The two are separate locks on one form. Hitting the count disables the whole thing;
  // the window restriction applies at every count, so a free install's first limit is
  // already a daily one. Note what is *not* here: nothing disables an existing limit's
  // own controls, so pausing, topping up, editing and removing all keep working however
  // many there are. That is `plus/tier.ts`'s rule 1 — a ceiling on what you can add,
  // never on what you already have.
  const atLimitCeiling = !unlocked && siteLimitCount >= FREE_SITE_LIMITS;
  replaceChildren(
    limitFormLock,
    atLimitCeiling
      ? [lock(t("settingsPlusLockMoreLimits", formatCount(FREE_SITE_LIMITS)))]
      : [],
  );
  setControlsEnabled(limitForm, !atLimitCeiling);
  if (!atLimitCeiling) {
    lockedGroup(
      limitPeriodGroup,
      (value) => !unlocked && !(FREE_BUDGET_PERIODS as readonly string[]).includes(value),
    );
  }

  // 3. Appearance: units, and the week/month rules.
  replaceChildren(
    appearanceAdvancedLock,
    unlocked ? [] : [lock(t("settingsPlusLockAppearanceAdvanced"))],
  );
  lockedGroup(unitsGroup, () => !unlocked);
  setControlsEnabled(periodOptions, unlocked);

  // 4. Export range.
  //
  // The buttons are deliberately left alone. A free install exports its seven days —
  // see the note on the EXPORT handler in `background.ts` — and what is locked is how
  // far back the range reaches, so the ranges are what get disabled.
  replaceChildren(
    exportLock,
    unlocked ? [] : [lock(t("settingsPlusLockHistory", formatCount(FREE_REPORT_DAYS)))],
  );
  let selectedIsLocked = false;
  for (const option of queryAll<HTMLOptionElement>("option", exportDaysSelect)) {
    const locked = !unlocked && Number(option.value) > FREE_REPORT_DAYS;
    option.disabled = locked;
    // The label carries the reason, because a `<select>` has nowhere else to put one:
    // its options have no tooltip a person will find and no room for a glyph beside
    // them. A greyed "Last 90 days" with no explanation is the same defect the
    // segmented controls had.
    option.textContent = t(
      locked ? "settingsExportRangeDaysLocked" : "settingsExportRangeDays",
      option.value,
    );
    if (locked && option.selected) selectedIsLocked = true;
  }
  // A disabled option that is still selected stays selected in Chrome, and the worker
  // would clamp it anyway — so the file would come back holding seven days under a
  // control reading "Last 400 days". Moving the selection is what keeps the label and
  // the file the same claim.
  if (selectedIsLocked) exportDaysSelect.value = String(FREE_REPORT_DAYS);
}

/* ------------------------------------------------------------------ *
 * The Plus pane
 * ------------------------------------------------------------------ */

/** Everything Plus unlocks, in the order the sections appear on the rail. */
function plusIncludedItems(): string[] {
  return [
    t("settingsPlusItemSaver"),
    t("settingsPlusItemLimits", formatCount(FREE_SITE_LIMITS)),
    t("settingsPlusItemHistory", formatCount(FREE_REPORT_DAYS)),
    t("settingsPlusItemHosts"),
    t("settingsPlusItemCompare"),
    t("settingsPlusItemUnits"),
  ];
}

/**
 * The state block: what this install is, said before anything is offered.
 *
 * `past_due` is the one worth reading twice. It keeps Plus — `gate.ts` explains why —
 * so the heading says the subscription is active and the detail says the payment
 * failed, which is the honest pair. Rendering it as "not subscribed" would be wrong,
 * and rendering it as plain "subscribed" would hide the one thing they need to act on.
 */
function plusStateBlock(): HTMLElement[] {
  const tone =
    plus.reason === "past_due" ? "warn" : plus.plus ? "on" : plus.reason === "expired" ? "warn" : "off";
  const heading = t(
    plus.reason === "paid"
      ? "settingsPlusStatePaid"
      : plus.reason === "trial"
        ? "settingsPlusStateTrial"
        : plus.reason === "past_due"
          ? "settingsPlusStatePastDue"
          : plus.reason === "expired"
            ? "settingsPlusStateExpired"
            : "settingsPlusStateFree",
  );

  const detail =
    plus.reason === "paid"
      ? t(plus.interval === "year" ? "settingsPlusDetailYear" : "settingsPlusDetailMonth")
      : plus.reason === "trial" && plus.trialEndsAt !== null
        ? t("settingsPlusDetailTrial", formatAgo(plus.trialEndsAt))
        : plus.reason === "past_due"
          ? t("settingsPlusDetailPastDue")
          : plus.reason === "expired"
            ? t("settingsPlusDetailExpired")
            : t("settingsPlusDetailFree");

  const block = element("div", { className: "plus-card", dataset: { tone } }, [
    element("p", { className: "plus-card-title", text: heading }),
    element("p", { className: "plus-card-detail", text: detail }),
  ]);

  const nodes = [block];
  // Only ever additive, and never a downgrade. A stale answer still unlocks everything
  // it unlocked before; this line exists so a paying customer whose checks have been
  // failing finds out from the product rather than from a feature going missing.
  if (plus.stale && plus.checkedAt > 0) {
    nodes.push(
      element("p", {
        className: "group-note",
        text: t("settingsPlusStale", formatAgo(plus.checkedAt)),
      }),
    );
  }
  if (!plus.plus) {
    nodes.push(
      element("p", {
        className: "group-note plus-price",
        text: t("settingsPlusPriceLine", [PRICE_MONTHLY, PRICE_YEARLY]),
      }),
    );
  }
  return nodes;
}

function renderPlusPane(): void {
  replaceChildren(plusState, plusStateBlock());
  replaceChildren(
    plusList,
    plusIncludedItems().map((text) => element("li", { text })),
  );

  const actions: HTMLElement[] = [];
  if (plus.plus) {
    actions.push(
      button("ghost-button", {
        text: t("settingsPlusManage"),
        onClick: () => void openPlus("login"),
      }),
    );
  } else {
    if (plus.trialAvailable) {
      actions.push(
        button("primary-button", {
          text: t("settingsPlusStartTrial", formatCount(TRIAL_DAYS)),
          onClick: () => void openPlus("trial"),
        }),
      );
    }
    actions.push(
      button(plus.trialAvailable ? "ghost-button" : "primary-button", {
        text: t("settingsPlusSubscribe"),
        onClick: () => void openPlus("payment"),
      }),
    );
    // For the second machine, and for anyone who paid before reinstalling. Without it
    // the only route back to a subscription someone already owns is to buy it again.
    actions.push(
      button("ghost-button", {
        text: t("settingsPlusRestore"),
        onClick: () => void openPlus("login"),
      }),
    );
  }
  actions.push(
    button("ghost-button", {
      text: t("settingsPlusRecheck"),
      onClick: () => void recheckPlus(),
    }),
  );
  replaceChildren(plusActions, actions);

  railPlusValue.textContent = t(
    plus.reason === "trial" ? "settingsRailPlusTrial" : plus.plus ? "settingsRailPlusOn" : "settingsRailPlusOff",
  );
}

/* ------------------------------------------------------------------ *
 * Plus: loading
 * ------------------------------------------------------------------ */

function applyPlus(next: PlusStatus): void {
  plus = next;
  renderPlusPane();
  renderLocks();
}

async function loadPlus(): Promise<void> {
  try {
    const response = await sendRequest({ type: "GET_PLUS" });
    applyPlus(response.plus);
  } catch {
    // Nothing is said and nothing is unlocked. A failed read of the *cached* answer is
    // a worker that is not answering at all, which every other panel on this page is
    // already reporting in its own status line — a fifth copy of it here would be noise
    // attached to the one section that cannot act on it.
    renderLocks();
  }
}

/** The explicit "check again", which is the only place this page forces a round trip. */
async function recheckPlus(): Promise<void> {
  plusStatusLine.textContent = t("settingsPlusChecking");
  plusStatusLine.dataset.tone = "";
  try {
    const response = await sendRequest({ type: "REFRESH_PLUS" });
    applyPlus(response.plus);
    plusStatusLine.textContent = t("settingsPlusChecked");
  } catch (error) {
    plusStatusLine.textContent = errorMessage(error, t("settingsPlusCheckError"));
    plusStatusLine.dataset.tone = "error";
  }
}

async function openPlus(page: PlusPage): Promise<void> {
  plusStatusLine.textContent = "";
  try {
    await sendRequest({ type: "OPEN_PLUS_PAGE", page });
  } catch (error) {
    plusStatusLine.textContent = errorMessage(error, t("settingsPlusOpenError"));
    plusStatusLine.dataset.tone = "error";
  }
}

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

onSettingsChanged((next) => paintSettings(next));

window.addEventListener("hashchange", () => showPane(paneFromHash(), true));

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  void loadLimits();
  void loadOptimize();
  void loadAlerts();
  // The payment page opens in another tab, so coming back to this one is the moment a
  // subscription most often changes. Cheap: the worker answers from its cache and only
  // goes to the network on its own six-hour clock.
  void loadPlus();
  if (storageDetails.open) void loadStorageReport();
});

async function start(): Promise<void> {
  // Before anything is painted. A screen reader picks its voice and its pronunciation
  // rules from `<html lang>`, and every page here ships `lang="en"` in its markup — true
  // of the only catalogue that exists, and a lie the moment a second one does. Text that
  // is correct and read aloud in the wrong language is worse than text left untranslated.
  applyDocumentLanguage();
  // First, before any control is built or any pane painted. The words in the markup
  // and the words built by script sit inside the same sections, so a page that
  // localised the second lot first would show a heading in one language above its own
  // hint in another for as long as the settings read takes.
  localizeMarkup();
  showPane(paneFromHash(), false);
  bindControls();
  // Before the panes are loaded, so no control is ever painted unlocked and then
  // disabled a moment later. The worker answers this from storage, so it is one message
  // round trip and no network.
  await loadPlus();
  await loadSettings();
  await Promise.all([loadLimits(), loadOptimize(), loadAlerts()]);
  paintAlertNote();
}

void start();

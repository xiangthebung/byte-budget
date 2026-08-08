/**
 * The first run.
 *
 * `onInstalled` set alarms, primed the tab map, injected the timing script, and said
 * nothing at all. With Data Saver off, the badge off and an empty ledger, the first
 * thing a new install showed anyone was "Nothing recorded for this period yet" — a
 * blank page that explains neither what the extension will do nor what it needs from
 * the person looking at it.
 *
 * Two questions and one switch. Every one of them is skippable, and nothing is written
 * until Save is pressed — the Data Saver switch is its own commit, exactly as it is in
 * Settings — so closing the tab leaves an install running on its defaults rather than
 * one that is half set up.
 */

import "./welcome.css";
import { element, query, queryAll, replaceChildren } from "./core/dom";
import { formatBytes, parseByteSize } from "./core/format";
import { applyDocumentLanguage, t } from "./core/i18n";
import { errorMessage, sendRequest } from "./core/messages";
import { cycleResetsAt, dayKey, formatDayShort, startOfCycle } from "./core/period";
import { applyTheme } from "./core/settings";
import { ALL_SITES, MAX_CYCLE_START_DAY, type Settings } from "./core/types";
import type { OptimizeSettings } from "./optimize/features";

/**
 * Writes the text that welcome.html names but does not hold.
 *
 * Chrome substitutes `__MSG_name__` in the manifest and in CSS but not in an
 * extension page's HTML, so this loop is the only way those strings can be
 * translated at all. It runs at module scope, before the lookups below, so a key is
 * never on screen — including in the tab, since `<title>` is swept with everything
 * else.
 *
 * `aria-label` and `placeholder` are swept alongside text: the nav's name and the
 * example size in the allowance field are as much a part of this page as its
 * paragraphs, and an attribute is the string an extraction pass forgets. `popup.ts`
 * holds the twin of this loop rather than sharing one — `core/i18n.ts` is the
 * cross-surface contract and holds `t` alone.
 */
function applyFixedStrings(): void {
  for (const node of queryAll<HTMLElement>("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n ?? "");
  }
  for (const node of queryAll<HTMLElement>("[data-i18n-label]")) {
    node.setAttribute("aria-label", t(node.dataset.i18nLabel ?? ""));
  }
  for (const node of queryAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    node.placeholder = t(node.dataset.i18nPlaceholder ?? "");
  }
}

applyFixedStrings();

const planForm = query<HTMLFormElement>("#plan-form");
const planSize = query<HTMLInputElement>("#plan-size");
const planSizeHint = query<HTMLParagraphElement>("#plan-size-hint");
const cycleDay = query<HTMLSelectElement>("#cycle-day");
const cycleDayHint = query<HTMLParagraphElement>("#cycle-day-hint");
const planStatus = query<HTMLParagraphElement>("#plan-status");
const planSave = query<HTMLButtonElement>("#plan-save");
const planSkip = query<HTMLButtonElement>("#plan-skip");
const saverToggle = query<HTMLInputElement>("#saver-toggle");
const saverStatus = query<HTMLParagraphElement>("#saver-status");

let units: Settings["units"] = "si";

/* ------------------------------------------------------------------ *
 * The two questions
 * ------------------------------------------------------------------ */

/**
 * `1st`, `2nd`, `3rd`, `21st`.
 *
 * The four forms are whole messages rather than suffixes glued to a digit, because a
 * suffix is not what every language uses — some prefix the marker, some inflect the
 * number — and a translation handed only "st" cannot move it.
 *
 * The *choice* between the four is still English: 11 to 13 take the `other` form and
 * everything else goes on the last digit. That rule belongs to `Intl.PluralRules`
 * with `type: "ordinal"`, which is a behaviour change and so is not part of this
 * extraction pass. Until it lands, a locale with different ordinal categories gets
 * the right words in the wrong places.
 */
function ordinal(day: number): string {
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) return t("welcomeOrdinalOther", String(day));
  const forms = [
    "welcomeOrdinalOther",
    "welcomeOrdinalOne",
    "welcomeOrdinalTwo",
    "welcomeOrdinalFew",
  ];
  return t(forms[day % 10] ?? "welcomeOrdinalOther", String(day));
}

/**
 * The reset day as a picker over 0..`MAX_CYCLE_START_DAY`, not a typed number.
 *
 * The ceiling is the reason it is a picker at all: 29, 30 and 31 are rejected on write
 * and would silently revert, and a field that quietly discards what someone typed is
 * worse than one that never offered it. 28 is where it stops because every month has a
 * 28th, so the reset date never moves.
 */
function cycleOptions(): HTMLOptionElement[] {
  const options: HTMLOptionElement[] = [];
  for (let day = 0; day <= MAX_CYCLE_START_DAY; day++) {
    // 0 and 1 name the same reset date — the cycle functions collapse them — so
    // offering both would be two entries for one behaviour, and whichever the person
    // picked would decide nothing.
    if (day === 1) continue;
    const option = element("option", {
      text: day === 0 ? t("welcomeCycleDayCalendar") : t("welcomeCycleDayOption", ordinal(day)),
    });
    option.value = String(day);
    options.push(option);
  }
  return options;
}

/**
 * Echoes back what `parseByteSize` actually read.
 *
 * Settings never did this, and the parser has two places it can surprise someone: a
 * bare number means megabytes, and a comma is a decimal point to most of the world and
 * a thousands separator to the rest. A size read as ten times what was typed produces a
 * limit that then never fires, with nothing on screen having said so.
 */
function paintSizeHint(): void {
  const raw = planSize.value.trim();
  const parsed = raw === "" ? null : parseByteSize(raw);
  const text =
    raw === ""
      ? t("welcomePlanSizeBlank")
      : parsed === null
        ? t("welcomePlanSizeUnreadable", raw)
        : parsed <= 0
          ? t("welcomePlanSizeZero")
          : t("welcomePlanSizeRead", formatBytes(parsed, units));
  // Written only when it changes. This is a live region updated on every keystroke, and
  // reassigning the same sentence makes a screen reader announce it once per character.
  if (planSizeHint.textContent !== text) planSizeHint.textContent = text;
}

/** Whatever the picker currently shows, in the shape the cycle functions take. */
function chosenCycle(): Pick<Settings, "cycleStartDay"> {
  const day = Number(cycleDay.value);
  return { cycleStartDay: Number.isFinite(day) ? day : 0 };
}

/** The reset date implied by the current choice. */
function nextResetLabel(): string {
  return formatDayShort(dayKey(new Date(cycleResetsAt(chosenCycle()))));
}

/** The chosen day as the two dates a person can check against a bill. */
function paintCycleHint(): void {
  const started = formatDayShort(dayKey(startOfCycle(chosenCycle())));
  const text = t("welcomeCycleHint", [started, nextResetLabel()]);
  if (cycleDayHint.textContent !== text) cycleDayHint.textContent = text;
}

async function savePlan(): Promise<void> {
  const raw = planSize.value.trim();
  const parsed = raw === "" ? null : parseByteSize(raw);
  if (raw !== "" && (parsed === null || parsed <= 0)) {
    planStatus.textContent = t("welcomePlanSaveUnreadable", raw);
    planSize.focus();
    return;
  }

  const cycleStartDay = Number(cycleDay.value);
  planSave.disabled = true;
  planStatus.textContent = t("welcomeSaving");

  try {
    await sendRequest({
      type: "SAVE_SETTINGS",
      changes: { planBytes: parsed, cycleStartDay },
    });
  } catch (error) {
    planStatus.textContent = errorMessage(error, t("welcomePlanSaveFailed"));
    planSave.disabled = false;
    return;
  }

  /*
   * The allowance, kept in step with the plan.
   *
   * `settings.planBytes` on its own produces no alert, ever. Alerting reads the
   * allowances the governor tracks, and the governor tracks budgets — so a plan
   * recorded without this is a default-on plan warning watching nothing, which fails
   * silently and looks exactly like a plan warning that works.
   *
   * `ALL_SITES` because the question was about everything rather than one site. `hard`
   * because the question was "how big is your plan", not "start degrading my browsing
   * at 60% of it": nothing is refused until the plan is genuinely spent, and the three
   * warnings do the work in between. And the budget is removed when the plan is
   * cleared, for the same reason it is created when the plan is set — the two disagreeing
   * is an allowance enforcing a figure no surface displays.
   */
  try {
    if (parsed === null) {
      await sendRequest({ type: "REMOVE_BUDGET", site: ALL_SITES });
    } else {
      await sendRequest({
        type: "PUT_BUDGET",
        site: ALL_SITES,
        bytes: parsed,
        period: "month",
        shape: "hard",
      });
    }
  } catch (error) {
    // Named rather than swallowed. The plan size is stored and every surface will show
    // it, so a quiet failure here is the one state where the product looks set up and
    // the warnings can never arrive. The failure and the consequence are one message
    // with the reason as a placeholder, not a sentence bolted onto whatever the error
    // happened to say.
    planStatus.textContent = t(
      "welcomeAllowanceFailed",
      errorMessage(error, t("welcomeAllowanceFailedFallback")),
    );
    planSave.disabled = false;
    return;
  }

  planSave.disabled = false;
  planStatus.textContent =
    parsed === null
      ? t("welcomePlanSavedNone")
      : t("welcomePlanSaved", [formatBytes(parsed, units), nextResetLabel()]);
}

/**
 * Closes the tab, and writes nothing.
 *
 * The install is already in a working state — defaults, an empty ledger, and every
 * surface honest about having no plan — so skipping has nothing to store. The button
 * exists because "what do I do now" deserves an answer that is not "guess".
 */
async function skip(): Promise<void> {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {
    // The tab went away, or Chrome refused to close it. Either way there is a fallback.
  }
  window.close();
}

/* ------------------------------------------------------------------ *
 * Data Saver
 * ------------------------------------------------------------------ */

/**
 * The state and the way back out of it, in the words of the mechanism.
 *
 * Not "turn it on for a safe, automatic lighter-page profile", which names nothing a
 * person could check and nothing they could undo.
 */
function paintSaver(optimize: OptimizeSettings): void {
  saverToggle.checked = optimize.enabled;
  saverStatus.dataset.active = String(optimize.enabled);
  saverStatus.textContent = t(optimize.enabled ? "welcomeSaverOn" : "welcomeSaverOff");
}

async function loadSaver(): Promise<void> {
  try {
    const { optimize } = await sendRequest({ type: "GET_OPTIMIZE" });
    paintSaver(optimize);
  } catch (error) {
    saverStatus.textContent = errorMessage(error, t("welcomeSaverReadFailed"));
  }
}

async function changeSaver(enabled: boolean): Promise<void> {
  saverToggle.disabled = true;
  saverStatus.textContent = t("welcomeSaving");
  try {
    const { optimize } = await sendRequest({ type: "SAVE_OPTIMIZE", changes: { enabled } });
    paintSaver(optimize);
  } catch (error) {
    const message = errorMessage(error, t("welcomeSaverChangeFailed"));
    // Re-read rather than reverting the checkbox by hand: what is stored is the only
    // thing that decides, and a switch showing the value we tried to write is the
    // failure this page is least able to explain.
    await loadSaver();
    saverStatus.textContent = message;
  } finally {
    saverToggle.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

planSize.addEventListener("input", paintSizeHint);
cycleDay.addEventListener("change", paintCycleHint);
planForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void savePlan();
});
planSkip.addEventListener("click", () => void skip());
saverToggle.addEventListener("change", () => void changeSaver(saverToggle.checked));

async function start(): Promise<void> {
  // Before anything is painted. A screen reader picks its voice and its pronunciation
  // rules from `<html lang>`, and every page here ships `lang="en"` in its markup — true
  // of the only catalogue that exists, and a lie the moment a second one does. Text that
  // is correct and read aloud in the wrong language is worse than text left untranslated.
  applyDocumentLanguage();
  replaceChildren(cycleDay, cycleOptions());

  try {
    const { settings } = await sendRequest({ type: "GET_SETTINGS" });
    applyTheme(settings.theme);
    units = settings.units;
    // Prefilled rather than blank, because this page is reachable by URL after the
    // install that opened it: an empty field would imply nothing is set. `formatBytes`
    // never groups and never writes more than one decimal, so `parseByteSize` reads its
    // own output back and re-saving cannot change the figure.
    if (settings.planBytes !== null) planSize.value = formatBytes(settings.planBytes, units);
    cycleDay.value = String(settings.cycleStartDay);
    // A stored 1 has no option of its own — it is the same date as the calendar month —
    // and assigning a value no option carries leaves the select showing nothing.
    if (cycleDay.value === "") cycleDay.value = "0";
  } catch (error) {
    planStatus.textContent = errorMessage(error, t("welcomeSettingsReadFailed"));
  }

  paintSizeHint();
  paintCycleHint();
  await loadSaver();
}

void start();

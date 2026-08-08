/**
 * Preferences, in `chrome.storage.sync` so they follow the person between
 * browsers. Only preferences: measured usage stays on the device it happened on.
 *
 * Every read normalises, rather than trusting what is stored. A value that
 * arrived over sync from a newer build, or from a build with a different set of
 * options, would otherwise reach the formatter as `undefined` and print `NaN`
 * where a byte count belongs.
 */

import { DEFAULT_SETTINGS, RETENTION_OPTIONS, type Settings } from "./types";

const SETTINGS_KEY = "settings";

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** For numbers that come from a fixed menu: anything outside it is a build we do not know. */
function pickNumber(value: unknown, allowed: readonly number[], fallback: number): number {
  return typeof value === "number" && allowed.includes(value) ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Guarantees a complete `Settings` in which every field holds one of its declared
 * options — an unrecognised or out-of-range value falls back to the default rather
 * than reaching a formatter as `undefined`. Nothing is dropped: what a person
 * saved is what comes back.
 *
 * This used to spread `DEFAULT_SETTINGS` and carry forward only `theme` and
 * `badge`, which meant `retentionDays` was permanently 400 and `trackHosts`
 * permanently on for everyone — controls the privacy policy describes as theirs,
 * that the worker already honours (`pruneOldRows`, `ledger.setTrackHosts`) and
 * that only this function was standing in the way of. So: every field is listed,
 * and listing them beats spreading the defaults because a field added to
 * `Settings` then fails to compile here until someone decides how to validate it.
 */
function normalize(value: Partial<Settings> | undefined): Settings {
  return {
    theme: pick(value?.theme, ["auto", "light", "dark"], DEFAULT_SETTINGS.theme),
    units: pick(value?.units, ["si", "iec"], DEFAULT_SETTINGS.units),
    weekMode: pick(value?.weekMode, ["calendar", "rolling"], DEFAULT_SETTINGS.weekMode),
    monthMode: pick(value?.monthMode, ["calendar", "rolling"], DEFAULT_SETTINGS.monthMode),
    weekStart: value?.weekStart === 1 ? 1 : value?.weekStart === 0 ? 0 : DEFAULT_SETTINGS.weekStart,
    retentionDays: pickNumber(
      value?.retentionDays,
      RETENTION_OPTIONS,
      DEFAULT_SETTINGS.retentionDays,
    ),
    badge: pick(value?.badge, ["off", "session", "today"], DEFAULT_SETTINGS.badge),
    trackHosts: pickBoolean(value?.trackHosts, DEFAULT_SETTINGS.trackHosts),
  };
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return normalize(stored[SETTINGS_KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(changes: Partial<Settings>): Promise<Settings> {
  const settings = normalize({ ...(await getSettings()), ...changes });
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  return settings;
}

/** Fires whenever settings change, including from another window or device. */
export function onSettingsChanged(listener: (settings: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes[SETTINGS_KEY]) return;
    listener(normalize(changes[SETTINGS_KEY].newValue as Partial<Settings> | undefined));
  });
}

/**
 * Applies the theme to a document root. `auto` removes the attribute and lets
 * the `prefers-color-scheme` media queries in the stylesheet decide.
 */
export function applyTheme(theme: Settings["theme"], root = document.documentElement): void {
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

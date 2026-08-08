/**
 * Preferences, in `chrome.storage.sync` so they follow the person between
 * browsers. Only preferences: measured usage stays on the device it happened on.
 *
 * Every read normalises, rather than trusting what is stored. A value that
 * arrived over sync from a newer build, or from a build with a different set of
 * options, would otherwise reach the formatter as `undefined` and print `NaN`
 * where a byte count belongs.
 */

import { DEFAULT_SETTINGS, type Settings } from "./types";

const SETTINGS_KEY = "settings";

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function normalize(value: Partial<Settings> | undefined): Settings {
  // Keep the product predictable: customers choose only presentation and whether a
  // toolbar total is useful. Data-plan units, rolling periods, retention and host
  // detail use one safe default everywhere instead of becoming setup questions.
  return {
    ...DEFAULT_SETTINGS,
    theme: pick(value?.theme, ["auto", "light", "dark"], DEFAULT_SETTINGS.theme),
    badge: value?.badge === "today" ? "today" : "off",
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

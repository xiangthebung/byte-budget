/**
 * The generic optimizers, and the settings that switch everything on and off.
 *
 * Two kinds, and the split is not cosmetic. Some are enforced by
 * `declarativeNetRequest`, which refuses or alters a request before it is sent and
 * therefore removes bytes outright. The rest run in the page and change what it asks
 * for in the first place — they cost a content script on every page, so each one has
 * to earn it.
 *
 * Every feature is individually switchable because they are not equally safe. Asking
 * for a smaller image is invisible; dropping web fonts is not. Bundling them behind
 * one switch would mean the cautious setting is also the useless one.
 */

import { PACKS } from "./packs";

export const DNR_FEATURES = ["saveData", "blockBeacons", "systemFonts"] as const;
export const PAGE_FEATURES = [
  "trimSrcset",
  "lazyOffscreen",
  "tameMedia",
  "clickToLoadMedia",
  "dropHints",
] as const;

export type DnrFeatureId = (typeof DNR_FEATURES)[number];
export type PageFeatureId = (typeof PAGE_FEATURES)[number];
export type FeatureId = DnrFeatureId | PageFeatureId;
export type SavingsImpact = "low" | "medium" | "high";

/** Relative potential, not a percentage: actual savings depend on the site. */
export const SAVINGS_IMPACT_BY_FEATURE: Readonly<
  Partial<Record<FeatureId, SavingsImpact>>
> = {
  clickToLoadMedia: "high",
  dropHints: "medium",
  systemFonts: "low",
};

export const FEATURE_IDS: readonly FeatureId[] = [...DNR_FEATURES, ...PAGE_FEATURES];

export interface FeatureInfo {
  id: FeatureId;
  label: string;
  description: string;
  /** How visible the change is, for the UI to order and default by. */
  visibility: "invisible" | "subtle" | "noticeable";
  defaultOn: boolean;
}

export const FEATURES: readonly FeatureInfo[] = [
  {
    id: "saveData",
    label: "Ask sites for the light version",
    description:
      "Sends the Save-Data header, which many image CDNs and some sites honour by serving smaller assets. Sites that ignore it are unaffected.",
    visibility: "invisible",
    defaultOn: true,
  },
  {
    id: "blockBeacons",
    label: "Drop analytics beacons",
    description:
      "Refuses fire-and-forget tracking pings. They are small individually and constant in aggregate, and nothing on the page waits for them.",
    visibility: "invisible",
    defaultOn: true,
  },
  /*
   * The two image features below are honest about a real limit.
   *
   * Nothing running in a page can beat Chrome's preload scanner: by the time a script
   * sees an `<img>` in the DOM, its request has already gone out. Measured, not assumed
   * — the browser test sets `loading="lazy"` on an image six thousand pixels down and
   * the server is asked for it anyway.
   *
   * So both of these act on content added *after* the initial parse, which is where the
   * bytes are on the modern web anyway: an endless feed, a gallery that pages in, an
   * app that renders its own content. The labels say so rather than implying they fix
   * the first screenful.
   */
  {
    id: "trimSrcset",
    label: "Stop feeds over-ordering images",
    description:
      "For images added after the page loads, asks for the smallest version that still covers the space it is shown in rather than one sized for a higher-density screen. Images in the initial HTML are already requested before any script can see them.",
    visibility: "subtle",
    defaultOn: true,
  },
  {
    id: "lazyOffscreen",
    label: "Load feed images when they are reached",
    description:
      "Defers images and frames added after the page loads until they are near the viewport, so scrolling halfway down an endless feed costs half of it. Again, only what arrives after the initial parse.",
    visibility: "invisible",
    defaultOn: true,
  },
  {
    id: "tameMedia",
    label: "Stop offscreen video pre-buffering",
    description:
      "Turns off preloading and autoplay for video and audio that is not on screen. The heaviest single thing most pages do without being asked.",
    visibility: "subtle",
    defaultOn: true,
  },
  {
    id: "clickToLoadMedia",
    label: "Click to load video and audio",
    description:
      "Holds video and audio sources until they are clicked. Some media requested directly by the page may start before an extension can pause it.",
    visibility: "noticeable",
    defaultOn: false,
  },
  {
    id: "dropHints",
    label: "Ignore speculative loading",
    // Deliberately not "stops a page prefetching". This runs in the page, and a hint
    // written into the first HTML is dispatched by Chrome's preload scanner before any
    // script sees the element — measured in `scripts/smoke.mjs`, the same limit PLAN.md
    // §5.2 records for the image features. Hints a page adds later are caught, which on
    // an app-rendered site is most of them.
    description:
      "Removes prefetch, preload and prerender hints, so a page cannot spend your data on something you may never open. Hints in the first HTML may start before an extension can remove them.",
    visibility: "subtle",
    defaultOn: false,
  },
  {
    id: "systemFonts",
    label: "Use system fonts",
    description:
      "Refuses downloadable fonts and falls back to what is already on the device. Usually a small first-visit saving because fonts are cached, so it is off by default.",
    visibility: "noticeable",
    defaultOn: false,
  },
];

export const FEATURES_BY_ID: ReadonlyMap<FeatureId, FeatureInfo> = new Map(
  FEATURES.map((feature) => [feature.id, feature]),
);

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export interface OptimizeSettings {
  /** Master switch. Off means no rules and no content scripts at all. */
  enabled: boolean;
  features: Record<FeatureId, boolean>;
  /** Pack id to on/off. */
  packs: Record<string, boolean>;
  /** Sites never to optimize, as site keys. */
  exclusions: string[];
  /**
   * Percentage of page loads deliberately left unoptimized.
   *
   * This is what makes the savings figure defensible. Without a control group the
   * number is the sum of the extension's own guesses about requests it prevented;
   * with one, it is the measured difference between two populations of real page
   * loads. It costs the occasional heavier load, and it is disclosed and switchable.
   */
  holdoutPercent: number;
}

export const HOLDOUT_OPTIONS = [0, 5, 10, 20] as const;

export function defaultOptimizeSettings(): OptimizeSettings {
  const features = {} as Record<FeatureId, boolean>;
  for (const feature of FEATURES) features[feature.id] = feature.defaultOn;
  const packs: Record<string, boolean> = {};
  for (const pack of PACKS) packs[pack.id] = pack.defaultOn;
  return { enabled: false, features, packs, exclusions: [], holdoutPercent: 10 };
}

const STORAGE_KEY = "optimize";

function normalize(value: Partial<OptimizeSettings> | undefined): OptimizeSettings {
  const defaults = defaultOptimizeSettings();
  const features = { ...defaults.features };
  for (const id of FEATURE_IDS) {
    const stored = value?.features?.[id];
    if (typeof stored === "boolean") features[id] = stored;
  }
  const packs = { ...defaults.packs };
  for (const pack of PACKS) {
    const stored = value?.packs?.[pack.id];
    if (typeof stored === "boolean") packs[pack.id] = stored;
  }
  const holdout = Number(value?.holdoutPercent);
  return {
    enabled: typeof value?.enabled === "boolean" ? value.enabled : defaults.enabled,
    features,
    packs,
    exclusions: Array.isArray(value?.exclusions)
      ? [...new Set(value.exclusions.filter((site) => typeof site === "string" && site))]
      : [],
    holdoutPercent: (HOLDOUT_OPTIONS as readonly number[]).includes(holdout)
      ? holdout
      : defaults.holdoutPercent,
  };
}

export async function getOptimizeSettings(): Promise<OptimizeSettings> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  return normalize(stored[STORAGE_KEY] as Partial<OptimizeSettings> | undefined);
}

export async function saveOptimizeSettings(
  changes: Partial<OptimizeSettings>,
): Promise<OptimizeSettings> {
  const current = await getOptimizeSettings();
  const merged = normalize({
    ...current,
    ...changes,
    features: { ...current.features, ...(changes.features ?? {}) },
    packs: { ...current.packs, ...(changes.packs ?? {}) },
  });
  await chrome.storage.sync.set({ [STORAGE_KEY]: merged });
  return merged;
}

/** Whether optimization applies to a site at all. */
export function optimizes(settings: OptimizeSettings, site: string): boolean {
  if (!settings.enabled) return false;
  if (!site || site.startsWith("#")) return false;
  return !settings.exclusions.includes(site);
}

/** The page-side features that are on, for the content script to act on. */
export function activePageFeatures(settings: OptimizeSettings): PageFeatureId[] {
  return PAGE_FEATURES.filter((id) => settings.features[id]);
}

export function anyPageFeature(settings: OptimizeSettings): boolean {
  return settings.enabled && activePageFeatures(settings).length > 0;
}

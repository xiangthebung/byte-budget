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

import { t } from "../core/i18n";
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
  /** Already localised. The catalogue key is `coreFeature<Id>Label`. */
  label: string;
  /** Already localised. The catalogue key is `coreFeature<Id>Description`. */
  description: string;
  /** How visible the change is, for the UI to order and default by. */
  visibility: "invisible" | "subtle" | "noticeable";
  defaultOn: boolean;
}

export const FEATURES: readonly FeatureInfo[] = [
  {
    id: "saveData",
    label: t("coreFeatureSaveDataLabel"),
    description: t("coreFeatureSaveDataDescription"),
    visibility: "invisible",
    defaultOn: true,
  },
  {
    id: "blockBeacons",
    label: t("coreFeatureBlockBeaconsLabel"),
    description: t("coreFeatureBlockBeaconsDescription"),
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
   * app that renders its own content. The descriptions say so rather than implying they
   * fix the first screenful — the English is in `i18n/core.json` now, under
   * `coreFeatureTrimSrcsetDescription` and `coreFeatureLazyOffscreenDescription`, and
   * each carries that limit as its own sentence so a translation cannot lose it.
   */
  {
    id: "trimSrcset",
    label: t("coreFeatureTrimSrcsetLabel"),
    description: t("coreFeatureTrimSrcsetDescription"),
    visibility: "subtle",
    defaultOn: true,
  },
  {
    id: "lazyOffscreen",
    label: t("coreFeatureLazyOffscreenLabel"),
    description: t("coreFeatureLazyOffscreenDescription"),
    visibility: "invisible",
    defaultOn: true,
  },
  {
    id: "tameMedia",
    label: t("coreFeatureTameMediaLabel"),
    description: t("coreFeatureTameMediaDescription"),
    visibility: "subtle",
    defaultOn: true,
  },
  {
    id: "clickToLoadMedia",
    label: t("coreFeatureClickToLoadMediaLabel"),
    description: t("coreFeatureClickToLoadMediaDescription"),
    visibility: "noticeable",
    defaultOn: false,
  },
  {
    id: "dropHints",
    label: t("coreFeatureDropHintsLabel"),
    // The description is deliberately not "stops a page prefetching". This runs in the
    // page, and a hint written into the first HTML is dispatched by Chrome's preload
    // scanner before any script sees the element — measured in `scripts/smoke.mjs`, the
    // same limit PLAN.md §5.2 records for the image features. Hints a page adds later
    // are caught, which on an app-rendered site is most of them. The sentence that says
    // so is the second one in `coreFeatureDropHintsDescription`; a translation that
    // drops it makes the feature claim something it cannot do.
    description: t("coreFeatureDropHintsDescription"),
    visibility: "subtle",
    defaultOn: false,
  },
  {
    id: "systemFonts",
    label: t("coreFeatureSystemFontsLabel"),
    description: t("coreFeatureSystemFontsDescription"),
    visibility: "noticeable",
    defaultOn: false,
  },
];

export const FEATURES_BY_ID: ReadonlyMap<FeatureId, FeatureInfo> = new Map(
  FEATURES.map((feature) => [feature.id, feature]),
);

/* ------------------------------------------------------------------ *
 * Preset levels
 * ------------------------------------------------------------------ */

/**
 * Three named sets of the eight features above, so the ordinary way to use Data Saver
 * is one choice rather than eight.
 *
 * The switches are still all there, under Advanced, and none of this removes one. What
 * it removes is the requirement to have an opinion about `trimSrcset` before the
 * feature does anything: a settings page that opens on eight checkboxes is asking a
 * question most people cannot answer, and the honest answer to "which of these do I
 * want" is "the safe ones" or "all of them".
 *
 * Each level is *derived* rather than listed, and that is the point. A listed set is a
 * second table to keep in step with `FEATURES`, and the failure when it drifts is
 * silent — a feature added above and forgotten here would be reachable from Advanced
 * and from no preset, so choosing "Maximum" would quietly turn it off. Deriving from
 * fields `FEATURES` already carries means a new feature lands in a level by describing
 * itself.
 */
export const SAVER_LEVELS = ["light", "balanced", "maximum"] as const;

export type SaverLevel = (typeof SAVER_LEVELS)[number];

/**
 * The features each level switches on.
 *
 * - `light` is every feature whose `visibility` is `invisible` — which is the same
 *   claim the group heading makes on the page, so the level cannot promise something
 *   the feature descriptions contradict.
 * - `balanced` is what a fresh install ships with, so an install that has never
 *   touched Advanced reads as Balanced rather than as Custom.
 * - `maximum` is all of them.
 *
 * `tests/optimize.test.mjs` pins the one property none of these three definitions
 * states on its own: that they nest. A ladder whose middle rung switches something off
 * that the rung below switches on is not a ladder, and the control that presents it as
 * one would be lying.
 */
export const SAVER_LEVEL_FEATURES: Record<SaverLevel, readonly FeatureId[]> = {
  light: FEATURES.filter((feature) => feature.visibility === "invisible").map(
    (feature) => feature.id,
  ),
  balanced: FEATURES.filter((feature) => feature.defaultOn).map((feature) => feature.id),
  maximum: FEATURE_IDS,
};

/** The full feature record a level implies, including the ones it switches off. */
export function featuresForLevel(level: SaverLevel): Record<FeatureId, boolean> {
  const on = new Set(SAVER_LEVEL_FEATURES[level]);
  const features = {} as Record<FeatureId, boolean>;
  for (const id of FEATURE_IDS) features[id] = on.has(id);
  return features;
}

/**
 * Which level a stored feature set is, or `null` when it is none of them.
 *
 * `null` is not a failure and is not repaired. Someone who opened Advanced and
 * switched one thing off has a selection, and a control that rounded it to the
 * nearest preset would silently undo it the next time the page painted. The surface
 * says "Custom" instead and leaves it alone.
 */
export function levelOf(features: Record<FeatureId, boolean>): SaverLevel | null {
  return (
    SAVER_LEVELS.find((level) =>
      FEATURE_IDS.every((id) => features[id] === SAVER_LEVEL_FEATURES[level].includes(id)),
    ) ?? null
  );
}

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

/**
 * The exclusion list is stored apart from the rest, in `chrome.storage.local`.
 *
 * Everything else on `OptimizeSettings` is a preference — a master switch, feature
 * flags, pack toggles, a sampling rate — and says nothing about anyone's browsing, so
 * it stays in sync and keeps following the person between machines. `exclusions` is a
 * list of site keys: the sites someone found the optimizer broke, or did not want
 * touched. That is browsing data, and PRIVACY_POLICY.md promises the sync transfer
 * carries none.
 *
 * The cost of the split is that the never-optimize list is per-profile now: exclude a
 * site on the laptop and the desktop carries on optimizing it. That is the deliberate
 * half of the trade, taken for the same reason as the one in `limit/budgets.ts`. The
 * public API still hands out a single `OptimizeSettings`, so no caller has to know the
 * value is assembled from two areas.
 */
const EXCLUSIONS_KEY = "optimizeExclusions";

function normalizeExclusions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((site): site is string => typeof site === "string" && site !== "")),
  ];
}

/**
 * `exclusions` is taken as a second argument rather than read off `value`, and a
 * caller that puts it back into the first will find it ignored. That is on purpose:
 * `value` is whatever the synced item holds, and an older build's copy of the list is
 * still in there until the migration below rewrites it. Reading it from both places
 * would make the stale synced copy win over the local one at every cold start.
 */
function normalize(
  value: Partial<OptimizeSettings> | undefined,
  exclusions: unknown,
): OptimizeSettings {
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
    exclusions: normalizeExclusions(exclusions),
    holdoutPercent: (HOLDOUT_OPTIONS as readonly number[]).includes(holdout)
      ? holdout
      : defaults.holdoutPercent,
  };
}

let migration: Promise<void> | null = null;

/**
 * Lifts the exclusion list out of the synced item, once.
 *
 * The synced item is rewritten rather than removed: the master switch, the feature
 * flags, the packs and the holdout rate belong in sync and are meant to keep following
 * the person. Only `exclusions` comes out.
 *
 * Local wins whenever it already holds a list, empty included — `[]` is what "I
 * un-excluded my last site" looks like, and adopting the synced copy over it would put
 * the exclusion back and leave the site quietly unoptimized with nothing on any surface
 * saying why.
 */
async function migrateFromSync(): Promise<void> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY] as Partial<OptimizeSettings> | undefined;
  if (!raw || typeof raw !== "object" || !("exclusions" in raw)) return;
  const { exclusions, ...preferences } = raw;
  const local = await chrome.storage.local.get(EXCLUSIONS_KEY);
  if (local[EXCLUSIONS_KEY] === undefined) {
    await chrome.storage.local.set({ [EXCLUSIONS_KEY]: normalizeExclusions(exclusions) });
  }
  await chrome.storage.sync.set({ [STORAGE_KEY]: preferences });
}

/**
 * Memoized per worker, and it clears the memo on failure rather than caching it.
 *
 * A cached rejection would make `getOptimizeSettings` throw for the worker's whole
 * life, and `applyOptimize` reads through it on every wake — the optimizer would come
 * back with no rules and no content script and no error anyone could see. Retrying next
 * wake costs one `sync.get` of an item that no longer has the field.
 */
function ensureMigrated(): Promise<void> {
  if (!migration) {
    migration = migrateFromSync().catch((error: unknown) => {
      migration = null;
      console.error("Byte Budget: could not move the exclusion list out of sync storage", error);
    });
  }
  return migration;
}

export async function getOptimizeSettings(): Promise<OptimizeSettings> {
  await ensureMigrated();
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get(STORAGE_KEY),
    chrome.storage.local.get(EXCLUSIONS_KEY),
  ]);
  return normalize(
    synced[STORAGE_KEY] as Partial<OptimizeSettings> | undefined,
    local[EXCLUSIONS_KEY],
  );
}

export async function saveOptimizeSettings(
  changes: Partial<OptimizeSettings>,
): Promise<OptimizeSettings> {
  const current = await getOptimizeSettings();
  const merged = normalize(
    {
      ...current,
      ...changes,
      features: { ...current.features, ...(changes.features ?? {}) },
      packs: { ...current.packs, ...(changes.packs ?? {}) },
    },
    changes.exclusions ?? current.exclusions,
  );
  // Split on the way out as well as on the way in. Writing `merged` whole would put the
  // site keys straight back into sync, undoing the split silently and with no symptom
  // anywhere — which is precisely how they got there in the first place.
  const { exclusions, ...preferences } = merged;
  await Promise.all([
    chrome.storage.sync.set({ [STORAGE_KEY]: preferences }),
    chrome.storage.local.set({ [EXCLUSIONS_KEY]: exclusions }),
  ]);
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

/**
 * Enforcement tiers: what gets dropped as a site approaches, and passes, its
 * budget.
 *
 * MV3 cannot pace a request — `declarativeNetRequest` blocks, redirects and
 * rewrites headers, and has no rate control (PLAN.md §1.4). What it *can* do is
 * refuse a request before it is dispatched, which costs exactly zero bytes rather
 * than "bytes we noticed afterwards". So the lever here is *which kinds* of
 * request are allowed, in the order that trades the fewest bytes for the least
 * damage to the page.
 *
 * A note on why this is more useful than it sounds for video. Adaptive streaming
 * fetches 2-6 second segments as separate requests, and progressive video uses
 * byte-range requests — a forty-minute video is hundreds of requests, not one. So
 * dropping `media` does not need to predict the size of a film; it cuts the stream
 * at the next segment, and the player's own bitrate logic usually steps down to a
 * smaller representation rather than stopping.
 *
 * `main_frame` is never in any tier. Blocking the document gives Chrome's error
 * page, which reads as a broken site; letting the shell load means the page can
 * still say what happened. A hard stop on navigation belongs behind its own
 * explicit setting, not at the end of a slope.
 */

import type { ResourceType } from "../core/types";

export const TIERS = ["off", "trim", "lean", "strict"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABELS: Record<Tier, string> = {
  off: "No limit",
  trim: "Skip video and audio",
  lean: "Skip video, images and fonts",
  strict: "Page shell only",
};

export const TIER_DESCRIPTIONS: Record<Tier, string> = {
  off: "Everything loads normally.",
  trim: "Video and audio segments are refused. Players usually drop to a lower quality or pause.",
  lean: "Also refuses images and web fonts. Layout survives; pictures do not.",
  strict:
    "Refuses every subresource. The page's own HTML still loads so it can tell you what happened, but nothing else does.",
};

/**
 * Ordered heaviest-first. Each tier is a prefix of this list, which is what makes
 * the tiers a slope rather than four unrelated settings.
 */
const SHED_ORDER: readonly ResourceType[] = [
  "media",
  "image",
  "font",
  "sub_frame",
  "script",
  "stylesheet",
  "xmlhttprequest",
  "websocket",
  "ping",
  "other",
];

const TIER_DEPTH: Record<Tier, number> = {
  off: 0,
  trim: 1,
  lean: 3,
  strict: SHED_ORDER.length,
};

/** The resource types a tier refuses. Never includes `main_frame`. */
export function blockedTypes(tier: Tier): ResourceType[] {
  return SHED_ORDER.slice(0, TIER_DEPTH[tier]);
}

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/** Whether a tier would refuse a given resource type. */
export function tierBlocks(tier: Tier, type: ResourceType): boolean {
  return TIER_DEPTH[tier] > SHED_ORDER.indexOf(type) && SHED_ORDER.includes(type);
}

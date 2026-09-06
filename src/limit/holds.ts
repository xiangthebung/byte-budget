/**
 * Holds: a tier applied to one site for a while, because someone asked.
 *
 * A limit is a rule about a number. A hold is a decision about a site, made from the
 * popup while watching it eat the connection — "skip video here for an hour", "pause
 * this site for an hour" — and it has to work without a budget behind it, because the
 * person pressing the button has not set one and should not have to type a byte
 * figure to stop a tab they forgot about.
 *
 * Two tiers are offered and no more. `trim` refuses video and audio, which is the
 * thing that is eating a metered connection nine times in ten and the thing whose
 * absence a page survives best. `strict` refuses everything but the page itself, which
 * is what "pause this site" means. Both expire on their own, through the same minute
 * alarm that rolls budget windows over, so a hold set and forgotten cannot outlive the
 * hour it was asked for.
 *
 * Stored in `chrome.storage.local`, not `sync`, for the reason every budget is: a
 * hold names a site. It is also deliberately *not* usage, so deleting all recorded
 * usage leaves it in place — it is a thing the person asked for, and the answer to
 * "I deleted my data and the site is still paused" is the Resume button, which is one
 * tap and stays on screen while the hold is.
 */

import { isTier, TIERS, type Tier } from "./tiers";

const HOLDS_KEY = "holds";

/** The tiers a hold may carry. `off` is not a hold, and `lean` is not offered. */
export const HOLD_TIERS: readonly Tier[] = ["trim", "strict"];

/** How long a hold lasts. One choice, because two buttons per tier is four buttons. */
export const HOLD_MINUTES = 60;

export interface Hold {
  site: string;
  tier: Tier;
  /** Epoch ms the hold expires. */
  until: number;
  /** Epoch ms it was set, so a surface can say how long it has been in force. */
  since: number;
}

type Stored = Record<string, { tier: string; until: number; since?: number }>;

function normalize(value: unknown, now: number): Map<string, Hold> {
  const holds = new Map<string, Hold>();
  if (!value || typeof value !== "object") return holds;
  for (const [site, raw] of Object.entries(value as Stored)) {
    if (!site || site.startsWith("#")) continue;
    if (!raw || !isTier(raw.tier) || !HOLD_TIERS.includes(raw.tier)) continue;
    if (typeof raw.until !== "number" || !(raw.until > now)) continue;
    holds.set(site, {
      site,
      tier: raw.tier,
      until: raw.until,
      since: typeof raw.since === "number" ? raw.since : now,
    });
  }
  return holds;
}

async function write(holds: ReadonlyMap<string, Hold>): Promise<void> {
  const stored: Stored = {};
  for (const [site, hold] of holds) {
    stored[site] = { tier: hold.tier, until: hold.until, since: hold.since };
  }
  await chrome.storage.local.set({ [HOLDS_KEY]: stored });
}

/** Every hold still in force at `now`. Expired ones are dropped on read, not kept. */
export async function getHolds(now = Date.now()): Promise<Hold[]> {
  const stored = await chrome.storage.local.get(HOLDS_KEY);
  return [...normalize(stored[HOLDS_KEY], now).values()].sort((a, b) =>
    a.site.localeCompare(b.site),
  );
}

/**
 * Sets, or replaces, the hold on a site.
 *
 * A second press restarts the hour rather than adding one: "for an hour" is what the
 * button says, and an hour from now is what it means.
 */
export async function setHold(
  site: string,
  tier: Tier,
  minutes = HOLD_MINUTES,
  now = Date.now(),
): Promise<Hold[]> {
  if (!site || site.startsWith("#")) throw new Error("That is not a site that can be held.");
  if (!HOLD_TIERS.includes(tier)) throw new Error(`A hold cannot be set to "${tier}".`);
  const stored = await chrome.storage.local.get(HOLDS_KEY);
  const holds = normalize(stored[HOLDS_KEY], now);
  holds.set(site, { site, tier, until: now + Math.max(1, minutes) * 60_000, since: now });
  await write(holds);
  return [...holds.values()];
}

export async function clearHold(site: string, now = Date.now()): Promise<Hold[]> {
  const stored = await chrome.storage.local.get(HOLDS_KEY);
  const holds = normalize(stored[HOLDS_KEY], now);
  holds.delete(site);
  await write(holds);
  return [...holds.values()];
}

/**
 * The deeper of two tiers, for a site under a budget and a hold at once.
 *
 * Every tier's refused set is a prefix of one shed order, so the deeper tier is a
 * superset of the shallower and there is nothing to arbitrate — the same argument
 * `limit/rules.ts` makes for a total and a per-site limit on one request.
 */
export function deeperTier(a: Tier, b: Tier): Tier {
  return TIERS.indexOf(a) >= TIERS.indexOf(b) ? a : b;
}

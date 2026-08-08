/**
 * Installing and removing the enforcement rules.
 *
 * Session-scoped rules, not dynamic ones. Enforcement is derived state — it is
 * recomputed from usage against a budget — and derived state should not outlive the
 * browser session that computed it. A dynamic rule survives a restart, so a crash
 * at the wrong moment would leave a site blocked with nothing left to explain why.
 *
 * The decision map is mirrored into `chrome.storage.session` for the same reason
 * the tab map is: the worker is torn down after thirty idle seconds, and the
 * `webRequest` listener that has to decide whether a blocked request was *our*
 * doing needs to know what we are enforcing. Chrome keeps the DNR rules alive
 * across that restart; the reason for them has to survive too.
 */

import { asResourceType, type ResourceType } from "../core/types";
import { publishRules, type RuleSpec } from "../rules/session";
import { enforcementRules, type EnforcementEntry } from "./rules";
import { isTier, tierBlocks, type Tier } from "./tiers";

const SESSION_KEY = "enforcement";

interface StoredEntry {
  tier: Tier;
  tabIds: number[];
  /** When it was applied, for the UI to explain itself. */
  since: number;
}

const entries = new Map<string, StoredEntry>();
let loaded = false;
let loading: Promise<void> | null = null;

export function ensureEnforcementReady(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    try {
      const stored = await chrome.storage.session.get(SESSION_KEY);
      const raw = stored[SESSION_KEY] as Record<string, StoredEntry> | undefined;
      for (const [site, entry] of Object.entries(raw ?? {})) {
        if (isTier(entry?.tier)) {
          entries.set(site, {
            tier: entry.tier,
            tabIds: Array.isArray(entry.tabIds) ? entry.tabIds : [],
            since: typeof entry.since === "number" ? entry.since : Date.now(),
          });
        }
      }
    } catch {
      // Nothing enforced is the safe default: it under-blocks rather than leaving
      // a site cut off for a reason we can no longer name.
    }
    loaded = true;
    loading = null;
  })();
  return loading;
}

async function persist(): Promise<void> {
  const snapshot: Record<string, StoredEntry> = {};
  for (const [site, entry] of entries) snapshot[site] = entry;
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: snapshot });
  } catch {
    // Losing the mirror costs an explanation after a worker restart, not the
    // enforcement itself — the DNR rules are Chrome's to keep.
  }
}

/**
 * Publishes the rules the current decisions imply.
 *
 * Handed to `rules/session.ts` rather than installed directly, because the optimizer
 * publishes rules too and `updateSessionRules` replaces by id: two writers each
 * numbering from 1 would delete each other's work. Returns this source's rule count,
 * which is what a caller can meaningfully assert.
 */
async function syncRules(): Promise<number> {
  const list: EnforcementEntry[] = [...entries.entries()].map(([site, entry]) => ({
    site,
    tier: entry.tier,
    tabIds: entry.tabIds,
  }));
  const rules = enforcementRules(list);
  await publishRules(
    "limit",
    rules.map(({ id: _id, ...spec }) => spec as RuleSpec),
  );
  return rules.length;
}

export interface EnforcementView {
  site: string;
  tier: Tier;
  tabIds: number[];
  since: number;
}

/** Sets the tier for one site. `off` removes it. */
export async function setEnforcement(
  site: string,
  tier: Tier,
  tabIds: readonly number[],
): Promise<{ rules: number }> {
  await ensureEnforcementReady();
  if (tier === "off") {
    entries.delete(site);
  } else {
    const existing = entries.get(site);
    entries.set(site, {
      tier,
      tabIds: [...tabIds],
      since: existing && existing.tier === tier ? existing.since : Date.now(),
    });
  }
  const rules = await syncRules();
  await persist();
  return { rules };
}

/** Updates the tabs a site is showing in, without changing its tier. */
export async function refreshEnforcementTabs(
  tabIdsForSite: (site: string) => number[],
): Promise<void> {
  await ensureEnforcementReady();
  if (entries.size === 0) return;
  let changed = false;
  for (const [site, entry] of entries) {
    const next = tabIdsForSite(site);
    if (next.length === entry.tabIds.length && next.every((id, index) => id === entry.tabIds[index])) {
      continue;
    }
    entry.tabIds = next;
    changed = true;
  }
  if (!changed) return;
  await syncRules();
  await persist();
}

export function enforcementFor(site: string): Tier {
  return entries.get(site)?.tier ?? "off";
}

/**
 * Whether *this extension* is the reason a request was refused.
 *
 * `net::ERR_BLOCKED_BY_CLIENT` is what Chrome reports for any extension's block,
 * so an ad blocker's work would otherwise be credited here as bytes Byte Budget
 * saved. Checking the decision map first means the savings figure only ever counts
 * requests this extension actually refused.
 */
export function isEnforcedByUs(site: string, type: ResourceType | string): boolean {
  const entry = entries.get(site);
  if (!entry) return false;
  return tierBlocks(entry.tier, asResourceType(String(type)));
}

export function enforcementSnapshot(): EnforcementView[] {
  return [...entries.entries()].map(([site, entry]) => ({
    site,
    tier: entry.tier,
    tabIds: [...entry.tabIds],
    since: entry.since,
  }));
}

/** Drops every rule. Used when clearing data and by tests. */
export async function clearEnforcement(): Promise<void> {
  await ensureEnforcementReady();
  entries.clear();
  await syncRules();
  await persist();
}

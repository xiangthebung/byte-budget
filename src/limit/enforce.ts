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
 * doing needs to know what we are enforcing.
 *
 * Chrome does keep the DNR rules themselves alive across that teardown — but this
 * extension does not leave them alone. `rules/session.ts` owns the whole session set
 * and removes every rule it finds before installing the set it composes from module
 * memory, and module memory is empty in a fresh worker. So restoring the map is not
 * bookkeeping for the UI's benefit: it is what the rules are rebuilt from, and
 * `ensureEnforcementReady` republishes them before it resolves.
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
    /**
     * Restoring the map is only half of it. Chrome keeps session rules across a
     * worker teardown, but `rules/session.ts` composes the whole set from module
     * memory and `install()` removes every rule it finds before adding that set
     * back — so the first publish of a cold worker deletes the limit rules and, with
     * Data Saver shipping off, replaces them with nothing. The symptom is a site
     * parked at `strict` that stops being enforced after the first thirty-second
     * idle gap while every surface carries on saying it is limited, and it heals
     * only if that site's tab set happens to change.
     *
     * Inside the loading promise, not after it: awaiting readiness has to mean the
     * rules are back, not merely that the map is. Skipped when nothing is enforced,
     * which is the normal case and where the round trip would be pure cost —
     * `applyOptimize` reinstalls from an empty `limit` source anyway.
     */
    if (entries.size > 0) {
      try {
        await syncRules();
      } catch (error) {
        console.error("Byte Budget: could not republish the limit rules", error);
      }
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
  const previous = entries.get(site);
  if (tier === "off") {
    entries.delete(site);
  } else {
    entries.set(site, {
      tier,
      tabIds: [...tabIds],
      since: previous && previous.tier === tier ? previous.since : Date.now(),
    });
  }

  let rules: number;
  try {
    rules = await syncRules();
  } catch (error) {
    /**
     * The map is written before the install, so a rejected install leaves it
     * claiming a tier Chrome is not applying — and the governor's
     * `if (wanted === enforcementFor(site)) return` then never fires again for that
     * site, so the tier it thinks is installed is the one thing it will never try to
     * install. Rolling back keeps the two in step: Chrome applies a rule update
     * atomically, so a rejection means it still holds exactly what `previous`
     * describes.
     */
    if (previous) entries.set(site, previous);
    else entries.delete(site);
    // And republish from the rolled-back map. `publishRules` keeps the last set it
    // was handed whether or not it installed, so leaving the rejected one in place
    // would make the *optimizer's* next publish fail too, on rules nobody wants.
    try {
      await syncRules();
    } catch {
      // Both attempts failed, so the whole rule pipeline is down. The throw below is
      // what says so; a second log line would only be noise.
    }
    throw error;
  }

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

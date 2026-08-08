/**
 * Turning an enforcement decision into `declarativeNetRequest` rules.
 *
 * Pure, so the rules can be asserted in a test rather than only observed in a
 * browser. `enforce.ts` installs whatever comes out of here.
 *
 * Two conditions per site, and both of them name the site:
 *
 * 1. `tabIds` *and* `initiatorDomains` — requests the site's own documents make from
 *    a tab that is currently showing it. Tab scoping is what matches the extension's
 *    *attribution*: bytes are charged to the tab's top-level site, so enforcement has
 *    to be scoped the same way or the thing being limited is not the thing being
 *    counted.
 * 2. `initiatorDomains` alone — requests from the site's documents in tabs we have
 *    not associated yet. Covers the window between a navigation committing and the
 *    tab map catching up.
 *
 * They overlap harmlessly: two `block` rules matching the same request block it once.
 *
 * The domain condition on the first rule is load-bearing and was missing. Without it
 * that rule reads "everything this tab asks for", and the tab list is only re-scoped
 * after `onCommitted` and an IndexedDB write — so navigating away from a limited site
 * refused the *next* site's scripts and stylesheets for as long as that round trip
 * took, with no banner to explain it because the banner died with the old document.
 * `main_frame` is never blocked, so the symptom was the new page arriving unstyled
 * and inert and nothing anywhere saying why.
 *
 * The cost of the fix, stated because it is a real loss and not a free win: a
 * subresource requested from a cross-origin iframe on the limited site has the
 * *frame's* origin as its initiator, so neither rule matches it now — those bytes are
 * still counted against the budget and no longer refused. That makes the tab-scoped
 * rule a subset of the origin-scoped one; it is kept because the tab set is what
 * enforcement is keyed and re-scoped on, and because DNR has no condition for "the
 * tab's top-level site", which is the one thing that would let both properties hold
 * at once.
 *
 * One budget names no site: `ALL_SITES`, the limit over everything. Its rule carries
 * `resourceTypes` and nothing else, which Chrome accepts and reads as "every request",
 * so the same tier ladder applies globally with no second mechanism — and it is the
 * only shape that can reach the `#background` bucket, whose requests have no initiator
 * to scope against. Every other reserved key is still skipped.
 *
 * A total budget and a per-site budget can both be enforcing on the same request, and
 * they cannot contradict each other: every rule here is a `block` at one priority, and
 * DNR blocks a request that any block rule matches. So the effect is the union of the
 * two tiers' refused types — and because each tier's set is a prefix of the same shed
 * order, that union is exactly the stricter tier. Nothing here has to arbitrate. What
 * does have to be arbitrated is the *banner*, in `governor.ts`: two limits biting at
 * once must still produce one explanation, naming the one that is doing the cutting.
 */

import { ALL_SITES, type ResourceType } from "../core/types";
import { blockedTypes, type Tier } from "./tiers";

export interface EnforcementEntry {
  site: string;
  tier: Tier;
  /** Tabs currently showing this site. May be empty. */
  tabIds: number[];
}

/**
 * The shape `chrome.declarativeNetRequest.updateSessionRules` accepts, narrowed to
 * what is used here so the pure module does not depend on the chrome types.
 */
export interface SessionRule {
  id: number;
  priority: number;
  action: { type: "block" };
  condition: {
    resourceTypes: ResourceType[];
    initiatorDomains?: string[];
    tabIds?: number[];
  };
}

/**
 * Rule ids start here and are assigned in order.
 *
 * Only meaningful within this function's output: `rules/session.ts` renumbers the
 * whole set when it installs, because it composes rules from here *and* from the
 * optimizer and the two cannot both number from 1. Kept anyway so the shape returned
 * is a complete, assertable rule rather than half of one.
 */
export const FIRST_RULE_ID = 1;

/**
 * Priority for limit rules, above every optimizer rule.
 *
 * Chrome picks the highest-priority *matching* rule and only uses the action-type
 * ordering (allow > allowAllRequests > block > redirect/upgrade) to break a tie
 * within one priority. At the 1 this used to be, the optimizer's 2 won outright, so a
 * pack redirect beat a hard cap's block on the five pack CDNs and a site over 100%
 * kept spending bytes through them — refused everywhere else, quietly not refused on
 * exactly the hosts the optimizer knows how to rewrite. `tests/rules.test.mjs` pins
 * the gap against `optimizeRules` so it cannot close again silently.
 */
const PRIORITY = 3;

export function enforcementRules(entries: readonly EnforcementEntry[]): SessionRule[] {
  const rules: SessionRule[] = [];
  let id = FIRST_RULE_ID;

  for (const entry of entries) {
    const resourceTypes = blockedTypes(entry.tier);
    if (resourceTypes.length === 0 || !entry.site) continue;

    if (entry.site === ALL_SITES) {
      // No `initiatorDomains` and no `tabIds` on purpose: an unscoped condition is how
      // a limit reaches traffic that has no site of its own, which is the half of a
      // data plan a per-site rule can never see.
      rules.push({
        id: id++,
        priority: PRIORITY,
        action: { type: "block" },
        condition: { resourceTypes },
      });
      continue;
    }

    // Every other reserved key is a ledger bucket rather than a domain, and
    // `initiatorDomains: ["#background"]` is a condition Chrome rejects — which fails
    // the install atomically and takes every real site's rules down with it.
    if (entry.site.startsWith("#")) continue;

    if (entry.tabIds.length > 0) {
      rules.push({
        id: id++,
        priority: PRIORITY,
        action: { type: "block" },
        condition: {
          resourceTypes,
          initiatorDomains: [entry.site],
          tabIds: [...entry.tabIds],
        },
      });
    }

    rules.push({
      id: id++,
      priority: PRIORITY,
      action: { type: "block" },
      condition: { resourceTypes, initiatorDomains: [entry.site] },
    });
  }

  return rules;
}

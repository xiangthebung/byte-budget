/**
 * Turning an enforcement decision into `declarativeNetRequest` rules.
 *
 * Pure, so the rules can be asserted in a test rather than only observed in a
 * browser. `enforce.ts` installs whatever comes out of here.
 *
 * Two conditions per site, and the pair is the point:
 *
 * 1. `tabIds` — every request made by a tab that is currently showing the site.
 *    This is the one that matches the extension's *attribution*: bytes are charged
 *    to the tab's top-level site, so enforcement has to be scoped the same way or
 *    the thing being limited is not the thing being counted. It also reaches inside
 *    iframes, which an origin-based condition does not: a subresource in an
 *    embedded frame has the frame's origin as its initiator, not the page's.
 * 2. `initiatorDomains` — requests originating from the site's own documents, for
 *    tabs we have not associated yet. Covers the window between a navigation
 *    committing and the tab map catching up.
 *
 * Both are needed and they overlap harmlessly: two `block` rules matching the same
 * request block it once.
 */

import type { ResourceType } from "../core/types";
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

export function enforcementRules(entries: readonly EnforcementEntry[]): SessionRule[] {
  const rules: SessionRule[] = [];
  let id = FIRST_RULE_ID;

  for (const entry of entries) {
    const resourceTypes = blockedTypes(entry.tier);
    if (resourceTypes.length === 0 || !entry.site || entry.site.startsWith("#")) continue;

    if (entry.tabIds.length > 0) {
      rules.push({
        id: id++,
        priority: 1,
        action: { type: "block" },
        condition: { resourceTypes, tabIds: [...entry.tabIds] },
      });
    }

    rules.push({
      id: id++,
      priority: 1,
      action: { type: "block" },
      condition: { resourceTypes, initiatorDomains: [entry.site] },
    });
  }

  return rules;
}

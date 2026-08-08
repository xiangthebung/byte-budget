/**
 * The optimizer's network rules, synthesised from its settings.
 *
 * Pure, so the whole rule set can be asserted in a test. `apply.ts` publishes what
 * comes out of here.
 *
 * Every rule carries the same two exclusions, and both are load-bearing:
 *
 * - `excludedInitiatorDomains` for sites the person has opted out. An opt-out that
 *   only covered *some* of the optimizers would be a worse promise than none.
 * - `excludedTabIds` for holdout loads. A page load chosen as a control has to be
 *   genuinely unoptimized, or the comparison the savings figure rests on is between
 *   "optimized" and "slightly less optimized" and means nothing.
 */

import type { ResourceType } from "../core/types";
import type { RuleSpec } from "../rules/session";
import type { OptimizeSettings } from "./features";
import { PACKS } from "./packs";

/**
 * Priority for optimizer rules, below the limiter's.
 *
 * Chrome picks the highest-priority *matching* rule and only uses the action-type
 * ordering (allow > allowAllRequests > block > redirect/upgrade) to break a tie
 * within one priority — the reverse of what this comment used to claim. While the
 * limiter sat at 1 and this at 2, the redirect did not lose to the block, it won: a
 * site over a hard cap kept fetching images through the five pack CDNs. The limiter
 * is 3 now and the only property that matters here is that this number stays under
 * it, which `tests/rules.test.mjs` asserts.
 *
 * Every optimizer rule shares this one number on purpose. A `modifyHeaders` rule is
 * skipped when a higher-priority rule redirects the same request, so splitting the
 * packs and `Save-Data` across two priorities would drop the header from exactly the
 * images a pack rewrites.
 */
const PRIORITY = 2;

/** Every type a `Save-Data` header is worth attaching to. */
const DOCUMENT_TYPES: ResourceType[] = [
  "main_frame",
  "sub_frame",
  "image",
  "media",
  "script",
  "stylesheet",
  "xmlhttprequest",
];

const BEACON_TYPES: ResourceType[] = ["ping"];
const FONT_TYPES: ResourceType[] = ["font"];

export interface OptimizeContext {
  settings: OptimizeSettings;
  /** Tabs whose current load is a holdout, and must be left alone. */
  holdoutTabIds: readonly number[];
}

export function optimizeRules(context: OptimizeContext): RuleSpec[] {
  const { settings, holdoutTabIds } = context;
  if (!settings.enabled) return [];

  /**
   * Both domain exclusions, and both are needed.
   *
   * `excludedInitiatorDomains` covers subresources requested *by* the site's pages.
   * `excludedRequestDomains` covers requests *to* the site — including its own
   * documents, which have no initiator at all. Without the second one, an excluded
   * site still had `Save-Data` attached to its top-level navigation: the opt-out
   * covered every image on the page and not the page itself.
   */
  const shared = {
    ...(settings.exclusions.length > 0
      ? {
          excludedInitiatorDomains: [...settings.exclusions],
          excludedRequestDomains: [...settings.exclusions],
        }
      : {}),
    ...(holdoutTabIds.length > 0 ? { excludedTabIds: [...holdoutTabIds] } : {}),
  };

  const rules: RuleSpec[] = [];

  for (const pack of PACKS) {
    if (!settings.packs[pack.id]) continue;
    rules.push({
      priority: PRIORITY,
      action: { type: "redirect", redirect: { regexSubstitution: pack.regexSubstitution } },
      condition: {
        regexFilter: pack.regexFilter,
        resourceTypes: pack.resourceTypes as ResourceType[],
        ...shared,
      },
    });
  }

  if (settings.features.saveData) {
    rules.push({
      priority: PRIORITY,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "Save-Data", operation: "set", value: "on" }],
      },
      condition: { resourceTypes: DOCUMENT_TYPES, ...shared },
    });
  }

  if (settings.features.blockBeacons) {
    rules.push({
      priority: PRIORITY,
      action: { type: "block" },
      condition: { resourceTypes: BEACON_TYPES, ...shared },
    });
  }

  if (settings.features.systemFonts) {
    rules.push({
      priority: PRIORITY,
      action: { type: "block" },
      condition: { resourceTypes: FONT_TYPES, ...shared },
    });
  }

  return rules;
}

/** Resource types the optimizer refuses outright, for crediting a saving. */
export function refusedTypes(settings: OptimizeSettings): Set<ResourceType> {
  const types = new Set<ResourceType>();
  if (!settings.enabled) return types;
  if (settings.features.blockBeacons) for (const type of BEACON_TYPES) types.add(type);
  if (settings.features.systemFonts) for (const type of FONT_TYPES) types.add(type);
  return types;
}

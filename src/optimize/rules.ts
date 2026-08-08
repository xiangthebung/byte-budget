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

/**
 * The destinations the beacon block applies to, as registrable domains.
 *
 * `sendBeacon` is not an analytics API. It is also the standard way to flush unsaved
 * editor state on `pagehide`, to post a CSP violation or a JavaScript error report, and
 * to tell a server that a session ended — and all of those go to the site's own origin.
 * An unscoped block on `ping` took them with it, under a label that says "analytics" and
 * a description that says nothing on the page waits for them: true of the network wait,
 * false of the consequence. Losing a paragraph someone typed is not an invisible saving.
 *
 * Scoping by destination is what makes the label true. `requestDomains` covers
 * subdomains implicitly, so each entry is the registrable domain, and nothing here is a
 * host a page would post its own state to — error and crash reporters (Sentry, Bugsnag,
 * Rollbar) are deliberately absent for that reason. A destination not on this list keeps
 * its beacons, which is the failure direction that costs bytes rather than data.
 */
export const ANALYTICS_DOMAINS: readonly string[] = [
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "doubleclick.net",
  "scorecardresearch.com",
  "quantserve.com",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "amplitude.com",
  "heapanalytics.com",
  "hotjar.com",
  "fullstory.com",
  "mouseflow.com",
  "clarity.ms",
  "chartbeat.net",
  "statcounter.com",
  "matomo.cloud",
  "plausible.io",
];

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
        /**
         * Set, not defaulted. Chrome's default is `false`, and every JavaScript copy of
         * these patterns — `applyPack`, `packForUrl`, `packForRedirect`, `isRewritable`
         * — compiles without the `i` flag. Leaving it unset made Chrome match a strictly
         * larger set than the extension could recognise: `.../1600PX-Ex.JPG` was
         * rewritten by Chrome, attributed to no pack by `packForRedirect`, and its
         * original size never banked — a saving made and then not counted, with the two
         * engines' disagreement invisible to any test that runs only one of them.
         */
        isUrlFilterCaseSensitive: true,
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
      // `requestDomains` before `shared`, so an excluded site's `excludedRequestDomains`
      // still lands: a site on the never-optimize list must keep its beacons even when
      // they go to a listed analytics host.
      condition: {
        resourceTypes: BEACON_TYPES,
        requestDomains: [...ANALYTICS_DOMAINS],
        ...shared,
      },
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

/**
 * Resource types the optimizer refuses outright, for crediting a saving.
 *
 * Deliberately coarser than the rules since the beacon block was scoped by destination:
 * a `ping` refused to a host that is not in `ANALYTICS_DOMAINS` was refused by something
 * else — an ad blocker, or the page — and `isRefusedByOptimizer` will still credit it
 * here. Narrowing it needs the destination at the call site, which is the missing
 * site/host argument on `isRefusedByOptimizer` (AUDIT.md §3, "Any extension's block is
 * credited to Byte Budget"), not another set of resource types in this file.
 */
export function refusedTypes(settings: OptimizeSettings): Set<ResourceType> {
  const types = new Set<ResourceType>();
  if (!settings.enabled) return types;
  if (settings.features.blockBeacons) for (const type of BEACON_TYPES) types.add(type);
  if (settings.features.systemFonts) for (const type of FONT_TYPES) types.add(type);
  return types;
}

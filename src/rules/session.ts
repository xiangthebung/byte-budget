/**
 * The single owner of `declarativeNetRequest` session rules.
 *
 * Two subsystems want rules — limits refuse requests, optimizers rewrite them — and
 * `updateSessionRules` replaces by id, not by author. Two independent writers each
 * numbering from 1 and each removing "the existing rules" would delete each other's
 * work on every change, and the symptom would be a limit that stops enforcing as
 * soon as an optimizer setting is touched.
 *
 * So each side publishes its intent here and this composes the whole set, renumbers
 * it, and installs it in one call. Writes are serialised: `getSessionRules` followed
 * by `updateSessionRules` is a read-modify-write, and two of them interleaving would
 * lose rules.
 *
 * Ordering within the set matters and is fixed. Limits come first, and at equal
 * priority Chrome resolves `block` ahead of `redirect`, so a site that is over its
 * budget is refused rather than rewritten — which is the right answer: rewriting a
 * request that should not be sent at all still sends it.
 */

import type { ResourceType } from "../core/types";

export type RuleSource = "limit" | "optimize";

/** The order sources are laid out in. Earlier sources get lower ids. */
const SOURCE_ORDER: readonly RuleSource[] = ["limit", "optimize"];

export interface RuleCondition {
  resourceTypes: ResourceType[];
  regexFilter?: string;
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  requestDomains?: string[];
  excludedRequestDomains?: string[];
  tabIds?: number[];
  excludedTabIds?: number[];
}

export type RuleAction =
  | { type: "block" }
  | { type: "redirect"; redirect: { regexSubstitution: string } }
  | {
      type: "modifyHeaders";
      requestHeaders: { header: string; operation: "set" | "remove"; value?: string }[];
    };

/** A rule without an id. Ids are assigned at install time. */
export interface RuleSpec {
  priority: number;
  action: RuleAction;
  condition: RuleCondition;
}

const bySource = new Map<RuleSource, RuleSpec[]>();
let chain: Promise<number> = Promise.resolve(0);

/**
 * Composes the full rule set and assigns ids.
 *
 * Exported and pure so the numbering can be asserted in a test without a browser.
 */
export function composeRules(
  sources: ReadonlyMap<RuleSource, readonly RuleSpec[]>,
): (RuleSpec & { id: number })[] {
  const composed: (RuleSpec & { id: number })[] = [];
  let id = 1;
  for (const source of SOURCE_ORDER) {
    for (const rule of sources.get(source) ?? []) composed.push({ ...rule, id: id++ });
  }
  return composed;
}

/** Replaces one source's rules and reinstalls the whole set. Returns the rule count. */
export function publishRules(
  source: RuleSource,
  rules: readonly RuleSpec[],
): Promise<number> {
  bySource.set(source, [...rules]);
  chain = chain.then(install, install);
  return chain;
}

async function install(): Promise<number> {
  const composed = composeRules(bySource);
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: existing.map((rule) => rule.id),
      ...(composed.length > 0
        ? { addRules: composed as unknown as chrome.declarativeNetRequest.Rule[] }
        : {}),
    });
  } catch (error) {
    // A rejected rule set means nothing is installed — Chrome applies the update
    // atomically — so this is the difference between "limits are off" and "limits are
    // off and you were not told".
    console.error("Byte Budget: could not install network rules", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
  return composed.length;
}

/** How many rules each source currently contributes, for the UI and for tests. */
export function ruleCounts(): Record<RuleSource, number> {
  return {
    limit: bySource.get("limit")?.length ?? 0,
    optimize: bySource.get("optimize")?.length ?? 0,
  };
}

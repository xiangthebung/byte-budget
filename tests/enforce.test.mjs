/**
 * Tests for the enforcement decision map and the shared session rule set.
 *
 * `tests/rules.test.mjs` proves the rules say what a tier means, and pins the priority
 * gap for one configuration. This file covers the two things that sit either side of
 * that: whether the rules ever reach Chrome, and whether the gap holds for every tier
 * and every optimizer configuration rather than the one pair that happened to be
 * checked.
 *
 * The defect behind the first half is the one that made every surface lie. `bySource`
 * is plain module state and `install()` removes every session rule Chrome holds before
 * adding back what it composes from that state — so a worker woken after a thirty
 * second idle gap composed nothing, deleted the limit rules, and installed nothing in
 * their place. Restoring the decision map from `chrome.storage.session` was never the
 * fix on its own: the map is what the rules are rebuilt *from*, so readiness has to
 * mean the rules are back, not merely that the map is.
 *
 * The defect behind the second half is that a rule which says the right thing is still
 * not applied if another rule outranks it. Chrome picks the highest-priority *matching*
 * rule and only uses the allow > block > redirect ordering to break a tie inside one
 * priority, so while limits sat at 1 and pack redirects at 2 a hard cap was overridden
 * on exactly the five CDNs the optimizer knows how to rewrite.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  clearEnforcement,
  enforcementFor,
  enforcementSnapshot,
  ensureEnforcementReady,
  isEnforcedByUs,
  refreshEnforcementTabs,
  setEnforcement,
} from "../src/limit/enforce.ts";
import { composeRules, ruleCounts } from "../src/rules/session.ts";
import { enforcementRules } from "../src/limit/rules.ts";
import { optimizeRules } from "../src/optimize/rules.ts";
import { defaultOptimizeSettings, FEATURE_IDS } from "../src/optimize/features.ts";
import { TIERS } from "../src/limit/tiers.ts";
import { ALL_SITES } from "../src/core/types.ts";

/**
 * A Chrome that actually holds the rules, so an assertion can be about its state
 * rather than about the count the extension believes it installed.
 *
 * `updates` is counted because the interesting failure is silence: a version that
 * restores the map and never publishes leaves a correct-looking `enforcementFor` above
 * a browser enforcing nothing, and only "was `updateSessionRules` called" tells them
 * apart.
 */
function stubChrome(storedEnforcement) {
  const session = storedEnforcement ? { enforcement: storedEnforcement } : {};
  const state = { installed: [], updates: 0, rejectUpdates: false, session };
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => (key in session ? { [key]: session[key] } : {}),
        set: async (patch) => {
          Object.assign(session, patch);
        },
      },
    },
    declarativeNetRequest: {
      getSessionRules: async () => state.installed.map((rule) => ({ ...rule })),
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
        state.updates += 1;
        if (state.rejectUpdates) {
          // Chrome applies a rule update atomically, so a rejection leaves the
          // previous set exactly where it was. A stub that half-applied would let a
          // broken rollback pass.
          throw new Error("Rule with id 1 does not have a valid condition.");
        }
        const remove = new Set(removeRuleIds);
        state.installed = state.installed
          .filter((rule) => !remove.has(rule.id))
          .concat(addRules.map((rule) => ({ ...rule })));
      },
    },
  };
  return state;
}

const chromeState = stubChrome({
  "example.com": { tier: "strict", tabIds: [4], since: 1_700_000_000_000 },
});

/* ------------------------------------------------------------------ *
 * Waking up
 * ------------------------------------------------------------------ */

test("a worker that wakes to a parked limit has republished it by the time it is ready", async () => {
  // Chrome holds nothing, which is the state a cold worker's first `applyOptimize()`
  // leaves it in: `install()` removed every session rule and composed zero from an
  // empty module map. The session mirror is all that is left of the decision.
  assert.deepEqual(chromeState.installed, []);

  await ensureEnforcementReady();

  assert.equal(enforcementFor("example.com"), "strict");
  assert.ok(chromeState.updates > 0, "readiness resolved without publishing anything");
  // Awaited inside the loading promise, not fired off beside it: if the publish were a
  // floating promise, Chrome would still be holding nothing at this line.
  assert.equal(chromeState.installed.length, 2, "a tab-scoped rule and an origin-scoped one");

  for (const rule of chromeState.installed) {
    assert.equal(rule.action.type, "block");
    assert.deepEqual(rule.condition.initiatorDomains, ["example.com"]);
    // `strict` is the only tier that refuses scripts. A map restored without its rules
    // reports the same tier and refuses nothing at all.
    assert.ok(rule.condition.resourceTypes.includes("script"), "strict is not being applied");
  }
  const byTab = chromeState.installed.find((rule) => rule.condition.tabIds);
  assert.deepEqual(byTab.condition.tabIds, [4], "the restored tab set did not reach the rule");
});

test("the session mirror carries the tier, the tabs and when it started", async () => {
  const snapshot = enforcementSnapshot();
  assert.equal(snapshot.length, 1);
  assert.deepEqual(snapshot[0], {
    site: "example.com",
    tier: "strict",
    tabIds: [4],
    // Restored rather than reset. `since` is what the banner and the limit card use to
    // say how long a site has been cut off; stamping it at wake time would reset the
    // explanation every thirty seconds.
    since: 1_700_000_000_000,
  });
});

test("re-scoping a site's tabs republishes, and an unchanged set does not", async () => {
  const before = chromeState.updates;
  await refreshEnforcementTabs((site) => (site === "example.com" ? [4] : []));
  assert.equal(chromeState.updates, before, "an identical tab set was published again");

  await refreshEnforcementTabs((site) => (site === "example.com" ? [4, 11] : []));
  assert.ok(chromeState.updates > before);
  const byTab = chromeState.installed.find((rule) => rule.condition.tabIds);
  assert.deepEqual(byTab.condition.tabIds, [4, 11]);
});

test("clearing enforcement takes the rules out of Chrome, not just out of the map", async () => {
  // The escape hatch from a site a limit has broken. Dropping the site from the map
  // while the `initiatorDomains` rule stays installed leaves it refused until the
  // browser restarts, with the Remove button reporting success.
  await clearEnforcement();
  assert.equal(enforcementFor("example.com"), "off");
  assert.deepEqual(chromeState.installed, []);
  assert.equal(ruleCounts().limit, 0);
});

/* ------------------------------------------------------------------ *
 * A rejected install
 * ------------------------------------------------------------------ */

test("a rejected install leaves neither the map nor the published set claiming the new tier", async () => {
  await clearEnforcement();
  await setEnforcement("a.example", "trim", [1]);
  const accepted = chromeState.installed.map((rule) => ({ ...rule }));
  const acceptedCount = ruleCounts().limit;

  // `install()` logs before it rethrows, so this test prints one "could not install
  // network rules" line. That line is the behaviour under test, not a broken run.
  chromeState.rejectUpdates = true;
  try {
    await assert.rejects(() => setEnforcement("a.example", "strict", [1]));
  } finally {
    chromeState.rejectUpdates = false;
  }

  // The map is written before the install, so without the rollback it claims a tier
  // Chrome is not applying — and the governor's `if (wanted === enforcementFor(site))`
  // then never fires again for that site, making the tier it believes is installed the
  // one tier it will never try to install.
  assert.equal(enforcementFor("a.example"), "trim");
  assert.deepEqual(chromeState.installed, accepted, "Chrome's set moved on a rejected update");
  // And the composed set is back to the accepted rules. `publishRules` keeps whatever
  // it was last handed whether or not the install landed, so a rejected set left in
  // place would fail the *optimizer's* next publish too, on rules nobody wants.
  assert.equal(ruleCounts().limit, acceptedCount);
});

test("a limit is only credited with the refusals its own tier makes", async () => {
  await clearEnforcement();
  await setEnforcement("a.example", "trim", [1]);
  // `net::ERR_BLOCKED_BY_CLIENT` is what Chrome reports for every extension's block,
  // so without the site test an ad blocker's work is banked as bytes a budget saved.
  assert.equal(isEnforcedByUs("a.example", "media"), true);
  assert.equal(isEnforcedByUs("a.example", "image"), false, "trim does not refuse images");
  assert.equal(isEnforcedByUs("b.example", "media"), false, "another site's block");
  await clearEnforcement();
});

/* ------------------------------------------------------------------ *
 * Composition, and what it cannot decide
 * ------------------------------------------------------------------ */

const spec = (priority, type) => ({
  priority,
  action: { type },
  condition: { resourceTypes: ["image"] },
});

test("ids are handed out contiguously from one, limits before optimizers", () => {
  const limit = [spec(3, "block"), spec(3, "block")];
  const optimize = [spec(2, "block")];
  // Inserted optimizer-first on purpose: the layout follows the fixed source order, not
  // whichever source happened to publish last. Two writers each numbering from 1 would
  // delete each other's rules on every change.
  const composed = composeRules(new Map([["optimize", optimize], ["limit", limit]]));

  assert.deepEqual(composed.map((rule) => rule.id), [1, 2, 3]);
  assert.deepEqual(composed.map((rule) => rule.priority), [3, 3, 2]);
});

test("composing copies the rules rather than numbering the caller's own", () => {
  const limit = [spec(3, "block")];
  const composed = composeRules(new Map([["limit", limit]]));
  assert.equal(composed[0].id, 1);
  // Each source hands over a set it may reuse — `enforcementRules` builds a fresh one,
  // `optimizeRules` does too, but `bySource` holds them between publishes. Stamping an
  // id onto the caller's object would leave stale ids in the retained set.
  assert.equal("id" in limit[0], false);
});

test("the priority gap holds for every tier and every optimizer configuration", () => {
  const defaults = defaultOptimizeSettings();
  const allFeatures = Object.fromEntries(FEATURE_IDS.map((id) => [id, true]));
  const onlySaveData = Object.fromEntries(
    FEATURE_IDS.map((id) => [id, id === "saveData"]),
  );
  const configurations = [
    { ...defaults, enabled: true },
    { ...defaults, enabled: true, features: allFeatures },
    { ...defaults, enabled: true, features: onlySaveData },
    { ...defaults, enabled: true, features: allFeatures, exclusions: ["skip.example"] },
  ];

  for (const tier of TIERS) {
    if (tier === "off") continue;
    const limit = enforcementRules([
      { site: "example.com", tier, tabIds: [3] },
      // The total budget's rule is unscoped, which is the one shape that can be
      // matched by the same request a pack redirect matches on any host at all.
      { site: ALL_SITES, tier, tabIds: [] },
    ]);
    assert.ok(limit.length > 0, `${tier} produced no rules`);
    const lowestLimit = Math.min(...limit.map((rule) => rule.priority));

    for (const settings of configurations) {
      const optimize = optimizeRules({ settings, holdoutTabIds: [] });
      assert.ok(optimize.length > 0, "the optimizer produced no rules to compare against");
      const highestOptimize = Math.max(...optimize.map((rule) => rule.priority));
      assert.ok(
        lowestLimit > highestOptimize,
        `${tier} rules at ${lowestLimit} do not outrank optimizer rules at ${highestOptimize}`,
      );
    }
  }
});

test("laying the two sources out in order is not what makes a limit win", () => {
  // The composed order is about ids and nothing else, and the file that does the
  // composing says so. Chrome compares `priority` first and only falls back to the
  // action-type ordering within one priority — so if the two sets ever shared a
  // priority, "limits are numbered first" would buy exactly nothing. The property has
  // to survive composition as a property of the numbers, which is what this asserts.
  const limit = enforcementRules([{ site: "example.com", tier: "strict", tabIds: [1] }]);
  const optimize = optimizeRules({
    settings: { ...defaultOptimizeSettings(), enabled: true },
    holdoutTabIds: [],
  });
  const composed = composeRules(new Map([["limit", limit], ["optimize", optimize]]));
  assert.equal(composed.length, limit.length + optimize.length);

  const limitPart = composed.slice(0, limit.length);
  const optimizePart = composed.slice(limit.length);
  assert.ok(
    Math.min(...limitPart.map((rule) => rule.priority)) >
      Math.max(...optimizePart.map((rule) => rule.priority)),
    "composition renumbered the rules and the gap did not survive it",
  );
  // The ids are the only thing composition decides, and they run in one sequence
  // across both sources so neither can delete the other's work.
  assert.deepEqual(
    composed.map((rule) => rule.id),
    composed.map((_rule, index) => index + 1),
  );
});

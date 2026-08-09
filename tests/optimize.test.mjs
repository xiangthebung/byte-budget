/**
 * Tests for the optimizer's rule synthesis, the holdout sampling, and the composition
 * of the shared session rule set.
 *
 * The two properties worth pinning hardest: an excluded site must be excluded from
 * *every* rule (an opt-out that only covered some optimizers is a worse promise than
 * none), and a holdout load must be excluded from every rule too (a control that is
 * slightly optimized makes the whole savings figure meaningless while still producing a
 * number).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultOptimizeSettings,
  featuresForLevel,
  levelOf,
  FEATURES,
  FEATURE_IDS,
  SAVER_LEVELS,
  SAVER_LEVEL_FEATURES,
  activePageFeatures,
  anyPageFeature,
  optimizes,
} from "../src/optimize/features.ts";
import { optimizeRules, refusedTypes } from "../src/optimize/rules.ts";
import { decideHoldout, noteVisitOutcome, holdoutStats } from "../src/optimize/holdout.ts";
import { composeRules } from "../src/rules/session.ts";

const on = (changes = {}) => ({ ...defaultOptimizeSettings(), enabled: true, ...changes });

test("nothing is installed while the master switch is off", () => {
  const settings = defaultOptimizeSettings();
  assert.equal(settings.enabled, false, "off by default: it changes what pages receive");
  assert.deepEqual(optimizeRules({ settings, holdoutTabIds: [] }), []);
  assert.equal(anyPageFeature(settings), false);
  assert.equal(refusedTypes(settings).size, 0);
});

test("each feature has a label, a description and a visibility", () => {
  assert.equal(FEATURES.length, FEATURE_IDS.length);
  for (const feature of FEATURES) {
    assert.ok(feature.label, `${feature.id} has no label`);
    assert.ok(feature.description, `${feature.id} has no description`);
    assert.ok(
      ["invisible", "subtle", "noticeable"].includes(feature.visibility),
      `${feature.id} has no visibility`,
    );
  }
  // The one with a visible result is the one that is off by default.
  const fonts = FEATURES.find((feature) => feature.id === "systemFonts");
  assert.equal(fonts.visibility, "noticeable");
  assert.equal(fonts.defaultOn, false);
});

test("an enabled optimizer installs a rule per pack plus its features", () => {
  const rules = optimizeRules({ settings: on(), holdoutTabIds: [] });
  assert.ok(rules.length > 0);

  const redirects = rules.filter((rule) => rule.action.type === "redirect");
  const headers = rules.filter((rule) => rule.action.type === "modifyHeaders");
  const blocks = rules.filter((rule) => rule.action.type === "block");

  assert.ok(redirects.length >= 4, `expected a redirect per pack, got ${redirects.length}`);
  assert.equal(headers.length, 1, "Save-Data is on by default");
  assert.equal(blocks.length, 1, "beacons are blocked by default, fonts are not");

  for (const rule of redirects) {
    assert.ok(rule.condition.regexFilter, "a redirect rule needs a pattern");
    assert.ok(rule.action.redirect.regexSubstitution);
  }
  assert.deepEqual(headers[0].action.requestHeaders, [
    { header: "Save-Data", operation: "set", value: "on" },
  ]);
});

test("an excluded site is excluded from every rule, not most of them", () => {
  const rules = optimizeRules({ settings: on({ exclusions: ["example.com"] }), holdoutTabIds: [] });
  for (const rule of rules) {
    assert.deepEqual(
      rule.condition.excludedInitiatorDomains,
      ["example.com"],
      `${rule.action.type} rule does not honour the exclusion`,
    );
  }
  assert.equal(optimizes(on({ exclusions: ["example.com"] }), "example.com"), false);
  assert.equal(optimizes(on(), "example.com"), true);
  // Reserved buckets are not sites and are never optimized.
  assert.equal(optimizes(on(), "#background"), false);
});

test("a holdout tab is excluded from every rule", () => {
  const rules = optimizeRules({ settings: on(), holdoutTabIds: [4, 9] });
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    assert.deepEqual(
      rule.condition.excludedTabIds,
      [4, 9],
      `${rule.action.type} rule would still optimize a control load`,
    );
  }
  // And no key at all when there is nothing to exclude, so the rules stay comparable.
  for (const rule of optimizeRules({ settings: on(), holdoutTabIds: [] })) {
    assert.equal(rule.condition.excludedTabIds, undefined);
  }
});

test("switching a pack off removes only its rule", () => {
  const base = optimizeRules({ settings: on(), holdoutTabIds: [] });
  const without = optimizeRules({
    settings: on({ packs: { ...defaultOptimizeSettings().packs, twimg: false } }),
    holdoutTabIds: [],
  });
  assert.equal(without.length, base.length - 1);
  assert.ok(!without.some((rule) => rule.condition.regexFilter?.includes("pbs.twimg.com")));
});

test("only the features that refuse a request are credited with a saving", () => {
  assert.deepEqual([...refusedTypes(on())], ["ping"]);
  const withFonts = on({ features: { ...defaultOptimizeSettings().features, systemFonts: true } });
  assert.deepEqual([...refusedTypes(withFonts)].sort(), ["font", "ping"]);
  // Save-Data changes a request, it does not prevent one, so it earns no credit here.
  const saveOnly = on({
    features: {
      ...defaultOptimizeSettings().features,
      blockBeacons: false,
      systemFonts: false,
    },
  });
  assert.equal(refusedTypes(saveOnly).size, 0);
});

test("the page script is only registered when a page feature is on", () => {
  assert.ok(activePageFeatures(on()).length > 0);
  const noPageFeatures = on({
    features: {
      ...defaultOptimizeSettings().features,
      trimSrcset: false,
      lazyOffscreen: false,
      tameMedia: false,
      dropHints: false,
    },
  });
  assert.deepEqual(activePageFeatures(noPageFeatures), []);
  assert.equal(anyPageFeature(noPageFeatures), false, "no features means no script on any page");
});

/* ------------------------------------------------------------------ *
 * The shared rule set
 * ------------------------------------------------------------------ */

test("limit rules are laid out before optimizer rules and ids are unique", () => {
  const limit = [{ priority: 1, action: { type: "block" }, condition: { resourceTypes: ["media"] } }];
  const optimize = optimizeRules({ settings: on(), holdoutTabIds: [] });
  const composed = composeRules(new Map([
    ["limit", limit],
    ["optimize", optimize],
  ]));

  assert.equal(composed.length, limit.length + optimize.length);
  const ids = composed.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate rule id");
  assert.ok(Math.min(...ids) >= 1, "declarativeNetRequest ids must be positive");
  // Limits first, so that at equal priority a block resolves ahead of a redirect: a
  // site over its budget should be refused, not rewritten.
  assert.equal(composed[0].priority, 1);
  assert.equal(composed[0].action.type, "block");
});

test("a source with nothing to say contributes nothing", () => {
  assert.deepEqual(composeRules(new Map()), []);
  assert.deepEqual(composeRules(new Map([["optimize", []]])), []);
});

/* ------------------------------------------------------------------ *
 * The holdout
 * ------------------------------------------------------------------ */

const never = () => 1;
const always = () => 0;

test("no holdout while optimization is off or the rate is zero", () => {
  assert.equal(decideHoldout("a.com", defaultOptimizeSettings()).hold, false);
  assert.equal(decideHoldout("a.com", on({ holdoutPercent: 0 })).hold, false);
  assert.equal(decideHoldout("a.com", on({ holdoutPercent: 0 })).reason, "off");
});

test("no holdout before there is anything to compare against", () => {
  // A control load with no optimized loads beside it costs someone a slow page for one
  // sample against none.
  const decision = decideHoldout("fresh.com", on(), new Date(), always);
  assert.equal(decision.hold, false);
  assert.equal(decision.reason, "too-few-optimized");
});

test("the bootstrap control is drawn from across the day, not always the first load", () => {
  const site = "sampled.example";
  for (let index = 0; index < 5; index++) noteVisitOutcome(site, true);
  assert.deepEqual(holdoutStats(site), { optimized: 5, control: 0 });

  // Below the minimum sample count the draw is "choose one of four uniformly from a
  // stream": a quarter at the first eligible load of the day, a third at the second, a
  // half at the third, certainty at the fourth. A coin under every threshold takes the
  // first load.
  const first = decideHoldout(site, on(), new Date(2026, 6, 31), always);
  assert.equal(first.hold, true);
  assert.equal(first.reason, "needs-control");
});

test("a control not drawn early is certain by the fourth load of the day", () => {
  // This is the property that replaced taking the first eligible load outright. That
  // version made a site's first three controls its first-of-day loads on three
  // different days -- cold HTTP cache, cold service worker, an authentication
  // bootstrap -- so the control arm was heavy for reasons the optimizer had nothing to
  // do with, and the comparison reported the shape of the day as a saving. Spreading
  // the draw costs a day or two longer to the first figure and buys a control group
  // that is comparable to the treatment group.
  const site = "spread.example";
  for (let index = 0; index < 5; index++) noteVisitOutcome(site, true);
  const today = new Date(2026, 6, 31);

  // 0.9 clears none of 1/4, 1/3 or 1/2, so the first three loads stay optimized.
  const late = () => 0.9;
  assert.equal(decideHoldout(site, on(), today, late).reason, "not-sampled");
  assert.equal(decideHoldout(site, on(), today, late).reason, "not-sampled");
  assert.equal(decideHoldout(site, on(), today, late).reason, "not-sampled");

  // The fourth is certain, which is what stops a site visited twice a day from never
  // producing a control at all -- the reason the deterministic version existed.
  const fourth = decideHoldout(site, on(), today, late);
  assert.equal(fourth.hold, true);
  assert.equal(fourth.reason, "needs-control");
});

test("once there are enough controls the configured rate takes over", () => {
  const site = "rate.example";
  for (let index = 0; index < 5; index++) noteVisitOutcome(site, true);

  // Three controls in, on different days, and the bootstrap stops applying.
  noteVisitOutcome(site, false, new Date(2026, 6, 20).getTime());
  noteVisitOutcome(site, false, new Date(2026, 6, 21).getTime());
  noteVisitOutcome(site, false, new Date(2026, 6, 22).getTime());
  assert.equal(decideHoldout(site, on(), new Date(2026, 6, 31), never).reason, "not-sampled");
  assert.equal(decideHoldout(site, on(), new Date(2026, 6, 31), always).reason, "sampled");
});

test("never twice in one day for the same site", () => {
  const site = "daily.example";
  for (let index = 0; index < 5; index++) noteVisitOutcome(site, true);
  const today = new Date(2026, 6, 31);
  noteVisitOutcome(site, false, today.getTime());

  const decision = decideHoldout(site, on(), today, always);
  assert.equal(decision.hold, false);
  assert.equal(decision.reason, "already-today");
  // Tomorrow is fair game again.
  assert.equal(decideHoldout(site, on(), new Date(2026, 7, 1), always).hold, true);
});

test("an excluded site is never used as a control", () => {
  const site = "excluded.example";
  for (let index = 0; index < 9; index++) noteVisitOutcome(site, true);
  const decision = decideHoldout(site, on({ exclusions: [site] }), new Date(), always);
  assert.equal(decision.hold, false);
  assert.equal(decision.reason, "excluded");
});

/* ------------------------------------------------------------------ *
 * The preset levels
 *
 * The settings page offers Light, Balanced and Maximum in place of eight checkboxes,
 * and the checkboxes are still there under Advanced. That only holds together if the
 * three levels are a ladder and if the page can tell which rung a stored feature set
 * is standing on — neither of which any one definition in `features.ts` states, because
 * all three are derived from fields on `FEATURES`.
 * ------------------------------------------------------------------ */

test("the levels are a ladder: each switches on everything the one below does", () => {
  const [light, balanced, maximum] = SAVER_LEVELS.map(
    (level) => new Set(SAVER_LEVEL_FEATURES[level]),
  );

  for (const id of light) {
    assert.ok(balanced.has(id), `Balanced drops ${id}, which Light switches on`);
  }
  for (const id of balanced) {
    assert.ok(maximum.has(id), `Maximum drops ${id}, which Balanced switches on`);
  }
  // Not just nested — actually distinct, or the picker offers three names for two
  // things and choosing between them changes nothing.
  assert.ok(light.size < balanced.size, "Light and Balanced are the same set");
  assert.ok(balanced.size < maximum.size, "Balanced and Maximum are the same set");
  assert.equal(maximum.size, FEATURE_IDS.length, "Maximum is not all of them");
});

test("Light is exactly the changes that are invisible on the page", () => {
  // The level's promise is the group heading's promise, so they cannot be two lists.
  assert.deepEqual(
    [...SAVER_LEVEL_FEATURES.light].sort(),
    FEATURES.filter((feature) => feature.visibility === "invisible")
      .map((feature) => feature.id)
      .sort(),
  );
});

test("a fresh install reads as Balanced rather than as Custom", () => {
  // If this drifts, every install that has never opened Advanced shows "Custom" and is
  // warned that choosing a level will replace a selection it never made.
  assert.equal(levelOf(defaultOptimizeSettings().features), "balanced");
});

test("every level round-trips through the features it sets", () => {
  for (const level of SAVER_LEVELS) {
    assert.equal(levelOf(featuresForLevel(level)), level);
  }
});

test("a set matching no level is Custom, and is not rounded to the nearest one", () => {
  const features = featuresForLevel("balanced");
  const [first] = SAVER_LEVEL_FEATURES.balanced;
  features[first] = false;
  assert.equal(levelOf(features), null);
  // The point of returning null: nothing here repairs the set. Someone who switched one
  // thing off under Advanced still has it switched off.
  assert.equal(features[first], false);
});

test("choosing a level switches features off as well as on", () => {
  const features = featuresForLevel("light");
  for (const id of FEATURE_IDS) {
    assert.equal(
      features[id],
      SAVER_LEVEL_FEATURES.light.includes(id),
      `${id} is not what Light says it is`,
    );
  }
});

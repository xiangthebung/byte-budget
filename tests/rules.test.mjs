/**
 * Tests for the enforcement tiers and the rules they turn into.
 *
 * These rules are the only part of the extension that *stops* something, so the
 * two properties worth pinning are what a tier refuses and what it must never
 * refuse. `main_frame` heads the second list: blocking a document gives Chrome's
 * own error page, which reads as a broken website rather than as a limit the person
 * set. `scripts/smoke.mjs` proves the rules actually take effect in a browser;
 * these prove they say what they mean.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  blockedTypes,
  isTier,
  TIERS,
  TIER_DESCRIPTIONS,
  TIER_LABELS,
  tierBlocks,
} from "../src/limit/tiers.ts";
import { enforcementRules, FIRST_RULE_ID } from "../src/limit/rules.ts";

test("off refuses nothing", () => {
  assert.deepEqual(blockedTypes("off"), []);
  assert.deepEqual(enforcementRules([{ site: "example.com", tier: "off", tabIds: [1] }]), []);
});

test("the tiers are a slope, each a superset of the last", () => {
  const off = blockedTypes("off");
  const trim = blockedTypes("trim");
  const lean = blockedTypes("lean");
  const strict = blockedTypes("strict");

  for (const [smaller, larger] of [
    [off, trim],
    [trim, lean],
    [lean, strict],
  ]) {
    for (const type of smaller) {
      assert.ok(larger.includes(type), `${type} is refused by a lower tier but not a higher one`);
    }
    assert.ok(larger.length > smaller.length, "each tier must refuse strictly more");
  }

  // The heaviest thing goes first, because that is the point of the ordering.
  assert.equal(trim[0], "media");
  assert.ok(lean.includes("image") && lean.includes("font"));
});

test("no tier ever refuses the document itself", () => {
  for (const tier of TIERS) {
    assert.ok(
      !blockedTypes(tier).includes("main_frame"),
      `tier "${tier}" would block main_frame, which shows Chrome's error page`,
    );
    assert.equal(tierBlocks(tier, "main_frame"), false);
  }
});

test("tierBlocks agrees with blockedTypes", () => {
  for (const tier of TIERS) {
    const expected = new Set(blockedTypes(tier));
    for (const type of ["media", "image", "font", "script", "main_frame", "other"]) {
      assert.equal(
        tierBlocks(tier, type),
        expected.has(type),
        `${tier} / ${type} disagrees between the two functions`,
      );
    }
  }
});

test("every tier has a label and a description", () => {
  for (const tier of TIERS) {
    assert.ok(TIER_LABELS[tier], `${tier} has no label`);
    assert.ok(TIER_DESCRIPTIONS[tier], `${tier} has no description`);
  }
  assert.equal(isTier("lean"), true);
  assert.equal(isTier("nonsense"), false);
  assert.equal(isTier(undefined), false);
});

test("a limited site gets both a tab-scoped and an origin-scoped rule", () => {
  const rules = enforcementRules([{ site: "example.com", tier: "trim", tabIds: [7, 9] }]);
  assert.equal(rules.length, 2);

  const byTab = rules.find((rule) => rule.condition.tabIds);
  const byOrigin = rules.find((rule) => rule.condition.initiatorDomains);

  // Tab-scoped, because bytes are attributed by tab: it is the only condition that
  // also reaches subresources inside an iframe, whose initiator is the frame.
  assert.deepEqual(byTab.condition.tabIds, [7, 9]);
  assert.deepEqual(byTab.condition.resourceTypes, ["media"]);
  assert.equal(byTab.action.type, "block");

  // Origin-scoped, for the window before a tab has been associated.
  assert.deepEqual(byOrigin.condition.initiatorDomains, ["example.com"]);
  assert.deepEqual(byOrigin.condition.resourceTypes, ["media"]);
});

test("a site with no open tab still gets its origin rule", () => {
  const rules = enforcementRules([{ site: "example.com", tier: "lean", tabIds: [] }]);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].condition.initiatorDomains, ["example.com"]);
  assert.equal(rules[0].condition.tabIds, undefined);
});

test("rule ids are unique and positive", () => {
  const rules = enforcementRules([
    { site: "a.com", tier: "trim", tabIds: [1] },
    { site: "b.com", tier: "lean", tabIds: [2, 3] },
    { site: "c.com", tier: "strict", tabIds: [] },
  ]);
  const ids = rules.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate rule id");
  assert.ok(Math.min(...ids) >= FIRST_RULE_ID, "rule ids must be positive");
  assert.equal(rules.length, 5, "2 + 2 + 1");
});

test("reserved buckets are never enforced", () => {
  // `#background` and `#extensions` are not websites and have no origin or tab to
  // scope a rule to; a rule built from one would match everything.
  assert.deepEqual(enforcementRules([{ site: "#background", tier: "strict", tabIds: [1] }]), []);
  assert.deepEqual(enforcementRules([{ site: "", tier: "strict", tabIds: [1] }]), []);
});

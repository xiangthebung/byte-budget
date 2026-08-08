/**
 * Tests for the total-keeping helpers in `src/core/types.ts`.
 *
 * `measuredShare` is the honesty mechanism: it is what the UI turns into "92%
 * measured", and every aggregate in the extension is built by repeatedly adding
 * deltas into a total. If addition dropped a field, or the share could read as a
 * confident 0% on an empty period, the disclosure would be worse than none.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  addTotals,
  addTypeBytes,
  asResourceType,
  emptyTotals,
  isReservedSite,
  measuredShare,
  RESOURCE_TYPES,
  RESOURCE_TYPE_LABELS,
  totalBytes,
} from "../src/core/types.ts";

test("adding totals carries every field", () => {
  const into = emptyTotals();
  const from = {
    down: 100,
    up: 20,
    requests: 1,
    estimatedDown: 40,
    cacheHits: 1,
    cacheAvoided: 500,
    saved: 7,
    blocked: 1,
  };
  addTotals(into, from);
  addTotals(into, from);

  // Every key of the shape must have doubled; a field added later and forgotten
  // here would silently stop accumulating.
  for (const key of Object.keys(from)) {
    assert.equal(into[key], from[key] * 2, `${key} did not accumulate`);
  }
  assert.equal(totalBytes(into), 240);
});

test("type breakdowns merge without losing a category", () => {
  const into = { image: 10 };
  addTypeBytes(into, { image: 5, script: 3 });
  assert.deepEqual(into, { image: 15, script: 3 });
  addTypeBytes(into, {});
  assert.deepEqual(into, { image: 15, script: 3 });
});

test("an empty period reads as fully measured, not as zero confidence", () => {
  assert.equal(measuredShare(emptyTotals()), 1);
});

test("the measured share is the part no estimate covered", () => {
  assert.equal(measuredShare({ ...emptyTotals(), down: 100, estimatedDown: 0 }), 1);
  assert.equal(measuredShare({ ...emptyTotals(), down: 100, estimatedDown: 25 }), 0.75);
  assert.equal(measuredShare({ ...emptyTotals(), down: 100, estimatedDown: 100 }), 0);
  // Clamped: a corrupt row must not produce a negative percentage in the UI.
  assert.equal(measuredShare({ ...emptyTotals(), down: 100, estimatedDown: 400 }), 0);
});

test("unknown resource types fold into other rather than creating a key", () => {
  assert.equal(asResourceType("image"), "image");
  assert.equal(asResourceType("webtransport"), "other", "a type Chrome added later");
  assert.equal(asResourceType(undefined), "other");
  assert.equal(asResourceType("csp_report"), "other");
});

test("every resource type has a label", () => {
  for (const type of RESOURCE_TYPES) {
    assert.ok(RESOURCE_TYPE_LABELS[type], `${type} has no label`);
  }
});

test("reserved site keys cannot collide with a hostname", () => {
  assert.equal(isReservedSite("#background"), true);
  assert.equal(isReservedSite("#extensions"), true);
  assert.equal(isReservedSite("example.com"), false);
});

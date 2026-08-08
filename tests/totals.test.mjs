/**
 * Tests for the total-keeping helpers in `src/core/types.ts`.
 *
 * `measuredShare` is the honesty mechanism: it is what the UI turns into "92%
 * measured", and every aggregate in the extension is built by repeatedly adding
 * deltas into a total. If addition dropped a field, or the share could read as a
 * confident 0% on an empty period, the disclosure would be worse than none.
 *
 * `visitReason` is the other one. It decides which page loads may be compared with
 * which, and the whole "measured saving" claim is that subtraction. A load put in the
 * wrong arm does not produce an error; it produces a number, which is worse.
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
  VISIT_REASONS,
  visitReason,
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

test("the two arms of the savings comparison are named apart from the rest", () => {
  // `savings.ts` counts `holdout` as the control and `optimized` as the treatment, by
  // name. Renaming or dropping either silently empties an arm, and an empty arm makes
  // `visitDelta` return null rather than fail — the figure just quietly stops existing.
  assert.ok(VISIT_REASONS.includes("optimized"));
  assert.ok(VISIT_REASONS.includes("holdout"));
  // The other three exist precisely so that "not optimized" cannot be read as a
  // control. They must stay distinct from both arms.
  for (const reason of ["disabled", "excluded", "unknown"]) {
    assert.ok(VISIT_REASONS.includes(reason), `${reason} is not a reason`);
    assert.notEqual(reason, "optimized");
    assert.notEqual(reason, "holdout");
  }
  assert.equal(new Set(VISIT_REASONS).size, VISIT_REASONS.length);
});

test("a visit written before the reason field existed joins neither arm", () => {
  // This is the defect the field was added for: every load recorded before Data Saver
  // was switched on carries `optimized: false`, and reading that as a control made the
  // first "measured" saving a before-versus-after-install figure.
  assert.equal(visitReason({ optimized: false }), "unknown");
  assert.notEqual(visitReason({ optimized: false }), "holdout");
  assert.notEqual(visitReason({ optimized: false }), "disabled");
});

test("a legacy optimized visit is still treatment", () => {
  // The old flag could only be true when the optimizers were on and the load was not a
  // holdout, so that direction is unambiguous and the rows stay usable without a
  // migration. Only the false case lost information.
  assert.equal(visitReason({ optimized: true }), "optimized");
});

test("an explicit reason wins over the flag beside it", () => {
  assert.equal(visitReason({ optimized: false, reason: "holdout" }), "holdout");
  assert.equal(visitReason({ optimized: false, reason: "excluded" }), "excluded");
  // A held-out load is deliberately unoptimized, so the flag disagreeing with the
  // reason is the normal case rather than a corrupt row.
  assert.equal(visitReason({ optimized: true, reason: "holdout" }), "holdout");
});

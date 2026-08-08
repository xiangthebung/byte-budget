/**
 * Tests for `decideAlert` in `src/limit/alerts.ts`.
 *
 * The dedupe rule is the whole of that module's correctness, and it is the part that
 * cannot be watched: getting it wrong means either three notifications arriving
 * together — which buries the one that matters and teaches someone to dismiss all of
 * them — or an alert that never comes back after a grant, which is silence at exactly
 * the point the extension exists for. Neither shows up in a browser inside a minute;
 * a monthly window takes a month to disagree with itself.
 *
 * `decideAlert` returns both halves on purpose: what to say now, and what the record
 * should contain afterwards. Feeding one call's `thresholds` into the next is what a
 * window actually is, so most of these read as a sequence rather than as a table.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ALERT_THRESHOLDS, decideAlert } from "../src/limit/alerts.ts";

const WINDOW = "2026-08-01";
const NEXT_WINDOW = "2026-09-01";

/** The record `run()` would have written after a decision, as it stores it. */
const record = (periodKey, thresholds) => ({ periodKey, thresholds });

test("a jump past several thresholds is one alert, at the highest one crossed", () => {
  // A single video takes someone from 40% to 105%. Three notifications arriving
  // together bury the one that matters, so the lower two are recorded as said without
  // being sent — which is also what stops them arriving later on their own.
  const quiet = decideAlert(0.4, undefined, WINDOW);
  assert.equal(quiet.announce, null);
  assert.deepEqual(quiet.thresholds, []);

  const crossed = decideAlert(1.05, record(WINDOW, quiet.thresholds), WINDOW);
  assert.equal(crossed.announce, 1);
  assert.deepEqual(crossed.thresholds, [0.75, 0.9, 1], "all three are recorded as said");
});

test("a window that has already spoken does not speak again", () => {
  // The share keeps climbing after the alert, because `used` only ever grows inside a
  // window. Every one of these is a poll that must produce nothing.
  let state = record(WINDOW, []);
  const first = decideAlert(0.8, state, WINDOW);
  assert.equal(first.announce, 0.75);
  state = record(WINDOW, first.thresholds);

  for (const share of [0.8, 0.81, 0.85, 0.89]) {
    const again = decideAlert(share, state, WINDOW);
    assert.equal(again.announce, null, `share ${share} spoke twice`);
    state = record(WINDOW, again.thresholds);
  }
});

test("each threshold is announced once as the window fills", () => {
  let state = record(WINDOW, []);
  const said = [];
  for (const share of [0.5, 0.75, 0.8, 0.9, 0.99, 1, 1.4]) {
    const decision = decideAlert(share, state, WINDOW);
    if (decision.announce !== null) said.push(decision.announce);
    state = record(WINDOW, decision.thresholds);
  }
  assert.deepEqual(said, [0.75, 0.9, 1], "three alerts, in order, no repeats");
});

test("a threshold fires at the threshold, not past it", () => {
  // `>=`, and it is worth pinning: a strict comparison would make the 100% alert — the
  // one that is a fact rather than a warning — depend on a rounding error in a byte
  // count divided by an allowance.
  for (const threshold of ALERT_THRESHOLDS) {
    assert.equal(decideAlert(threshold, undefined, WINDOW).announce, threshold, `at ${threshold}`);
    const under = decideAlert(threshold - 1e-9, undefined, WINDOW);
    assert.notEqual(under.announce, threshold, `just under ${threshold}`);
  }
});

test("a raised allowance re-arms the alerts it dropped below", () => {
  // The only thing that can lower a share inside a window is the allowance going up — a
  // grant, or an edited limit. After that the person really is under 75% again, and if
  // they climb back over they should hear about it. Forgetting to re-arm is how "+25 MB"
  // silently switches the alerts off for the rest of a month.
  let state = record(WINDOW, decideAlert(1.05, undefined, WINDOW).thresholds);
  assert.deepEqual(state.thresholds, [0.75, 0.9, 1]);

  const granted = decideAlert(0.6, state, WINDOW);
  assert.equal(granted.announce, null, "dropping below a threshold is not an alert");
  assert.deepEqual(granted.thresholds, [], "and the record forgets what it can no longer see");

  const climbing = decideAlert(0.78, record(WINDOW, granted.thresholds), WINDOW);
  assert.equal(climbing.announce, 0.75, "so crossing it again is heard");
});

test("a partial grant re-arms only the thresholds it cleared", () => {
  // The share lands between two thresholds, so 75% is still crossed and still said,
  // while 90% and 100% become sayable again. Re-announcing 75% here would be the
  // duplicate the record exists to prevent.
  const state = record(WINDOW, [0.75, 0.9, 1]);
  const after = decideAlert(0.8, state, WINDOW);
  assert.equal(after.announce, null);
  assert.deepEqual(after.thresholds, [0.75]);

  const climbing = decideAlert(0.95, record(WINDOW, after.thresholds), WINDOW);
  assert.equal(climbing.announce, 0.9);
  assert.deepEqual(climbing.thresholds, [0.75, 0.9]);
});

test("a new window starts from silence, whatever the last one said", () => {
  // The window key rolling over is the only thing that retires a record, and it has to
  // retire all of it: a monthly budget that kept September's record from August would
  // spend the whole month unable to warn anyone.
  const spent = record(WINDOW, [0.75, 0.9, 1]);
  const rolled = decideAlert(0.99, spent, NEXT_WINDOW);
  assert.equal(rolled.announce, 0.9, "the highest threshold the new window has crossed");
  assert.deepEqual(rolled.thresholds, [0.75, 0.9]);

  // And a window with nothing spent in it yet says nothing, rather than inheriting.
  const fresh = decideAlert(0.1, spent, NEXT_WINDOW);
  assert.equal(fresh.announce, null);
  assert.deepEqual(fresh.thresholds, []);
});

test("the recorded thresholds are always a prefix of the ladder", () => {
  // `run()` compares the stored set with the new one by length alone, which is only
  // sound while both are prefixes of `ALERT_THRESHOLDS`. If a decision could ever return
  // a gap — 75% and 100% without 90% — that comparison would call two different sets
  // equal and skip the write that stops an alert repeating.
  const histories = [
    undefined,
    record(WINDOW, []),
    record(WINDOW, [0.75]),
    record(WINDOW, [0.75, 0.9, 1]),
  ];
  for (const share of [0, 0.3, 0.74, 0.75, 0.89, 0.9, 0.99, 1, 2.5]) {
    for (const previous of histories) {
      const { thresholds } = decideAlert(share, previous, WINDOW);
      assert.deepEqual(
        thresholds,
        ALERT_THRESHOLDS.slice(0, thresholds.length),
        `share ${share} produced ${thresholds.join()}`,
      );
    }
  }
});

test("the ladder is ordered, so the highest crossed threshold is the last one", () => {
  // `decideAlert` takes `fresh[fresh.length - 1]` as the one to announce. That is the
  // highest only while the list ascends, and the list is exported, so this is the
  // assertion that keeps the two facts attached to each other.
  for (let index = 1; index < ALERT_THRESHOLDS.length; index++) {
    assert.ok(
      ALERT_THRESHOLDS[index] > ALERT_THRESHOLDS[index - 1],
      "thresholds must ascend or the wrong one is announced",
    );
  }
  assert.deepEqual([...ALERT_THRESHOLDS], [0.75, 0.9, 1], "and there are three of them");
});

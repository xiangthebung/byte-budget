/**
 * Tests for `src/track/reconcile.ts` — the queue of requests that finished without
 * saying how big they were.
 *
 * This module had no tests, and three of the defects found in review lived here or
 * were reachable through it. The reason it went uncovered is that it looks like
 * plumbing: it holds no arithmetic worth checking and its output goes straight into
 * the ledger. But it is the only place in the extension where a request can be
 * *dropped* rather than mis-priced, and a dropped request is invisible — the totals
 * are simply low, with nothing to notice.
 *
 * So the properties asserted here are the ones whose failure is silent:
 *
 * - nothing waits forever, and nothing is lost when the queue is torn down;
 * - a measurement beats an estimate, and an estimate is labelled as one;
 * - a request is committed exactly once;
 * - the cap is measured against requests still waiting, not against the ones
 *   already dealt with;
 * - sizes are header-inclusive on both commit paths, so no request is charged for
 *   its headers twice.
 *
 * The ledger and the size model are stubbed on their singletons rather than
 * injected. They are singletons in the source because the worker has exactly one of
 * each, and a seam for the tests' benefit would be a worse design than a two-line
 * stub here.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ledger } from "../src/track/ledger.ts";
import { sizeModel } from "../src/track/estimate.ts";
import {
  addPending,
  drainPending,
  expirePending,
  forgetTab,
  matchableUrl,
  pendingCount,
  settleTiming,
} from "../src/track/reconcile.ts";

/** Everything the queue handed to the ledger, in order. */
let committed = [];
/** Every size fed back into the estimator. */
let observed = [];

ledger.record = (entry) => {
  committed.push(entry);
};
// Reached from the sweep timer in the real worker; here it must not open a database.
ledger.flush = () => Promise.resolve();
sizeModel.observe = (host, type, bytes) => {
  observed.push({ host, type, bytes });
};

/**
 * The state under test is module-scoped, which is correct for the worker and means
 * each test has to leave the queue empty. `drainPending` also cancels the sweep
 * timer, without which Node would sit for eight seconds after the last test.
 */
function reset() {
  drainPending();
  committed = [];
  observed = [];
}

let nextId = 0;

function entryFor(overrides = {}) {
  nextId += 1;
  return {
    at: Date.now(),
    site: "example.com",
    host: "cdn.example.com",
    type: "script",
    tabId: 7,
    visitId: `visit-${nextId}`,
    down: 0,
    up: 0,
    estimatedDown: 0,
    fromCache: false,
    cacheAvoided: 0,
    saved: 0,
    savedMeasured: 0,
    blocked: false,
    rewritten: 0,
    ...overrides,
  };
}

/** Parks one request and hands back the entry, so a test can assert on it later. */
function park({ url = "https://cdn.example.com/app.js", headers = 300, estimate = 50_000, ...rest } = {}) {
  const entry = entryFor(rest);
  entry.down = headers;
  addPending(entry, url, headers, estimate);
  return entry;
}

test("a measured size replaces the estimate rather than adding to it", (t) => {
  t.after(reset);
  reset();

  const entry = park({ headers: 300, estimate: 50_000 });
  assert.equal(pendingCount(), 1);
  assert.equal(committed.length, 0, "parking a request must not count it yet");

  // `transferSize` already includes response headers, so it is the whole figure.
  assert.equal(settleTiming(7, "https://cdn.example.com/app.js", 41_820), true);
  assert.equal(pendingCount(), 0);
  assert.deepEqual(committed, [entry]);
  assert.equal(entry.down, 41_820);
  assert.equal(entry.estimatedDown, 0, "a measured request must not report an estimate");
  assert.deepEqual(observed, [{ host: "cdn.example.com", type: "script", bytes: 41_820 }]);
});

test("a request nobody measured is committed with the estimate, and says so", (t) => {
  t.after(reset);
  reset();

  const entry = park({ headers: 300, estimate: 50_000 });
  const parkedAt = entry.at;

  expirePending(parkedAt + 7999);
  assert.equal(pendingCount(), 1, "the wait is not over yet");

  expirePending(parkedAt + 8000);
  assert.deepEqual(committed, [entry]);
  // The estimate *replaces* the header bytes rather than being added to them. The
  // size model is trained on header-inclusive figures at both of its inputs —
  // `transferSize` below, and `headerDown + body` in `requests.ts` — so its output
  // is a whole wire size. Adding 300 back on top charged the same header block
  // twice on every estimated request.
  assert.equal(entry.down, 50_000, "header-inclusive, not headers plus a body estimate");
  assert.equal(
    entry.estimatedDown,
    50_000,
    "the estimated part has to be disclosed, or the measured-share figure lies",
  );
  // A guess is not an observation, and feeding it back would train the model on
  // its own output.
  assert.deepEqual(observed, []);
});

test("an estimate below the measured header block is floored, not shrunk", (t) => {
  t.after(reset);
  reset();

  // The headers are the one part of a parked request that was actually counted, and
  // a model mean can sit under them on a host that serves tiny bodies. Pricing the
  // request below what was watched crossing the wire is the under-report the
  // halving factor is deliberately pessimistic to avoid.
  const entry = park({ headers: 900, estimate: 200 });
  drainPending();

  assert.equal(entry.down, 900);
  // Reported as estimated in full, including the part that came from real headers:
  // over-stating the uncertainty by a few hundred bytes is the safe direction, and
  // the alternative is a request claiming a measurement it does not have.
  assert.equal(entry.estimatedDown, 900);
});

test("a clock that steps backwards does not park a request forever", (t) => {
  t.after(reset);
  reset();

  // The TTL is measured against `Date.now()`, which is wall clock: an NTP
  // correction, a manual change, or a laptop resuming with a stale RTC moves it
  // backwards. `now - at` then goes negative for every parked entry, the age test
  // is never true again, and the only things left that can drain the queue are a
  // tab closing, a teardown, and the cap — none of which is guaranteed to arrive
  // for a request parked as the last thing a page does.
  const entry = park({ headers: 300, estimate: 50_000 });
  const parkedAt = entry.at;

  expirePending(parkedAt + 5000);
  assert.equal(pendingCount(), 1, "five seconds is not the eight-second wait");

  // The clock jumps back an hour. The entry is five seconds old and must still be
  // five seconds old — the step is not a reason to commit it early either.
  expirePending(parkedAt - 3_600_000);
  assert.equal(pendingCount(), 1, "rebased, not expired");
  assert.equal(committed.length, 0);

  // Three more seconds on the new clock takes it past the TTL.
  expirePending(parkedAt - 3_600_000 + 3100);
  assert.deepEqual(committed, [entry], "aged from the new reading rather than stranded");
  assert.equal(pendingCount(), 0);
});

test("a settled request is never committed twice", (t) => {
  t.after(reset);
  reset();

  const entry = park();
  assert.equal(settleTiming(7, "https://cdn.example.com/app.js", 41_820), true);

  // A second report for the same URL — a repeat batch, or the same resource fetched
  // again by a page that has since gone away.
  assert.equal(settleTiming(7, "https://cdn.example.com/app.js", 999_999), false);
  expirePending(entry.at + 60_000);
  drainPending();

  assert.deepEqual(committed, [entry]);
  assert.equal(entry.down, 41_820, "the first measurement stands");
});

test("a timing report for another tab settles nothing", (t) => {
  t.after(reset);
  reset();

  park({ tabId: 7 });
  assert.equal(settleTiming(9, "https://cdn.example.com/app.js", 41_820), false);
  assert.equal(pendingCount(), 1);
  assert.equal(committed.length, 0);
});

test("the fragment is dropped before matching, because it is never sent", (t) => {
  t.after(reset);
  reset();

  assert.equal(matchableUrl("https://example.com/a?b=1#top"), "https://example.com/a?b=1");
  assert.equal(matchableUrl("https://example.com/a"), "https://example.com/a");

  park({ url: "https://example.com/doc#section" });
  assert.equal(settleTiming(7, "https://example.com/doc", 12_000), true);
  assert.equal(pendingCount(), 0);
});

test("the cap counts requests still waiting, not ones already dealt with", (t) => {
  t.after(reset);
  reset();

  // 600 is the cap. Park it full, then measure half of them: those are finished
  // business, and the queue has room again.
  for (let i = 0; i < 600; i++) park({ url: `https://cdn.example.com/${i}.js` });
  for (let i = 0; i < 300; i++) {
    assert.equal(settleTiming(7, `https://cdn.example.com/${i}.js`, 1000 + i), true);
  }
  assert.equal(pendingCount(), 300);
  assert.equal(committed.length, 300);

  park({ url: "https://cdn.example.com/late.js" });

  // Measured against `queue.length`, which still held the 300 committed entries,
  // this tripped the cap and then force-estimated 300 requests parked milliseconds
  // earlier — throwing away sizes that were still on their way and dropping the
  // disclosed accuracy figure for no reason to do with measurability.
  assert.equal(pendingCount(), 301);
  assert.equal(committed.length, 300, "nothing was force-estimated");
  assert.ok(
    committed.every((entry) => entry.estimatedDown === 0),
    "every committed request was measured",
  );
});

test("over the cap, the oldest requests are estimated rather than dropped", (t) => {
  t.after(reset);
  reset();

  for (let i = 0; i < 601; i++) {
    park({ url: `https://cdn.example.com/${i}.js`, estimate: 1000 + i });
  }

  assert.equal(committed.length, 300, "half the cap is shed");
  assert.equal(pendingCount(), 301);
  // Oldest first: the ones least likely to still be measurable.
  assert.deepEqual(
    committed.map((entry) => entry.estimatedDown),
    Array.from({ length: 300 }, (_, i) => 1000 + i),
  );
});

test("draining commits everything, however recently it was parked", (t) => {
  t.after(reset);
  reset();

  // The worker is torn down after thirty idle seconds and this queue is module
  // state, so a request parked as the last thing a page does had nothing to commit
  // it: the flush two seconds later is too early for the eight-second wait, and the
  // maintenance alarm wakes a *fresh* worker whose queue is empty. It was not
  // estimated, it was lost — and only for streamed responses, which are the ones an
  // estimate is least able to stand in for.
  const entries = [park(), park({ url: "https://cdn.example.com/b.js" })];
  drainPending();

  assert.equal(pendingCount(), 0);
  assert.deepEqual(committed, entries);
  assert.ok(
    committed.every((entry) => entry.estimatedDown > 0),
    "committed early, so honestly labelled as estimates",
  );
});

test("closing a tab charges what it left parked, and leaves other tabs alone", (t) => {
  t.after(reset);
  reset();

  const closing = park({ tabId: 7, estimate: 4000 });
  park({ tabId: 9, url: "https://cdn.example.com/other.js", estimate: 7000 });

  forgetTab(7);
  assert.deepEqual(committed, [closing]);
  assert.equal(closing.estimatedDown, 4000);
  assert.equal(pendingCount(), 1, "the other tab is still waiting for its size");

  // And the closed tab's entry is out of the index, so a late report cannot revive it.
  assert.equal(settleTiming(7, "https://cdn.example.com/app.js", 1234), false);
  assert.equal(committed.length, 1);
});

test("an entry carries the page load it belonged to, not the tab alone", (t) => {
  t.after(reset);
  reset();

  // The visit id is captured when the request is priced and travels with it, because
  // a chunked request is committed up to eight seconds later and the tab may have
  // navigated. Asserted here so the field cannot be quietly dropped: without it,
  // `ledger.record` credits whatever the tab is showing when the number arrives, and
  // the bytes land on the next page's row.
  const entry = park({ visitId: "visit-under-test" });
  drainPending();

  assert.equal(committed.length, 1);
  assert.equal(committed[0].visitId, "visit-under-test");
  assert.equal(committed[0].tabId, entry.tabId);
});

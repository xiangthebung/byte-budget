/**
 * Tests for the statistics behind the one figure this project stakes its case on.
 *
 * The savings report is allowed to say "measured" about exactly one thing: the
 * difference between page loads made with the optimizer on and page loads deliberately
 * made with it off. Everything about that subtraction can fail quietly. An arm filled
 * with the wrong rows still produces a number. A mean dragged by one autoplaying video
 * still produces a number. Noise printed without an interval still produces a number.
 * None of those fail a build, and all of them read to a user as a measurement.
 *
 * So the four properties pinned here are the four ways the figure stops being one:
 *
 * 1. `holdout` is the only control and `optimized` is the only treatment. The old test
 *    was the `optimized` boolean, which made a control out of every load from before
 *    Data Saver was switched on — so turning it on today produced a "measured" saving
 *    that was really a before-versus-after-install comparison.
 * 2. The means are trimmed, because page weights are heavy-tailed and a three-sample
 *    arm's raw mean is whichever outlier it happened to catch.
 * 3. There is a 95% interval, computed with a small-sample t rather than 1.96.
 * 4. A row whose interval covers zero is not shown at all.
 *
 * The visit rows are read through IndexedDB, which Node does not have, so this file
 * carries the smallest store that answers the two indexed reads `savings.ts` makes.
 * Stubbing the database rather than the module is deliberate: the arm selection lives
 * in the same function as the read, and a fake that replaced `visitDelta`'s input would
 * be testing a copy of the logic instead of the logic.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  isRefusedByOptimizer,
  isRewritable,
  visitDelta,
  visitDeltas,
} from "../src/optimize/savings.ts";
import { applyOptimize } from "../src/optimize/apply.ts";
import { setTabHoldout } from "../src/optimize/holdout.ts";
import { defaultOptimizeSettings } from "../src/optimize/features.ts";
import { PACKS } from "../src/optimize/packs.ts";

/* ------------------------------------------------------------------ *
 * The smallest IndexedDB that answers these two reads
 * ------------------------------------------------------------------ */

/** name -> { keyPath, rows: Map, indexes: Map(indexName -> keyPath) } */
const stores = new Map([
  [
    "visits",
    {
      keyPath: "id",
      rows: new Map(),
      indexes: new Map([
        ["bySiteStart", ["site", "startedAt"]],
        ["byStart", "startedAt"],
      ]),
    },
  ],
]);

/** IndexedDB key ordering, for the compound `[site, startedAt]` index as well. */
function compareKeys(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = Array.isArray(a) ? a : [a];
    const right = Array.isArray(b) ? b : [b];
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      if (index >= left.length) return -1;
      if (index >= right.length) return 1;
      const order = compareKeys(left[index], right[index]);
      if (order !== 0) return order;
    }
    return 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function inRange(range, key) {
  if (!range) return true;
  if (range.lower !== undefined) {
    const order = compareKeys(key, range.lower);
    if (order < 0 || (order === 0 && range.lowerOpen)) return false;
  }
  if (range.upper !== undefined) {
    const order = compareKeys(key, range.upper);
    if (order > 0 || (order === 0 && range.upperOpen)) return false;
  }
  return true;
}

globalThis.IDBKeyRange = {
  bound: (lower, upper, lowerOpen = false, upperOpen = false) => ({
    lower,
    upper,
    lowerOpen,
    upperOpen,
  }),
  lowerBound: (lower, lowerOpen = false) => ({ lower, lowerOpen, upperOpen: false }),
  upperBound: (upper, upperOpen = false) => ({ upper, upperOpen, lowerOpen: false }),
};

/**
 * Settles in a microtask, because `core/db.ts` attaches `onsuccess` on the line after
 * the call. A shim that resolved synchronously would never reach a handler.
 */
function request(compute) {
  const pending = { result: undefined, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => {
    try {
      pending.result = compute();
      pending.onsuccess?.();
    } catch (error) {
      pending.error = error;
      pending.onerror?.();
    }
  });
  return pending;
}

const keyFor = (row, keyPath) =>
  Array.isArray(keyPath) ? keyPath.map((part) => row[part]) : row[keyPath];

function storeApi(store) {
  const readIndex = (keyPath, query, count) =>
    request(() => {
      const matched = [...store.rows.values()]
        .map((row) => ({ row, key: keyFor(row, keyPath) }))
        .filter(({ key }) => inRange(query, key))
        .sort((a, b) => compareKeys(a.key, b.key))
        .map(({ row }) => row);
      return count === undefined || count === null ? matched : matched.slice(0, count);
    });

  return {
    get: (key) => request(() => store.rows.get(key)),
    getAll: (query, count) => readIndex(store.keyPath, query, count),
    count: () => request(() => store.rows.size),
    put: (value) => request(() => store.rows.set(keyFor(value, store.keyPath), value)),
    delete: (key) => request(() => store.rows.delete(key)),
    clear: () => request(() => store.rows.clear()),
    index: (name) => {
      const keyPath = store.indexes.get(name);
      if (!keyPath) throw new Error(`No index ${name} in the test store.`);
      return { getAll: (query, count) => readIndex(keyPath, query, count) };
    },
  };
}

const database = {
  objectStoreNames: { contains: (name) => stores.has(name) },
  createObjectStore(name, { keyPath }) {
    const store = { keyPath, rows: new Map(), indexes: new Map() };
    stores.set(name, store);
    return { createIndex: (indexName, path) => store.indexes.set(indexName, path) };
  },
  transaction: () => ({
    objectStore: (name) => storeApi(stores.get(name)),
    oncomplete: null,
    onerror: null,
    onabort: null,
  }),
  close() {},
};

globalThis.indexedDB = {
  open() {
    const pending = {
      result: database,
      error: null,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
    };
    queueMicrotask(() => {
      pending.onupgradeneeded?.({ oldVersion: 0 });
      pending.onsuccess?.();
    });
    return pending;
  },
};

globalThis.chrome = {
  declarativeNetRequest: {
    getSessionRules: async () => [],
    updateSessionRules: async () => {},
  },
  scripting: {
    getRegisteredContentScripts: async () => [],
    registerContentScripts: async () => {},
    updateContentScripts: async () => {},
    unregisterContentScripts: async () => {},
  },
  storage: { session: { get: async () => ({}), set: async () => {} } },
  tabs: { query: async () => [] },
  runtime: { getManifest: () => ({}) },
};

/* ------------------------------------------------------------------ *
 * Building visit rows
 * ------------------------------------------------------------------ */

let nextVisitId = 0;

/**
 * One finished page load, an hour or two ago so it lands inside the 30-day window.
 *
 * `reason` is passed through exactly as given — including `undefined`, which is what a
 * row written before the field existed looks like on disk. That case is the whole
 * point of two of the tests below, so it must not be defaulted here.
 */
function visit(site, reason, down, { finished = true, minutesAgo = 90 } = {}) {
  const startedAt = Date.now() - minutesAgo * 60_000;
  const row = {
    id: `visit-${nextVisitId++}`,
    site,
    origin: `https://${site}`,
    tabId: 1,
    startedAt,
    down,
    up: 0,
    requests: 12,
    optimized: reason === "optimized",
    saved: 0,
  };
  if (finished) row.endedAt = startedAt + 4000;
  if (reason !== undefined) row.reason = reason;
  return row;
}

function seed(rows) {
  const store = stores.get("visits");
  for (const row of rows) store.rows.set(row.id, row);
}

const repeat = (count, build) => Array.from({ length: count }, (_value, index) => build(index));

/* ------------------------------------------------------------------ *
 * Which URLs are worth a baseline
 * ------------------------------------------------------------------ */

const REWRITABLE_URLS = [
  "https://pbs.twimg.com/media/Gk3xQb2X0AA1abc?format=jpg&name=large",
  "https://res.cloudinary.com/demo/image/upload/v1234/folder/photo.jpg",
];

const NOT_REWRITABLE_URLS = [
  // A pack host, but a path no pack claims.
  "https://pbs.twimg.com/profile_images/1/abc_400x400.jpg",
  // The same media path on someone else's host.
  "https://example.com/media/Gk3xQb2X0AA1abc?format=jpg&name=large",
  // Scheme matters: every pack pattern is anchored to https, and so is the host gate.
  "http://pbs.twimg.com/media/Gk3xQb2X0AA1abc?format=jpg&name=large",
  // A variant already small enough that no pack would touch it.
  "https://pbs.twimg.com/media/Abc?format=jpg&name=small",
];

test("a URL a pack would rewrite is worth remembering the size of", () => {
  for (const url of REWRITABLE_URLS) assert.equal(isRewritable(url), true, url);
  for (const url of NOT_REWRITABLE_URLS) assert.equal(isRewritable(url), false, url);
});

test("the host gate in front of the patterns does not change any answer", () => {
  // `isRewritable` runs for every completed request in the browser, so it checks a
  // handful of `https://host/` prefixes before it runs any pattern. That is an
  // optimisation and must be invisible: a pack whose `hosts` did not cover what its
  // own `regexFilter` accepts would stop banking baselines for itself, with no error
  // and no symptom beyond savings that stay modelled forever.
  const patterns = PACKS.map((pack) => new RegExp(pack.regexFilter));
  for (const url of [...REWRITABLE_URLS, ...NOT_REWRITABLE_URLS]) {
    assert.equal(
      isRewritable(url),
      patterns.some((pattern) => pattern.test(url)),
      `the prefix gate disagrees with the patterns for ${url}`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * Who gets credited for a refusal
 * ------------------------------------------------------------------ */

test("a refusal is credited to nobody while Data Saver is off", async () => {
  await applyOptimize(defaultOptimizeSettings());
  assert.equal(isRefusedByOptimizer("example.com", "ping", 5), false);
});

test("a refusal is only the optimizer's where the optimizer has a rule", async () => {
  await applyOptimize({
    ...defaultOptimizeSettings(),
    enabled: true,
    exclusions: ["excluded.example"],
  });

  assert.equal(isRefusedByOptimizer("example.com", "ping", 5), true);

  // `net::ERR_BLOCKED_BY_CLIENT` is what Chrome reports for every extension's block,
  // so the type alone credited an ad blocker's work — and the limiter's — to Data
  // Saver. Its sibling at the same call site, `isEnforcedByUs`, has been site-scoped
  // all along; these are the two exclusions the rules themselves already carry.
  assert.equal(
    isRefusedByOptimizer("excluded.example", "ping", 5),
    false,
    "an excluded site has no optimizer rule, so no refusal on it can be ours",
  );

  setTabHoldout(9, true);
  assert.equal(
    isRefusedByOptimizer("example.com", "ping", 9),
    false,
    "crediting a control load would put treatment bytes in the control arm",
  );
  setTabHoldout(9, false);

  // A type no installed rule refuses, and a bucket that is not a site.
  assert.equal(isRefusedByOptimizer("example.com", "image", 5), false);
  assert.equal(isRefusedByOptimizer("#background", "ping", 5), false);
});

/* ------------------------------------------------------------------ *
 * The two arms
 * ------------------------------------------------------------------ */

test("only a held-out load is a control and only an optimized load is treatment", async () => {
  const site = "arms.example";
  seed([
    ...repeat(5, () => visit(site, "optimized", 1_000_000)),
    ...repeat(5, () => visit(site, "holdout", 2_000_000)),
    // Every kind of load that is not one of the two arms, at a weight that would be
    // impossible to miss in either mean if it leaked in.
    ...repeat(4, () => visit(site, "excluded", 9_000_000)),
    ...repeat(4, () => visit(site, "disabled", 9_000_000)),
    ...repeat(4, () => visit(site, undefined, 9_000_000)),
    // And an in-flight load, which is a partial figure rather than a light one.
    visit(site, "optimized", 9_000_000, { finished: false }),
  ]);

  const delta = await visitDelta(site);
  assert.ok(delta, "a site with five loads on each arm has a comparison");
  assert.equal(delta.optimizedCount, 5);
  assert.equal(delta.controlCount, 5);
  assert.equal(delta.optimizedMean, 1_000_000);
  assert.equal(delta.controlMean, 2_000_000);
  assert.equal(delta.savedPerVisit, 1_000_000);
  assert.equal(delta.savedTotal, 5_000_000);
});

test("loads recorded before the reason field existed join neither arm", async () => {
  const site = "premigration.example";
  seed([
    ...repeat(5, () => visit(site, "optimized", 1_000_000)),
    // Twelve heavy loads with no `reason` at all: exactly the rows on disk from before
    // Data Saver was switched on. Read as controls, they made the first "measured"
    // saving 4 MB a load — a before-versus-after-install figure with a byte count on it.
    ...repeat(12, () => visit(site, undefined, 5_000_000)),
  ]);

  assert.equal(
    await visitDelta(site),
    null,
    "twelve pre-migration rows were counted as a control group",
  );

  // Three real controls arrive, and only those three are the control arm.
  seed(repeat(3, () => visit(site, "holdout", 1_200_000)));
  const delta = await visitDelta(site);
  assert.ok(delta);
  assert.equal(delta.controlCount, 3);
  assert.equal(delta.controlMean, 1_200_000, "the pre-migration rows dragged the control mean");
  assert.equal(delta.savedPerVisit, 200_000);
});

test("a side with too few samples is not compared at all", async () => {
  const site = "sparse.example";
  seed([
    ...repeat(2, () => visit(site, "optimized", 1_000_000)),
    ...repeat(6, () => visit(site, "holdout", 3_000_000)),
  ]);
  assert.equal(await visitDelta(site), null);
});

/* ------------------------------------------------------------------ *
 * The statistics
 * ------------------------------------------------------------------ */

test("one heavy load does not become the average", async () => {
  const site = "trimmed.example";
  seed([
    ...repeat(4, () => visit(site, "optimized", 100)),
    // One autoplaying video, or one 50 MB ad creative.
    visit(site, "optimized", 50_000_000),
    ...repeat(5, () => visit(site, "holdout", 2_000_000)),
  ]);

  const delta = await visitDelta(site);
  assert.ok(delta);
  // The raw mean of that arm is 10,000,080, which would report the optimizer as making
  // the site eight megabytes a load *heavier* on the strength of one outlier.
  assert.equal(delta.optimizedMean, 100);
  assert.equal(delta.savedPerVisit, 1_999_900);
});

test("a difference the samples cannot tell apart from zero is not reported", async () => {
  const site = "noise.example";
  const optimized = [1000, 2000, 3000];
  const control = [1500, 2500, 3500];
  seed([
    ...optimized.map((bytes) => visit(site, "optimized", bytes)),
    ...control.map((bytes) => visit(site, "holdout", bytes)),
  ]);

  // The raw means differ by 500 bytes a load, and two raw means of a heavy-tailed
  // distribution always differ. A report that printed whatever came out would be
  // showing noise with a byte count attached, which is the move this project exists to
  // refuse — so the row is suppressed rather than shown with a caveat.
  assert.equal(await visitDelta(site), null);
});

test("a real difference comes with the interval that justifies it", async () => {
  const site = "clear.example";
  seed([
    ...[1000, 2000, 3000].map((bytes) => visit(site, "optimized", bytes)),
    ...[101_000, 102_000, 103_000].map((bytes) => visit(site, "holdout", bytes)),
  ]);

  const delta = await visitDelta(site);
  assert.ok(delta, "a 100 kB difference on identically shaped arms is not noise");
  assert.equal(delta.savedPerVisit, 100_000);
  assert.ok(delta.savedPerVisitSpread > 0, "a spread of zero would claim infinite precision");
  assert.ok(delta.savedPerVisitSpread < Math.abs(delta.savedPerVisit));

  // Both arms are three samples with a standard error squared of 1,000,000/3, so the
  // half-width is the critical value times sqrt(2,000,000/3). At the four degrees of
  // freedom Welch gives these arms that value is 2.776. A normal approximation would
  // use 1.96 and declare roughly a third of the noise significant — which on three
  // loads a side is most of what this report would ever be asked to judge.
  const multiplier = delta.savedPerVisitSpread / Math.sqrt(2_000_000 / 3);
  assert.ok(multiplier > 2.7 && multiplier < 2.85, `t multiplier was ${multiplier}`);
  assert.ok(multiplier > 1.96, "the interval was built from a normal approximation");
});

test("an optimizer that made a site heavier is reported, not hidden", async () => {
  const site = "backfired.example";
  seed([
    ...[101_000, 102_000, 103_000].map((bytes) => visit(site, "optimized", bytes)),
    ...[1000, 2000, 3000].map((bytes) => visit(site, "holdout", bytes)),
  ]);

  const delta = await visitDelta(site);
  assert.ok(delta, "a significant result was dropped for having the wrong sign");
  assert.equal(delta.savedPerVisit, -100_000);
  // Suppression is about the interval covering zero, never about the direction.
  // Hiding this case would make the measurement decorative.
  assert.ok(delta.savedTotal < 0);
});

test("the report ranks the sites it was asked about and no others", async () => {
  const small = "small.example";
  const large = "large.example";
  const unasked = "unasked.example";
  for (const [site, controlBytes] of [
    [small, 1_100_000],
    [large, 4_000_000],
    [unasked, 4_000_000],
  ]) {
    seed([
      ...repeat(5, () => visit(site, "optimized", 1_000_000)),
      ...repeat(5, () => visit(site, "holdout", controlBytes)),
    ]);
  }

  const deltas = await visitDeltas([small, large]);
  assert.deepEqual(
    deltas.map((delta) => delta.site),
    [large, small],
    "heaviest saving first",
  );
  assert.ok(!deltas.some((delta) => delta.site === unasked));
});

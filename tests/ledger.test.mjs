/**
 * Tests for retention pruning in `src/track/ledger.ts`.
 *
 * `pruneOldRows` is the only code in this extension that permanently destroys
 * something a person recorded. Everything else can be recomputed, re-measured or
 * simply waited out; a deleted day is gone. It also already shipped an off-by-one
 * once — the comment above `hourlyCutoff` is the record of it — and until now
 * nothing pinned either boundary, so the next one would ship the same way.
 *
 * The boundaries are asserted as "which rows are still there afterwards" rather than
 * as "which key range was constructed", because the range is the implementation and
 * the surviving rows are the promise. Both bounds are half-open in the source and the
 * whole question is which side of the bound the cutoff day lands on.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { installFakeChromeStorage, installFakeIndexedDb } from "./hooks.mjs";

// Before anything opens the database: `src/core/db.ts` caches its connection for the
// life of the module, so a fake installed later would be installed too late.
const database = installFakeIndexedDb();
installFakeChromeStorage();

const { getAll, put, STORES } = await import("../src/core/db.ts");
const { ledger, pruneOldRows } = await import("../src/track/ledger.ts");
const { addDays, dayKey, retentionCutoff, startOfDay } = await import("../src/core/period.ts");
const { RETENTION_OPTIONS } = await import("../src/core/types.ts");

const TODAY = dayKey();
const day = (offset) => addDays(TODAY, offset);

function usageRow(bucket, site = "example.com", down = 1000) {
  return {
    key: `${bucket}|${site}`,
    bucket,
    site,
    down,
    up: 0,
    requests: 1,
    estimatedDown: 0,
    cacheHits: 0,
    cacheAvoided: 0,
    saved: 0,
    savedMeasured: 0,
    blocked: 0,
    rewritten: 0,
    byType: {},
  };
}

function hostRow(bucket, site = "example.com", host = "cdn.example.com") {
  return {
    key: `${bucket}|${site}|${host}`,
    bucket,
    site,
    host,
    down: 1000,
    up: 0,
    requests: 1,
    blocked: 0,
    saved: 0,
  };
}

function visit(id, startedAt, site = "example.com") {
  return {
    id,
    site,
    origin: `https://${site}`,
    tabId: 1,
    startedAt,
    down: 1000,
    up: 0,
    requests: 1,
    optimized: false,
    reason: "unknown",
    saved: 0,
  };
}

async function seed({ daily = [], hourly = [], hosts = [], visits = [] }) {
  database.clear();
  for (const bucket of daily) await put(STORES.daily, usageRow(bucket));
  for (const bucket of hourly) await put(STORES.hourly, usageRow(bucket));
  for (const bucket of hosts) await put(STORES.hosts, hostRow(bucket));
  for (const row of visits) await put(STORES.visits, row);
}

const bucketsIn = async (store) => (await getAll(store)).map((row) => row.bucket).sort();
const idsIn = async () => (await getAll(STORES.visits)).map((row) => row.id).sort();

test("the cutoff day survives its own prune, and the day before it does not", async () => {
  // The bound is what turns a retention setting into a number of days. `retentionCutoff(30)`
  // returns `today - 29`, so "keep 30 days" only keeps 30 if the cutoff day itself is
  // kept — drop it and every retention option in the product is quietly one day short.
  const cutoff = day(-5);
  await seed({
    daily: [day(-7), day(-6), cutoff, day(-4), TODAY],
    hosts: [day(-6), cutoff, TODAY],
  });

  await pruneOldRows(cutoff, TODAY);

  assert.deepEqual(await bucketsIn(STORES.daily), [cutoff, day(-4), TODAY].sort());
  assert.deepEqual(await bucketsIn(STORES.hosts), [cutoff, TODAY].sort(), "hosts follow daily");
});

test("today is never deleted, at any retention setting", async () => {
  // The shortest window the UI offers is 30 days, but the argument is about the
  // function rather than about the menu: a cutoff equal to today is the tightest
  // input `retentionCutoff` can produce, and it must still leave today alone. A prune
  // that took today would delete the numbers the popup is displaying while someone
  // is looking at them.
  for (const retention of [1, ...RETENTION_OPTIONS.filter((days) => days > 0)]) {
    const cutoff = retentionCutoff(retention);
    await seed({ daily: [TODAY, day(-1)], hourly: [`${TODAY}T09`], visits: [visit("now", Date.now())] });

    await pruneOldRows(cutoff, TODAY);

    assert.ok(
      (await bucketsIn(STORES.daily)).includes(TODAY),
      `retention ${retention} deleted today (cutoff ${cutoff})`,
    );
    assert.deepEqual(await idsIn(), ["now"], `retention ${retention} deleted today's visit`);
  }
});

test("keeping everything still prunes the hourly rows", async () => {
  // `retentionCutoff(0)` is null — "keep forever" — and the hourly store is explicitly
  // not covered by that choice: it exists to answer "where did today go" and a year of
  // it would be twenty-four rows per site per day for a question nobody asks about last
  // March. So the null has to skip three deletes and perform one.
  assert.equal(retentionCutoff(0), null, "0 days means keep everything");
  await seed({
    daily: [day(-400), TODAY],
    hosts: [day(-400), TODAY],
    hourly: [`${day(-400)}T09`, `${TODAY}T09`],
    visits: [visit("ancient", startOfDay(day(-400)).getTime()), visit("now", Date.now())],
  });

  await pruneOldRows(null, TODAY);

  assert.deepEqual(await bucketsIn(STORES.daily), [day(-400), TODAY].sort());
  assert.deepEqual(await bucketsIn(STORES.hosts), [day(-400), TODAY].sort());
  assert.deepEqual(await idsIn(), ["ancient", "now"]);
  assert.deepEqual(await bucketsIn(STORES.hourly), [`${TODAY}T09`], "hourly is pruned regardless");
});

test("hourly rows cover three days counting today, and the third day starts at midnight", async () => {
  // The off-by-one the source comment records: bounding at `today - 3` kept four days'
  // worth while the constant and the README both said three. The first hour kept is
  // `today-2 at 00`, so both ends are pinned here — the last hour dropped and the first
  // hour kept are adjacent.
  await seed({
    hourly: [
      `${day(-3)}T23`,
      `${day(-2)}T00`,
      `${day(-2)}T23`,
      `${day(-1)}T12`,
      `${TODAY}T00`,
      `${TODAY}T15`,
    ],
  });

  await pruneOldRows(null, TODAY);

  assert.deepEqual(await bucketsIn(STORES.hourly), [
    `${day(-1)}T12`,
    `${day(-2)}T00`,
    `${day(-2)}T23`,
    `${TODAY}T00`,
    `${TODAY}T15`,
  ].sort());
  const kept = await bucketsIn(STORES.hourly);
  assert.ok(!kept.includes(`${day(-3)}T23`), "the last hour of the fourth day back is dropped");
  assert.equal(new Set(kept.map((bucket) => bucket.slice(0, 10))).size, 3, "three days, not four");
});

test("a page load is kept or dropped by the midnight its day starts at", async () => {
  // Visits are keyed by an epoch millisecond rather than by a day string, so they are
  // the one store where the daily bound has to be re-derived — and the derivation is
  // local midnight, not UTC. A visit at exactly midnight on the cutoff day belongs to
  // that day and stays; one millisecond earlier belongs to the day before and goes.
  const cutoff = day(-3);
  const midnight = startOfDay(cutoff).getTime();
  await seed({
    visits: [
      visit("just-before", midnight - 1),
      visit("at-midnight", midnight),
      visit("later-that-day", midnight + 3_600_000),
      visit("today", Date.now()),
    ],
  });

  await pruneOldRows(cutoff, TODAY);

  assert.deepEqual(await idsIn(), ["at-midnight", "later-that-day", "today"]);
});

test("a retention setting keeps the number of days it names", async () => {
  // The end-to-end statement the other assertions add up to, and the one a user could
  // check: "30 days" has to mean thirty distinct days on disk, with the oldest being
  // twenty-nine days ago. Reading it off the store rather than off the arithmetic is
  // what makes it a statement about the prune rather than about `retentionCutoff`.
  for (const retention of [30, 90]) {
    const days = [];
    for (let offset = 0; offset <= retention + 2; offset++) days.push(day(-offset));
    await seed({ daily: days });

    await pruneOldRows(retentionCutoff(retention), TODAY);

    const kept = await bucketsIn(STORES.daily);
    assert.equal(kept.length, retention, `retention ${retention} kept ${kept.length} days`);
    assert.equal(kept[0], day(-(retention - 1)), "oldest day kept");
    assert.equal(kept[kept.length - 1], TODAY, "newest day kept");
  }
});

test("pruning twice deletes no more than pruning once", async () => {
  // A prune runs on an alarm, so it runs again a minute later against rows it has
  // already considered. A boundary that moved by a row per pass would empty the store
  // over an afternoon, and nothing outside this file would notice until the history was
  // gone.
  const cutoff = day(-4);
  await seed({
    daily: [day(-6), cutoff, TODAY],
    hosts: [day(-6), cutoff, TODAY],
    hourly: [`${day(-6)}T10`, `${day(-1)}T10`, `${TODAY}T10`],
    visits: [visit("old", startOfDay(day(-6)).getTime()), visit("kept", startOfDay(cutoff).getTime())],
  });

  await pruneOldRows(cutoff, TODAY);
  const afterFirst = {
    daily: await bucketsIn(STORES.daily),
    hosts: await bucketsIn(STORES.hosts),
    hourly: await bucketsIn(STORES.hourly),
    visits: await idsIn(),
  };

  await pruneOldRows(cutoff, TODAY);

  assert.deepEqual(await bucketsIn(STORES.daily), afterFirst.daily);
  assert.deepEqual(await bucketsIn(STORES.hosts), afterFirst.hosts);
  assert.deepEqual(await bucketsIn(STORES.hourly), afterFirst.hourly);
  assert.deepEqual(await idsIn(), afterFirst.visits);
  assert.deepEqual(afterFirst.visits, ["kept"]);
});

/* ------------------------------------------------------------------ *
 * The session total is handed out as a copy
 * ------------------------------------------------------------------ */

/**
 * `sessionUsage()` used to return the ledger's own `sites` map.
 *
 * Every one of its callers happened to copy before mutating, so nothing was wrong —
 * which is exactly what makes it worth a test rather than a comment. The next caller
 * to write `addTotals(session.sites[site], delta)` would have added straight into the
 * live session total, and the result would have looked like traffic rather than like a
 * bug: no exception, no failed write, just a number that climbs faster than the
 * browser is actually transferring.
 *
 * Asserted as "a second read is unaffected by mutating the first" rather than by
 * checking object identity, because identity is the implementation and independence is
 * the promise. `byType` is asserted separately because a shallow copy passes the first
 * assertion and fails this one.
 */
function commit(site, down, type = "image") {
  return {
    site,
    host: site,
    type,
    at: Date.now(),
    down,
    up: 0,
    estimatedDown: 0,
    fromCache: false,
    cacheAvoided: 0,
    saved: 0,
    savedMeasured: 0,
    blocked: false,
    rewritten: 0,
    visitId: "v1",
  };
}

test("the session total is handed out as a copy, so a caller cannot mutate the ledger", async () => {
  database.clear();
  await ledger.resetSession();
  ledger.record(commit("example.com", 1000));

  const first = await ledger.sessionUsage();
  assert.equal(first.sites["example.com"].down, 1000);

  first.sites["example.com"].down += 500_000;

  const second = await ledger.sessionUsage();
  assert.equal(
    second.sites["example.com"].down,
    1000,
    "mutating the returned totals changed the ledger's own session count",
  );
});

test("the copy reaches byType, which a shallow spread would leave shared", async () => {
  database.clear();
  await ledger.resetSession();
  ledger.record(commit("example.com", 1000, "image"));

  const first = await ledger.sessionUsage();
  assert.equal(first.sites["example.com"].byType.image, 1000);

  first.sites["example.com"].byType.image += 500_000;
  first.sites["example.com"].byType.script = 42;

  const second = await ledger.sessionUsage();
  assert.equal(second.sites["example.com"].byType.image, 1000);
  assert.equal(second.sites["example.com"].byType.script, undefined);
});

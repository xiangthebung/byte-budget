/**
 * Tests for `src/track/stats.ts`, which computes every number the two surfaces show.
 *
 * It had no test of its own. The browser smoke test reaches it, but only ever through
 * `period: 'today'`, so the multi-day aggregation behind "7 days" and "30 days" and
 * the per-visit median on the site drill-down had never executed anywhere — including
 * the arithmetic that keeps `estimatedDown` travelling alongside `down`, which is what
 * lets every surface say how much of a total was measured rather than inferred.
 *
 * The export is here for the same reason from the other direction: it is load-bearing
 * in the README's argument that a number you cannot get out of an extension is a
 * number you have to take on faith, and only the CSV path was ever exercised. The
 * escaping was not, and `csvCell` is the only thing standing between a hostname
 * someone merely visited and a formula running in their spreadsheet.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { installFakeChromeStorage, installFakeIndexedDb } from "./hooks.mjs";

// Installed before the modules that use them are loaded: `src/core/db.ts` caches its
// connection for the life of the module, so a fake installed later would be too late.
installFakeChromeStorage();
const database = installFakeIndexedDb();

const { put, STORES } = await import("../src/core/db.ts");
const { dailySeries, exportData, overview, siteDetail } = await import("../src/track/stats.ts");
const { addDays, dayKey, startOfDay } = await import("../src/core/period.ts");
const { DEFAULT_SETTINGS } = await import("../src/core/types.ts");

const TODAY = dayKey();
const day = (offset) => addDays(TODAY, offset);

/** Rolling windows, so "week" is the trailing seven days and does not move with the calendar. */
const SETTINGS = { ...DEFAULT_SETTINGS, weekMode: "rolling", monthMode: "rolling" };

function usageRow(bucket, site, totals = {}) {
  return {
    key: `${bucket}|${site}`,
    bucket,
    site,
    down: 0,
    up: 0,
    requests: 0,
    estimatedDown: 0,
    cacheHits: 0,
    cacheAvoided: 0,
    saved: 0,
    savedMeasured: 0,
    blocked: 0,
    rewritten: 0,
    byType: {},
    ...totals,
  };
}

function visit(id, site, startedAt, down) {
  return {
    id,
    site,
    origin: `https://${site}`,
    tabId: 1,
    startedAt,
    endedAt: startedAt + 1000,
    down,
    up: 0,
    requests: 10,
    optimized: false,
    reason: "unknown",
    saved: 0,
  };
}

const noonOn = (dayOffset) => startOfDay(day(dayOffset)).getTime() + 12 * 3_600_000;

/* ------------------------------------------------------------------ *
 * Aggregation across days
 * ------------------------------------------------------------------ */

test("a multi-day period adds up every day inside it and none outside it", async () => {
  database.clear();
  // Two days inside the trailing week, one day beyond it, and a second site so the
  // per-site split has something to get wrong.
  await put(STORES.daily, usageRow(day(-6), "a.example", { down: 1000, up: 100, requests: 4 }));
  await put(STORES.daily, usageRow(day(-3), "a.example", { down: 2000, up: 200, requests: 6 }));
  await put(STORES.daily, usageRow(TODAY, "a.example", { down: 4000, up: 400, requests: 8 }));
  await put(STORES.daily, usageRow(day(-3), "b.example", { down: 500, up: 50, requests: 2 }));
  await put(STORES.daily, usageRow(day(-8), "a.example", { down: 9_000_000, up: 9, requests: 1 }));

  const payload = await overview("week", SETTINGS);

  assert.equal(payload.totals.down, 7500, "three days on a.example plus one on b.example");
  assert.equal(payload.totals.up, 750);
  assert.equal(payload.totals.requests, 20);
  assert.deepEqual(
    payload.sites.map((entry) => entry.site),
    ["a.example", "b.example"],
    "descending by total bytes",
  );
  assert.equal(payload.sites[0].totals.down, 7000);
  assert.equal(payload.sites[1].totals.down, 500);

  // The day beyond the window is not merely excluded from the total — it is the
  // previous window, which is the only thing in the product that can say a budgeting
  // tool changed anything.
  assert.equal(payload.previousTotals.down, 9_000_000);
  assert.ok(payload.description.length > 0);
});

test("the estimated part of a total is carried across days with the total", async () => {
  database.clear();
  // The measured share is `1 - estimatedDown / down`, so these two have to aggregate
  // together or a week's worth of confidence is computed from one day's uncertainty.
  await put(STORES.daily, usageRow(day(-5), "a.example", { down: 1000, estimatedDown: 500 }));
  await put(STORES.daily, usageRow(day(-2), "a.example", { down: 3000, estimatedDown: 100 }));

  const payload = await overview("week", SETTINGS);

  assert.equal(payload.totals.down, 4000);
  assert.equal(payload.totals.estimatedDown, 600);
  assert.equal(payload.sites[0].totals.estimatedDown, 600, "and per site as well");
});

test("the type breakdown is summed across days rather than taken from the last one", async () => {
  database.clear();
  await put(
    STORES.daily,
    usageRow(day(-4), "a.example", { down: 300, byType: { image: 200, script: 100 } }),
  );
  await put(
    STORES.daily,
    usageRow(day(-1), "a.example", { down: 250, byType: { image: 50, media: 200 } }),
  );

  const payload = await overview("week", SETTINGS);

  assert.deepEqual(payload.byType, { image: 250, script: 100, media: 200 });
  assert.deepEqual(payload.sites[0].byType, { image: 250, script: 100, media: 200 });
});

test("the series has one point per day in the window, gaps included", async () => {
  database.clear();
  await put(STORES.daily, usageRow(day(-6), "a.example", { down: 10 }));
  await put(STORES.daily, usageRow(TODAY, "a.example", { down: 40 }));

  const payload = await overview("week", SETTINGS);

  assert.equal(payload.series.length, 7, "seven days, not two bars and a claim");
  assert.deepEqual(
    payload.series.map((point) => point.bucket),
    [day(-6), day(-5), day(-4), day(-3), day(-2), day(-1), TODAY],
  );
  assert.deepEqual(
    payload.series.map((point) => point.down),
    [10, 0, 0, 0, 0, 0, 40],
    "an empty day is a zero, not a missing bar",
  );
});

test("with no plan set the payload carries no projection", async () => {
  database.clear();
  await put(STORES.daily, usageRow(TODAY, "a.example", { down: 1000 }));

  const payload = await overview("week", SETTINGS);

  // The one modelled figure this payload can carry, and it is absent until someone has
  // answered the question it is a projection against. A zero here would be a forecast
  // nobody asked for, sitting beside measurements.
  assert.equal(payload.settings.planBytes, null);
  assert.equal(payload.projection, null);
});

test("a profile with nothing recorded reports zeroes rather than nothing", async () => {
  database.clear();

  const payload = await overview("week", SETTINGS);

  assert.equal(payload.totals.down, 0);
  assert.deepEqual(payload.sites, []);
  assert.deepEqual(payload.byType, {});
  assert.equal(payload.series.length, 7, "an empty week is still a week");
  assert.equal(payload.previousTotals.down, 0);
});

test("the dashboard series runs oldest first and ends today", async () => {
  database.clear();
  await put(STORES.daily, usageRow(day(-2), "a.example", { down: 20, saved: 5 }));
  await put(STORES.daily, usageRow(TODAY, "b.example", { down: 60 }));

  const series = await dailySeries(3);

  assert.deepEqual(
    series.map((point) => [point.bucket, point.down, point.saved]),
    [
      [day(-2), 20, 5],
      [day(-1), 0, 0],
      [TODAY, 60, 0],
    ],
  );
});

/* ------------------------------------------------------------------ *
 * The site drill-down
 * ------------------------------------------------------------------ */

test("the median page load is the middle one, and half the loads are lighter", async () => {
  database.clear();
  // Deliberately unsorted on the way in and deliberately skewed: one 4 MB load pulls the
  // mean well above the median, which is the entire reason the drill-down prints both.
  for (const [id, offset, down] of [
    ["v1", -5, 100_000],
    ["v2", -4, 4_000_000],
    ["v3", -3, 200_000],
    ["v4", -2, 150_000],
    ["v5", -1, 120_000],
  ]) {
    await put(STORES.visits, visit(id, "a.example", noonOn(offset), down));
  }
  // Another site's loads, and one from before the window, must not reach the figure.
  await put(STORES.visits, visit("other", "b.example", noonOn(-2), 9_000_000));
  await put(STORES.visits, visit("stale", "a.example", noonOn(-9), 9_000_000));

  const detail = await siteDetail("a.example", "week", SETTINGS);

  assert.equal(detail.visits.count, 5);
  assert.equal(detail.visits.medianDown, 150_000, "the third of five, by size");
  assert.equal(detail.visits.meanDown, 914_000, "and the mean the outlier drags up");
});

test("an even number of page loads takes the mean of the middle two", async () => {
  database.clear();
  for (const [id, offset, down] of [
    ["v1", -4, 100],
    ["v2", -3, 200],
    ["v3", -2, 300],
    ["v4", -1, 1000],
  ]) {
    await put(STORES.visits, visit(id, "a.example", noonOn(offset), down));
  }

  const detail = await siteDetail("a.example", "week", SETTINGS);

  assert.equal(detail.visits.count, 4);
  assert.equal(detail.visits.medianDown, 250);
  assert.equal(detail.visits.meanDown, 400);
});

test("a site with no page loads reports no median rather than a zero-byte one", async () => {
  database.clear();
  await put(STORES.daily, usageRow(TODAY, "a.example", { down: 1000 }));

  const detail = await siteDetail("a.example", "week", SETTINGS);

  assert.deepEqual(detail.visits, { count: 0, meanDown: 0, medianDown: 0 });
});

test("the host breakdown is empty when host tracking is switched off", async () => {
  database.clear();
  await put(STORES.daily, usageRow(TODAY, "a.example", { down: 1000 }));
  await put(STORES.hosts, {
    key: `${TODAY}|a.example|cdn.other.example`,
    bucket: TODAY,
    site: "a.example",
    host: "cdn.other.example",
    down: 700,
    up: 0,
    requests: 3,
    blocked: 0,
    saved: 0,
  });

  const on = await siteDetail("a.example", "week", SETTINGS);
  assert.equal(on.hosts.length, 1);
  assert.equal(on.hosts[0].host, "cdn.other.example");
  assert.equal(on.hosts[0].thirdParty, true);

  // The rows are still on disk from before the setting changed, and the query is what
  // has to honour it — otherwise switching per-host detail off would hide nothing that
  // had already been recorded, which is not what the Privacy panel says it does.
  const off = await siteDetail("a.example", "week", { ...SETTINGS, trackHosts: false });
  assert.deepEqual(off.hosts, []);
  assert.equal(off.totals.down, 1000, "the site total is unaffected");
});

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

/** Every cell of a CSV row, for rows with no embedded newline. */
function csvRow(body, index) {
  return body.split("\n")[index];
}

test("a hostname that would run as a formula is exported as text", async () => {
  database.clear();
  // Every prefix a spreadsheet treats as the start of a formula, including inside a
  // quoted field — which is why quoting is not the guard. The WHATWG URL parser accepts
  // `=` and `+` in an http host, so a page someone merely visited can plant this and the
  // export carries it into their spreadsheet.
  const hostile = {
    "=cmd|'/c calc'!A1": "'=cmd|'/c calc'!A1",
    "+1": "'+1",
    "-1": "'-1",
    "@sum": "'@sum",
    "\tx": "'\tx",
    "\rx": "'\rx",
  };
  for (const site of Object.keys(hostile)) {
    await put(STORES.daily, usageRow(TODAY, site, { down: 1000, requests: 1 }));
  }

  const { body } = await exportData("csv", 1);

  for (const [site, cell] of Object.entries(hostile)) {
    assert.ok(body.includes(`${TODAY},${cell},1000,`), `${JSON.stringify(site)} was not defused`);
  }
});

test("a carriage return is defused as a formula but not quoted as a field", async () => {
  database.clear();
  await put(STORES.daily, usageRow(TODAY, "\rx", { down: 1000, requests: 1 }));

  const { body } = await exportData("csv", 1);

  // This pins a disagreement rather than blessing it. `csvCell` names `\r` among the
  // prefixes it defuses and does defuse it — but its quote test is `/[",\n]/`, which has
  // no `\r`, so the cell leaves unquoted with a carriage return inside it. RFC 4180
  // parsers end a record on a bare CR, so this cell splits its row in two: a broken
  // export rather than a running formula, but still a malformed one.
  assert.ok(body.includes(`${TODAY},'\rx,1000,`), "defused, and unquoted");
  assert.ok(!body.includes(`${TODAY},"'\rx",1000,`), "the quote test does not cover \\r");

  // Left as a note rather than a failure because nothing can reach it today: the URL
  // parser strips tab, CR and LF out of a hostname before `siteKeyFromHost` sees one,
  // and `site` is the only untrusted text in the file. Closing it is one character in
  // the quote test here, plus the site-key allowlist the audit asks for separately.
  assert.equal(new URL("http://ex\rample.com/").hostname, "example.com");
});

test("a hostname that would break the format is quoted, and its quotes doubled", async () => {
  database.clear();
  const escaped = {
    "a,b": '"a,b"',
    'a"b': '"a""b"',
    "a\nb": '"a\nb"',
    // Both problems at once: the leading `=` is defused first and the result is then
    // quoted, so the apostrophe has to end up inside the quotes or it defuses nothing.
    '=a,"b': `"'=a,""b"`,
    "plain.example": "plain.example",
  };
  for (const site of Object.keys(escaped)) {
    await put(STORES.daily, usageRow(TODAY, site, { down: 1000, requests: 1 }));
  }

  const { body } = await exportData("csv", 1);

  for (const [site, cell] of Object.entries(escaped)) {
    assert.ok(body.includes(`${TODAY},${cell},1000,`), `${JSON.stringify(site)} was not escaped`);
  }
});

test("the CSV names its columns and rounds the modelled figures", async () => {
  database.clear();
  // `saved`, `estimatedDown` and `cacheAvoided` come out of a running mean, so they are
  // genuinely fractional on disk. `1234.5600000000002` in the one artefact anybody opens
  // reads as a broken tool whatever the number means.
  await put(
    STORES.daily,
    usageRow(TODAY, "a.example", {
      down: 100_000.4,
      up: 0,
      requests: 7,
      estimatedDown: 0.5,
      cacheHits: 2,
      cacheAvoided: 2.5,
      saved: 1234.5600000000002,
      blocked: 3,
    }),
  );

  const { body, filename, mimeType } = await exportData("csv", 1);

  assert.equal(
    csvRow(body, 0),
    "date,site,down_bytes,up_bytes,requests,estimated_down_bytes,cache_hits,cache_avoided_bytes,saved_bytes,blocked_requests",
  );
  assert.equal(csvRow(body, 1), `${TODAY},a.example,100000,0,7,1,2,3,1235,3`);
  assert.equal(filename, `byte-budget-${TODAY.replace(/-/g, "")}.csv`);
  assert.equal(mimeType, "text/csv");
});

test("the JSON export is the machine copy: exact values, no indentation", async () => {
  database.clear();
  await put(
    STORES.daily,
    usageRow(day(-1), "b.example", { down: 5, requests: 1, byType: { script: 5 } }),
  );
  await put(
    STORES.daily,
    usageRow(TODAY, "a.example", {
      down: 100_000.4,
      up: 12,
      requests: 7,
      estimatedDown: 0.5,
      cacheHits: 2,
      cacheAvoided: 2.5,
      saved: 1234.5600000000002,
      blocked: 3,
      byType: { image: 100_000.4 },
    }),
  );

  const { body, filename, mimeType } = await exportData("json", 2);
  const parsed = JSON.parse(body);

  assert.equal(filename, `byte-budget-${TODAY.replace(/-/g, "")}.json`);
  assert.equal(mimeType, "application/json");
  assert.deepEqual(Object.keys(parsed), ["generatedAt", "from", "to", "note", "rows"]);
  assert.equal(parsed.from, day(-1));
  assert.equal(parsed.to, TODAY);
  assert.ok(
    parsed.note.includes("estimated_down_bytes"),
    "the export has to say which part of a total nothing measured",
  );

  // Oldest first, because the rows are sorted by their `bucket|site` key.
  assert.deepEqual(
    parsed.rows.map((row) => [row.date, row.site]),
    [
      [day(-1), "b.example"],
      [TODAY, "a.example"],
    ],
  );
  assert.deepEqual(Object.keys(parsed.rows[1]), [
    "date",
    "site",
    "down",
    "up",
    "requests",
    "estimatedDown",
    "cacheHits",
    "cacheAvoided",
    "saved",
    "blocked",
    "byType",
  ]);
  // Unrounded, unlike the CSV, and deliberately: this is the copy a program reads, and
  // rounding it would make the two exports of the same ledger disagree with no way to
  // tell which one was adjusted.
  assert.equal(parsed.rows[1].saved, 1234.5600000000002);
  assert.equal(parsed.rows[1].estimatedDown, 0.5);
  assert.deepEqual(parsed.rows[1].byType, { image: 100_000.4 });

  // At four hundred days this is roughly forty thousand rows, and the pretty-printing
  // was the majority of a string that then gets structured-cloned across the message bus
  // and wrapped in a Blob.
  assert.ok(!body.includes("\n"), "the JSON export must not be indented");
});

test("an export of a profile with nothing in it is still a valid file", async () => {
  database.clear();

  const csv = await exportData("csv", 30);
  const json = await exportData("json", 30);

  assert.equal(csv.body.split("\n").length, 1, "the header and no rows");
  assert.deepEqual(JSON.parse(json.body).rows, []);
});

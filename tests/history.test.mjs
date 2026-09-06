/**
 * Tests for `src/track/history.ts`: the day the ledger started counting.
 *
 * A day the extension did not exist for is unknown, not zero, and the projection is
 * where the difference bites. What has to hold is that the date comes from somewhere
 * honest in every state a profile can be in — stored at install, derived from the
 * oldest row for a profile that predates the field, today for an empty one — and
 * that deleting everything moves it forward.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { installFakeChromeStorage, installFakeIndexedDb } from "./hooks.mjs";

const database = installFakeIndexedDb();
const storage = installFakeChromeStorage();

const { put, STORES } = await import("../src/core/db.ts");
const { markRecordingStart, recordingSince, resetRecordingSinceCache } = await import(
  "../src/track/history.ts"
);
const { addDays, dayKey } = await import("../src/core/period.ts");

const TODAY = dayKey();

function usageRow(bucket, site = "a.example") {
  return {
    key: `${bucket}|${site}`,
    bucket,
    site,
    down: 1,
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

async function reset() {
  database.clear();
  await storage.local.clear();
  resetRecordingSinceCache();
}

test("a stored install day is the answer", async () => {
  await reset();
  await markRecordingStart(addDays(TODAY, -12));
  resetRecordingSinceCache();
  assert.equal(await recordingSince(), addDays(TODAY, -12));
});

test("a profile from before the field existed is dated from its oldest row", async () => {
  await reset();
  await put(STORES.daily, usageRow(addDays(TODAY, -3), "b.example"));
  await put(STORES.daily, usageRow(addDays(TODAY, -40), "a.example"));
  await put(STORES.daily, usageRow(TODAY, "a.example"));
  assert.equal(await recordingSince(), addDays(TODAY, -40));
  // And written back, so the next worker does not have to derive it again.
  assert.equal(storage.local.raw("recordingSince"), addDays(TODAY, -40));
});

test("an empty profile has known nothing before today", async () => {
  await reset();
  assert.equal(await recordingSince(), TODAY);
});

test("deleting everything moves the date to today", async () => {
  await reset();
  await put(STORES.daily, usageRow(addDays(TODAY, -40)));
  assert.equal(await recordingSince(), addDays(TODAY, -40));
  // The rows are gone with the clear, and so is any claim to the days they covered.
  database.clear();
  await markRecordingStart();
  assert.equal(await recordingSince(), TODAY);
  resetRecordingSinceCache();
  assert.equal(await recordingSince(), TODAY, "and it is what was written, not what was cached");
});

test("a corrupt stored value falls through to the ledger rather than being trusted", async () => {
  await reset();
  storage.local.seed("recordingSince", "last tuesday");
  await put(STORES.daily, usageRow(addDays(TODAY, -5)));
  assert.equal(await recordingSince(), addDays(TODAY, -5));
});

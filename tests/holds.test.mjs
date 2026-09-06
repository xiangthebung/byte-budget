/**
 * Tests for `src/limit/holds.ts`: a tier on one site for a while, because someone
 * asked.
 *
 * Three things have to hold. A hold expires on its own and is never handed out after
 * its time — the difference between "pause this site for an hour" and "pause this
 * site until you remember". A second press restarts the hour rather than stacking
 * one. And the two tiers a hold may carry are the two the buttons offer; anything
 * else — a hold over `#all`, a `lean` hold, an `off` hold — is refused rather than
 * stored, because a stored shape nothing renders is a limit nobody can see or end.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { installFakeChromeStorage } from "./hooks.mjs";

const storage = installFakeChromeStorage();

const { clearHold, deeperTier, getHolds, HOLD_MINUTES, HOLD_TIERS, setHold } = await import(
  "../src/limit/holds.ts"
);
const { TIERS } = await import("../src/limit/tiers.ts");

const NOW = 1_800_000_000_000;

async function reset() {
  await storage.local.clear();
}

test("a hold lasts the hour the button promises, and no longer", async () => {
  await reset();
  await setHold("watch.example", "trim", HOLD_MINUTES, NOW);

  const inForce = await getHolds(NOW + HOLD_MINUTES * 60_000 - 1);
  assert.deepEqual(
    inForce.map((hold) => [hold.site, hold.tier, hold.until]),
    [["watch.example", "trim", NOW + HOLD_MINUTES * 60_000]],
  );
  assert.equal(inForce[0].since, NOW);

  assert.deepEqual(await getHolds(NOW + HOLD_MINUTES * 60_000), [], "gone on the minute");
});

test("pressing the button again restarts the hour rather than adding one", async () => {
  await reset();
  await setHold("watch.example", "trim", 60, NOW);
  await setHold("watch.example", "strict", 60, NOW + 30 * 60_000);
  const [hold] = await getHolds(NOW + 30 * 60_000);
  assert.equal(hold.tier, "strict", "the newer decision wins");
  assert.equal(hold.until, NOW + 90 * 60_000, "an hour from the second press, not two");
});

test("ending a hold leaves the others alone", async () => {
  await reset();
  await setHold("a.example", "trim", 60, NOW);
  await setHold("b.example", "strict", 60, NOW);
  await clearHold("a.example", NOW);
  assert.deepEqual((await getHolds(NOW)).map((hold) => hold.site), ["b.example"]);
  // Ending one that does not exist is not an error: the Resume button can race the
  // expiry, and a second press after that must not fail.
  await clearHold("a.example", NOW);
  assert.deepEqual((await getHolds(NOW)).map((hold) => hold.site), ["b.example"]);
});

test("only the two offered tiers can be held, and only real sites", async () => {
  await reset();
  assert.deepEqual([...HOLD_TIERS], ["trim", "strict"]);
  await assert.rejects(() => setHold("a.example", "lean", 60, NOW));
  await assert.rejects(() => setHold("a.example", "off", 60, NOW));
  await assert.rejects(() => setHold("#all", "trim", 60, NOW));
  await assert.rejects(() => setHold("#background", "strict", 60, NOW));
  await assert.rejects(() => setHold("", "trim", 60, NOW));
  assert.deepEqual(await getHolds(NOW), []);
});

test("a stored record from another build is read defensively", async () => {
  await reset();
  storage.local.seed("holds", {
    "ok.example": { tier: "trim", until: NOW + 1000 },
    "expired.example": { tier: "strict", until: NOW - 1 },
    "odd.example": { tier: "lean", until: NOW + 1000 },
    "#all": { tier: "strict", until: NOW + 1000 },
    "junk.example": { tier: "trim", until: "soon" },
  });
  const holds = await getHolds(NOW);
  assert.deepEqual(
    holds.map((hold) => [hold.site, hold.tier, hold.since]),
    [["ok.example", "trim", NOW]],
    "the record without a `since` is dated now rather than dropped",
  );
});

test("a budget and a hold on one site compose to the deeper tier", () => {
  // Every tier's refused set is a prefix of one shed order, so the deeper of the two
  // is a superset and there is nothing to arbitrate — the same argument the rules
  // make for a total and a per-site limit on one request.
  assert.equal(deeperTier("off", "trim"), "trim");
  assert.equal(deeperTier("lean", "trim"), "lean");
  assert.equal(deeperTier("trim", "strict"), "strict");
  assert.equal(deeperTier("strict", "strict"), "strict");
  for (const a of TIERS) {
    for (const b of TIERS) {
      assert.equal(deeperTier(a, b), deeperTier(b, a), `${a}/${b} is not symmetric`);
    }
  }
});

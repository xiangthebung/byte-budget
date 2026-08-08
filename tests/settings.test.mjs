/**
 * Tests for `normalize()` in `src/core/settings.ts`, through the two functions that
 * are the only way to reach it.
 *
 * This is the function that decides whether a preference someone set survives being
 * written down and read back. It used to spread the defaults and carry forward only
 * `theme` and `badge`, which meant `retentionDays` was permanently 400 and
 * `trackHosts` permanently on — controls the privacy policy described as theirs, that
 * the worker already honoured, and that only this function stood in the way of. That
 * was ship blocker 1, and nothing pinned the fix because the function is
 * module-private and needs `chrome.storage`.
 *
 * The other half of its job is the opposite of round-tripping: a value that arrived
 * from a newer build, from another device, or from a bad write has to fall back
 * rather than reach a formatter as `undefined` and print `NaN` where a byte count
 * belongs. So every assertion here is one of two claims — what a person saved comes
 * back, and what nobody could have saved does not.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { installFakeChromeStorage } from "./hooks.mjs";

const storage = installFakeChromeStorage();

const { getSettings, saveSettings } = await import("../src/core/settings.ts");
const { DEFAULT_SETTINGS, MAX_CYCLE_START_DAY, RETENTION_OPTIONS } = await import(
  "../src/core/types.ts"
);

/** Every field at a value that is not its default, so a dropped one is visible. */
const ALL_CHANGED = {
  theme: "dark",
  units: "iec",
  weekMode: "calendar",
  monthMode: "calendar",
  weekStart: 0,
  retentionDays: 30,
  badge: "today",
  trackHosts: false,
  planBytes: 15_000_000_000,
  cycleStartDay: 17,
};

async function reset() {
  await storage.sync.clear();
}

test("an empty profile reads as the complete defaults", async () => {
  await reset();
  assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
  // Every field named, so a field added to `Settings` and forgotten here shows up as a
  // missing key rather than as `undefined` two layers away in a formatter.
  assert.deepEqual(Object.keys(await getSettings()).sort(), Object.keys(DEFAULT_SETTINGS).sort());
});

test("every field a person can set comes back the way they set it", async () => {
  await reset();
  const saved = await saveSettings(ALL_CHANGED);
  assert.deepEqual(saved, ALL_CHANGED);
  assert.deepEqual(await getSettings(), ALL_CHANGED, "and again after a fresh read");
});

test("a retention choice survives the round trip", async () => {
  // The blocker, stated on its own because it is the one with a document attached:
  // PRIVACY_POLICY.md promises retention follows this setting. While `normalize` rebuilt
  // from the defaults it was permanently 400 for everyone, and the policy described a
  // control the build could not expose.
  await reset();
  for (const days of RETENTION_OPTIONS) {
    await saveSettings({ retentionDays: days });
    assert.equal((await getSettings()).retentionDays, days);
  }
  await saveSettings({ trackHosts: false });
  assert.equal((await getSettings()).trackHosts, false, "the other documented control");
});

test("saving one field does not quietly reset the rest", async () => {
  // `saveSettings` normalises the merge of what is stored with what changed, so a
  // normaliser that dropped a field would erase it on the next unrelated save — which
  // is how the original defect presented: nothing looked wrong at the moment of saving.
  await reset();
  await saveSettings(ALL_CHANGED);
  await saveSettings({ theme: "light" });
  assert.deepEqual(await getSettings(), { ...ALL_CHANGED, theme: "light" });
});

test("what is written to disk is already normalised", async () => {
  // So a value that failed validation cannot outlive the read that found it, and a
  // second reader that skipped `normalize` could not pick it back up.
  await reset();
  storage.sync.seed("settings", { theme: "chartreuse", retentionDays: 45, planBytes: -1 });
  const settings = await saveSettings({ badge: "session" });
  assert.deepEqual(storage.sync.raw("settings"), settings);
  assert.equal(settings.theme, DEFAULT_SETTINGS.theme);
  assert.equal(settings.retentionDays, DEFAULT_SETTINGS.retentionDays);
  assert.equal(settings.planBytes, null);
});

test("a value from a build we do not know falls back instead of throwing", async () => {
  await reset();
  storage.sync.seed("settings", {
    theme: "solarized",
    units: "imperial",
    weekMode: "lunar",
    monthMode: 7,
    weekStart: 2,
    retentionDays: 45,
    badge: true,
    trackHosts: "yes",
    planBytes: "15 GB",
    cycleStartDay: "the 17th",
  });
  assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);

  // And the shapes that are not merely wrong but structurally absent. `null` is what a
  // half-written sync record looks like, and it must not reach a formatter.
  storage.sync.seed("settings", null);
  assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
  storage.sync.seed("settings", {});
  assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
});

test("a retention value outside the menu is not honoured", async () => {
  // The menu is the contract: an arbitrary number would be a retention window no UI can
  // display and no user chose, and deleting data on a value nobody selected is the worst
  // direction for this particular field to be wrong in.
  await reset();
  for (const rejected of [45, -30, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    storage.sync.seed("settings", { retentionDays: rejected });
    assert.equal((await getSettings()).retentionDays, DEFAULT_SETTINGS.retentionDays, `${rejected}`);
  }
  // Zero is in the menu and means "keep everything", which is a real choice and not a
  // missing value — the distinction the whole fallback rests on.
  assert.ok(RETENTION_OPTIONS.includes(0));
  storage.sync.seed("settings", { retentionDays: 0 });
  assert.equal((await getSettings()).retentionDays, 0);
});

test("a plan of zero or less is no plan at all, never a plan of zero", async () => {
  // A plan of zero bytes is 100% spent before the first request, so it would put every
  // over-budget surface in the product into its worst state for someone whose only
  // mistake was clearing the field. `null` and `0` are different answers to different
  // questions and the difference is kept here rather than argued about at each call site.
  await reset();
  for (const empty of [0, -0, -1, -15_000_000_000, Number.NaN, Number.POSITIVE_INFINITY, "15", null]) {
    storage.sync.seed("settings", { planBytes: empty });
    assert.equal((await getSettings()).planBytes, null, `${String(empty)} is not a plan`);
  }

  storage.sync.seed("settings", { planBytes: 15_000_000_000 });
  assert.equal((await getSettings()).planBytes, 15_000_000_000);
  // Rounded, because the field is a byte count and a fractional byte reaches the
  // formatter as a long decimal on a surface whose argument is that it is precise.
  storage.sync.seed("settings", { planBytes: 1024.6 });
  assert.equal((await getSettings()).planBytes, 1025);
});

test("a cycle can start on any day up to the 28th, and no later", async () => {
  // 29, 30 and 31 are refused rather than clamped. Clamping would give a cycle that
  // resets on a different date in February than in March, and the reset date is the one
  // value here someone checks against a paper bill — a date that moves is worse than one
  // they can see is wrong and correct.
  await reset();
  assert.equal(MAX_CYCLE_START_DAY, 28);
  for (const day of [0, 1, 17, MAX_CYCLE_START_DAY]) {
    storage.sync.seed("settings", { cycleStartDay: day });
    assert.equal((await getSettings()).cycleStartDay, day);
  }
  for (const rejected of [29, 30, 31, -1, 1.5, "17", Number.NaN]) {
    storage.sync.seed("settings", { cycleStartDay: rejected });
    assert.equal(
      (await getSettings()).cycleStartDay,
      DEFAULT_SETTINGS.cycleStartDay,
      `${String(rejected)} is not a reset day`,
    );
  }
});

test("the week starts on a day of the week", async () => {
  // The only two values are Sunday and Monday, and the fallback matters because
  // `startOfWeek` uses this in modular arithmetic: a 2 would shift every weekly window
  // by a day without anything looking broken.
  await reset();
  for (const start of [0, 1]) {
    storage.sync.seed("settings", { weekStart: start });
    assert.equal((await getSettings()).weekStart, start);
  }
  for (const rejected of [2, -1, "1", true]) {
    storage.sync.seed("settings", { weekStart: rejected });
    assert.equal((await getSettings()).weekStart, DEFAULT_SETTINGS.weekStart, `${String(rejected)}`);
  }
});

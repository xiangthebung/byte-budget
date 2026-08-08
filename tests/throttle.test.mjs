/**
 * Tests for the download speed cap that only the throttle channel ships.
 *
 * Two defects lived in this file and both were invisible from the outside. The first
 * was arithmetic: `Network.emulateNetworkConditions` takes BYTES per second and the
 * setting is kilobits, so the factor is 1000/8. A missing divide-by-eight paces eight
 * times too fast, which is a cap that reports itself as working and never bites, and
 * nothing in a browser says so. The second was bookkeeping: the desired state was read
 * off the map of what Chrome was already doing, so with two budgeted sites each site's
 * pass treated the other's tabs as unwanted — an attach/detach cycle every sixty
 * seconds, flashing Chrome's un-suppressible debugging banner at someone who set a
 * speed limit and then touched nothing.
 *
 * Neither needs a browser to catch, which is the point of pinning them here.
 *
 * `__THROTTLE_BUILD__` is a Vite `define`, so in the store bundle it is the literal
 * `false` and every body below it is dropped. Under `node --test` it is an ordinary
 * global, which is what lets one file exercise both channels: the arithmetic is pure
 * and never reads it, and the diffing is reached by setting it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyThrottleToTabs,
  bytesPerSecond,
  clearAllThrottles,
  syncThrottle,
  throttleAvailable,
  throttledTabs,
} from "../src/limit/throttle.ts";

/* ------------------------------------------------------------------ *
 * The arithmetic, which needs no channel and no debugger
 * ------------------------------------------------------------------ */

test("a kilobit setting becomes bytes per second, not bits", () => {
  // 1 Mbps is 125 kB/s. The defect was the same expression without the /8, which
  // hands Chrome 1,000,000 B/s for a 1,000 kbps limit: a cap in name only, and one
  // that looks installed from every surface that reports it.
  assert.equal(bytesPerSecond(1000), 125_000);
  assert.notEqual(bytesPerSecond(1000), 1_000_000, "the divide-by-eight is missing");
  assert.equal(bytesPerSecond(1), 125);
  assert.equal(bytesPerSecond(3), 375);
});

test("the kilo is the carrier's thousand, not a kibibit", () => {
  // Every plan and speed test quotes SI kilobits, and the setting is labelled in them.
  // A 1024 factor is the silent kind of wrong: 2.4% slow, forever, with nothing to
  // notice it by.
  assert.equal(bytesPerSecond(8), 1000);
  assert.notEqual(bytesPerSecond(8), 1024, "1024/8 would be a kibibit reading");
});

test("a cap never rounds down to nothing", () => {
  // Zero bytes per second is offline, which is not what a speed limit means — and
  // `emulateNetworkConditions` would accept it without complaint.
  assert.equal(bytesPerSecond(0), 1);
  assert.equal(bytesPerSecond(0.001), 1);
  assert.equal(bytesPerSecond(-5), 1);
});

/* ------------------------------------------------------------------ *
 * The attach/detach diff, which needs both
 * ------------------------------------------------------------------ */

/** Everything the module asked Chrome to do, in order, plus the detach listeners. */
function stubDebugger() {
  const calls = [];
  const detachListeners = [];
  globalThis.chrome = {
    debugger: {
      onDetach: { addListener: (listener) => detachListeners.push(listener) },
      attach: async (target) => {
        calls.push({ kind: "attach", tabId: target.tabId });
      },
      detach: async (target) => {
        calls.push({ kind: "detach", tabId: target.tabId });
      },
      sendCommand: async (target, method, params) => {
        calls.push({ kind: "command", tabId: target.tabId, method, params });
      },
    },
  };
  return { calls, detachListeners };
}

const debug = stubDebugger();
globalThis.__THROTTLE_BUILD__ = true;

/** Fresh state for the next test: nothing paced, nothing recorded. */
async function reset() {
  await clearAllThrottles();
  debug.calls.length = 0;
}

const attaches = (calls) => calls.filter((call) => call.kind === "attach").map((call) => call.tabId);
const detaches = (calls) => calls.filter((call) => call.kind === "detach").map((call) => call.tabId);
const paced = (calls) =>
  calls.filter(
    (call) => call.kind === "command" && call.params?.downloadThroughput > 0,
  );

test("the store channel touches the debugger for nothing", async () => {
  globalThis.__THROTTLE_BUILD__ = false;
  try {
    assert.equal(throttleAvailable(), false);
    await applyThrottleToTabs("example.com", 500, [1, 2]);
    await syncThrottle(new Map([[3, { site: "other.example", kbps: 500 }]]));
    await clearAllThrottles();
    // Not "it did nothing useful" — it made no call at all. The install warning and
    // the debugging banner are the whole reason this channel is separate, and a call
    // that only fails at runtime would still have cost the permission.
    assert.deepEqual(debug.calls, []);
    assert.deepEqual(throttledTabs(), []);
  } finally {
    globalThis.__THROTTLE_BUILD__ = true;
  }
});

test("Chrome is handed the bytes-per-second figure, not the kilobits", async () => {
  await reset();
  await applyThrottleToTabs("example.com", 1000, [7]);

  const commands = paced(debug.calls);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].method, "Network.emulateNetworkConditions");
  assert.equal(commands[0].params.downloadThroughput, bytesPerSecond(1000));
  assert.equal(commands[0].params.downloadThroughput, 125_000);
  // A data cap expressed as a rate, not a simulation of a bad connection: added
  // latency would make pages feel broken for a reason nobody asked for.
  assert.equal(commands[0].params.latency, 0);
  assert.equal(commands[0].params.offline, false);
  assert.deepEqual(throttledTabs(), [7]);
});

test("two budgeted sites do not detach each other's tabs", async () => {
  await reset();
  // This is the sixty-second cycle, written out. Each call is one site's pass of a
  // `syncEnforcement` loop; the version that kept only the attached map saw the other
  // site's tab as unwanted on every one of them.
  await applyThrottleToTabs("a.example", 500, [1]);
  await applyThrottleToTabs("b.example", 500, [2]);
  await applyThrottleToTabs("a.example", 500, [1]);
  await applyThrottleToTabs("b.example", 500, [2]);

  assert.deepEqual(detaches(debug.calls), [], "a site's pass retracted another site's tab");
  assert.deepEqual(attaches(debug.calls), [1, 2], "each tab is attached once, not once per pass");
  assert.deepEqual(throttledTabs().sort((a, b) => a - b), [1, 2]);
});

test("a tab already paced at the right rate is left alone", async () => {
  await reset();
  await applyThrottleToTabs("a.example", 500, [1]);
  const first = paced(debug.calls).length;
  assert.equal(first, 1);

  await applyThrottleToTabs("a.example", 500, [1]);
  assert.equal(paced(debug.calls).length, first, "an unchanged rate was re-sent");

  // A changed rate is not the same case: it has to reach Chrome without a detach.
  await applyThrottleToTabs("a.example", 250, [1]);
  const commands = paced(debug.calls);
  assert.equal(commands.length, first + 1);
  assert.equal(commands.at(-1).params.downloadThroughput, bytesPerSecond(250));
  assert.deepEqual(detaches(debug.calls), []);
});

test("a site retracts only the tabs it claimed", async () => {
  await reset();
  await applyThrottleToTabs("a.example", 500, [1]);
  await applyThrottleToTabs("b.example", 500, [2]);
  debug.calls.length = 0;

  // Zero is a retraction, not a claim of no tabs — the distinction the per-site entry
  // point exists to make.
  await applyThrottleToTabs("a.example", null, []);
  assert.deepEqual(detaches(debug.calls), [1]);
  assert.deepEqual(throttledTabs(), [2], "the other site's cap came off with it");
});

test("the full-picture pass drops a tab no site wants any more", async () => {
  await reset();
  await syncThrottle(
    new Map([
      [1, { site: "a.example", kbps: 500 }],
      [2, { site: "b.example", kbps: 500 }],
    ]),
  );
  debug.calls.length = 0;

  // The difference from the per-site call: a caller holding every budget can tell
  // "no site wants this tab" from "the site that wanted it was not in this call".
  await syncThrottle(new Map([[1, { site: "a.example", kbps: 500 }]]));
  assert.deepEqual(detaches(debug.calls), [2]);
  assert.deepEqual(attaches(debug.calls), [], "the surviving tab was re-attached");
  assert.deepEqual(throttledTabs(), [1]);
});

test("a zero cap in the desired map is not a cap at all", async () => {
  await reset();
  await syncThrottle(new Map([[1, { site: "a.example", kbps: 0 }]]));
  assert.deepEqual(debug.calls, []);
  assert.deepEqual(throttledTabs(), []);
});

test("a tab taken by DevTools gets its cap back on the next pass", async () => {
  await reset();
  await applyThrottleToTabs("a.example", 500, [1]);
  assert.deepEqual(throttledTabs(), [1]);
  assert.ok(debug.detachListeners.length > 0, "nothing is watching for an external detach");

  // Opening DevTools on a paced tab detaches us. Without the listener the tab stays in
  // the attached map at its old rate, every later diff sees the cap as already applied
  // and sends nothing, and the tab runs uncapped for the rest of the session while the
  // UI carries on saying it is limited.
  for (const listener of debug.detachListeners) listener({ tabId: 1 }, "canceled_by_user");
  assert.deepEqual(throttledTabs(), [], "the external detach was not noticed");

  debug.calls.length = 0;
  await applyThrottleToTabs("a.example", 500, [1]);
  assert.deepEqual(attaches(debug.calls), [1]);
  assert.deepEqual(throttledTabs(), [1]);
});

test("a tab that cannot be attached keeps its claim for the next pass", async () => {
  await reset();
  const attach = globalThis.chrome.debugger.attach;
  globalThis.chrome.debugger.attach = async () => {
    throw new Error("Another debugger is already attached to the tab with id: 1.");
  };
  try {
    await applyThrottleToTabs("a.example", 500, [1]);
    assert.deepEqual(throttledTabs(), [], "a failed attach must not be recorded as a cap");
  } finally {
    globalThis.chrome.debugger.attach = attach;
  }

  // DevTools owning a tab is usually temporary, so the claim stays and the next pass
  // takes it — giving up for the session would silently drop the limit.
  debug.calls.length = 0;
  await applyThrottleToTabs("a.example", 500, [1]);
  assert.deepEqual(attaches(debug.calls), [1]);
  assert.deepEqual(throttledTabs(), [1]);
});

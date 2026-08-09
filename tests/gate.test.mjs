/** Completion-event checks for the subscription gate's delayed webhook path. */
import assert from "node:assert/strict";
import test from "node:test";
import { refreshPlusAfterProviderEvent } from "../src/plus/gate.ts";

function storageArea(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(key) {
      return key in values ? { [key]: values[key] } : {};
    },
    async set(entries) {
      Object.assign(values, entries);
    },
  };
}

test("a payment completion waits for the provider webhook instead of staying free", async () => {
  const local = storageArea({ "plus.providerKey": "account-key" });
  globalThis.chrome = {
    storage: {
      local,
      sync: storageArea(),
    },
  };

  let checks = 0;
  globalThis.fetch = async () => {
    checks++;
    return new Response(
      JSON.stringify(
        checks < 3
          ? { paid: false, paidAt: null, trialStartedAt: null, plan: null }
          : {
              paid: true,
              paidAt: "2026-08-09T00:00:00.000Z",
              trialStartedAt: null,
              subscriptionStatus: "active",
              plan: { interval: "month" },
            },
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const nativeSetTimeout = globalThis.setTimeout;
  let waits = 0;
  globalThis.setTimeout = (callback, delay) => {
    assert.equal(delay, 1_000);
    waits++;
    queueMicrotask(callback);
    return 0;
  };

  try {
    const status = await refreshPlusAfterProviderEvent("payment");
    assert.equal(status.reason, "paid");
    assert.equal(status.plus, true);
    assert.equal(checks, 3);
    assert.equal(waits, 2);
    assert.equal(local.values["plus.status"].reason, "paid");
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
  }
});

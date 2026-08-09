/** Privacy and persistence checks for the ExtensionPay protocol boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkProviderUser,
  openProviderPayment,
  openProviderTrial,
} from "../src/plus/provider.ts";

function storageArea(initial = {}) {
  const values = { ...initial };
  const removed = [];
  return {
    values,
    removed,
    async get(key) {
      if (Array.isArray(key)) {
        return Object.fromEntries(key.filter((name) => name in values).map((name) => [name, values[name]]));
      }
      return key in values ? { [key]: values[key] } : {};
    },
    async set(entries) {
      Object.assign(values, entries);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        removed.push(key);
        delete values[key];
      }
    },
  };
}

function installChrome({ local = {}, sync = {}, updateUrl = null } = {}) {
  const localArea = storageArea(local);
  const syncArea = storageArea(sync);
  const opened = [];
  globalThis.chrome = {
    runtime: {
      getManifest: () => (updateUrl ? { update_url: updateUrl } : {}),
    },
    storage: { local: localArea, sync: syncArea },
    tabs: {
      create: async ({ url }) => {
        opened.push(url);
        return {};
      },
    },
  };
  return { localArea, syncArea, opened };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("a never-connected free install makes no provider request", async () => {
  const state = installChrome();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json({ paid: false });
  };

  assert.deepEqual(await checkProviderUser(), {
    paid: false,
    paidAt: null,
    trialStartedAt: null,
    plan: null,
  });
  assert.equal(calls, 0);
  assert.deepEqual(state.syncArea.removed, [], "an empty profile does not spend a sync write");
});

test("a legacy synced key is migrated and the raw user cache is deleted", async () => {
  const state = installChrome({
    sync: {
      extensionpay_api_key: "legacy-key",
      extensionpay_user: { email: "person@example.com", paid: true },
    },
  });
  globalThis.fetch = async (input) => {
    assert.match(String(input), /api_key=legacy-key/);
    return json({
      paid: true,
      email: "person@example.com",
      paidAt: "2026-08-01T00:00:00.000Z",
      trialStartedAt: null,
      subscriptionStatus: "active",
      plan: { interval: "month", unitAmountCents: 99 },
    });
  };

  const user = await checkProviderUser();
  assert.equal(user.paid, true);
  assert.equal(user.paidAt?.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(user.plan?.interval, "month");
  assert.equal("email" in user, false, "the provider email does not leave the boundary");
  assert.deepEqual(state.localArea.values, { "plus.providerKey": "legacy-key" });
  assert.deepEqual(state.syncArea.values, {});
});

test("starting an account flow stores only the opaque key locally", async () => {
  const state = installChrome();
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    return json("new-key");
  };

  await openProviderTrial(14);
  assert.equal(requests.length, 1);
  assert.match(requests[0].input, /api\/new-key$/);
  assert.deepEqual(JSON.parse(requests[0].init.body), { development: true });
  assert.deepEqual(state.localArea.values, { "plus.providerKey": "new-key" });
  assert.equal(state.opened.length, 1);
  assert.match(state.opened[0], /\/trial\?/);
  assert.match(state.opened[0], /period=14-day/);
});

test("an existing key opens checkout without another registration request", async () => {
  const state = installChrome({ local: { "plus.providerKey": "known-key" } });
  globalThis.fetch = async () => {
    throw new Error("checkout should not register another key");
  };

  await openProviderPayment();
  assert.equal(state.opened.length, 1);
  assert.match(state.opened[0], /\/choose-plan\?api_key=known-key$/);
});

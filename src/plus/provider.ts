/**
 * The deliberately small ExtensionPay protocol client.
 *
 * The published `extpay` package stores the provider's entire user response in
 * `chrome.storage.sync`. That response can include an email address and subscription
 * details, even though Byte Budget only needs a boolean, dates and a plan interval.
 * Keeping the protocol here lets the extension retain only its opaque provider key and
 * its own reduced `PlusStatus`, both in local storage. No account response is synced.
 *
 * ExtensionPay still receives the opaque key when a registered install is checked and
 * may return account data associated with it. `gate.ts` immediately narrows that reply;
 * the privacy copy says so rather than claiming the email never reaches the extension.
 */

const HOST = "https://extensionpay.com";
const EXTENSION_ID = "byte-budget";
const EXTENSION_URL = `${HOST}/extension/${EXTENSION_ID}`;
const KEY_STORAGE = "plus.providerKey";
const LEGACY_KEY_STORAGE = "extensionpay_api_key";
const LEGACY_USER_STORAGE = "extensionpay_user";

export interface ProviderUser {
  paid: boolean;
  paidAt: Date | null;
  trialStartedAt: Date | null;
  subscriptionStatus?: "active" | "past_due" | "canceled";
  plan: { interval: "month" | "year" | "once" } | null;
}

function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function status(value: unknown): ProviderUser["subscriptionStatus"] {
  return value === "active" || value === "past_due" || value === "canceled"
    ? value
    : undefined;
}

function interval(value: unknown): ProviderUser["plan"] {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { interval?: unknown }).interval;
  return candidate === "month" || candidate === "year" || candidate === "once"
    ? { interval: candidate }
    : null;
}

function normalizeUser(value: unknown): ProviderUser {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const subscriptionStatus = status(raw.subscriptionStatus);
  return {
    paid: raw.paid === true,
    paidAt: date(raw.paidAt),
    trialStartedAt: date(raw.trialStartedAt),
    ...(subscriptionStatus ? { subscriptionStatus } : {}),
    plan: interval(raw.plan),
  };
}

/**
 * Reads the opaque provider key, migrating the old library's synced copy once.
 *
 * The old cached user is removed without being read: it can contain an email address,
 * and nothing in Byte Budget needs it. Removing both legacy keys also stops a clean
 * upgrade from continuing to sync subscription data after this version is installed.
 */
async function providerKey(): Promise<string | null> {
  const local = await chrome.storage.local.get(KEY_STORAGE);
  if (typeof local[KEY_STORAGE] === "string" && local[KEY_STORAGE] !== "") {
    return local[KEY_STORAGE];
  }

  const legacy = await chrome.storage.sync.get(LEGACY_KEY_STORAGE);
  const key = legacy[LEGACY_KEY_STORAGE];
  if (typeof key !== "string" || key === "") return null;
  await chrome.storage.sync.remove([LEGACY_KEY_STORAGE, LEGACY_USER_STORAGE]);
  await chrome.storage.local.set({ [KEY_STORAGE]: key });
  return key;
}

async function createProviderKey(): Promise<string> {
  const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
    update_url?: string;
  };
  const response = await fetch(`${EXTENSION_URL}/api/new-key`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify("update_url" in manifest ? {} : { development: true }),
  });
  if (!response.ok) throw new Error(`Subscription service returned ${response.status}.`);
  const value: unknown = await response.json();
  if (typeof value !== "string" || value === "") {
    throw new Error("Subscription service returned an invalid account key.");
  }
  await chrome.storage.local.set({ [KEY_STORAGE]: value });
  return value;
}

async function ensureProviderKey(): Promise<string> {
  return (await providerKey()) ?? createProviderKey();
}

/**
 * Returns the provider fields the product uses and nothing else.
 *
 * A never-registered free install has no key and therefore makes no request. Once a
 * trial, payment or restore flow creates a key, checks run against that key. The remote
 * JSON may contain additional account fields; `normalizeUser` drops them before the
 * value leaves this module, and no copy of the reply is persisted.
 */
export async function checkProviderUser(): Promise<ProviderUser> {
  const key = await providerKey();
  if (!key) {
    return {
      paid: false,
      paidAt: null,
      trialStartedAt: null,
      plan: null,
    };
  }

  const url = new URL(`${EXTENSION_URL}/api/v2/user`);
  url.searchParams.set("api_key", key);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Subscription service returned ${response.status}.`);
  return normalizeUser(await response.json());
}

async function open(path: string, parameters: Record<string, string> = {}): Promise<void> {
  const key = await ensureProviderKey();
  const url = new URL(`${EXTENSION_URL}/${path}`);
  url.searchParams.set("api_key", key);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  await chrome.tabs.create({ url: url.toString() });
}

export async function openProviderPayment(): Promise<void> {
  await open("choose-plan");
}

export async function openProviderTrial(days: number): Promise<void> {
  await open("trial", { period: `${days}-day` });
}

export async function openProviderLogin(): Promise<void> {
  await open("reactivate", { back: "choose-plan", v2: "" });
}

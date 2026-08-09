/**
 * The subscription check, and the only thing in this extension that talks to a server.
 *
 * Runs in the service worker and nowhere else. The surfaces ask through `GET_PLUS` like
 * they ask for everything else, which keeps the number of things that can make a network
 * request at exactly one — and makes the sentence in the privacy section ("the only
 * request Byte Budget makes of its own is the subscription check") a fact about the
 * module graph rather than a promise.
 *
 * ExtensionPay handles the payment itself: the card never touches this extension and
 * the payment page is theirs. Its account reply can carry more than this product needs,
 * so `provider.ts` reduces it before this module sees it and persists no raw response.
 *
 * ## The failure policy, which is the substance of this file
 *
 * A subscription check can fail for reasons that have nothing to do with whether someone
 * has paid: they are on a plane, the provider is down, their DNS is captive-portalled, or
 * — most likely of all here — a limit *they set* is refusing requests. So:
 *
 * **A failed check never removes access.** It returns the last answer that did succeed,
 * marked stale. There is no expiry on that: an install that pays once and then never sees
 * the network again keeps Plus forever. That is a deliberate trade, and it is the right
 * one at a dollar a month — the alternative is locking a paying customer out of settings
 * they configured because their wifi is bad, which converts a billing edge case into a
 * support ticket and a one-star review.
 *
 * **A failed check never grants access either.** `unknownStatus()` is free, so a fresh
 * install that cannot reach the provider is a free install rather than an accidentally
 * unlocked one. The asymmetry is intentional: the cost of being wrong in one direction is
 * a person who paid being told they did not, and in the other it is a person who did not
 * pay getting a settings pane. Only the first is worth avoiding.
 */

import { PLUS_REFRESH_MS, PLUS_STALE_MS, TRIAL_DAYS } from "./plans";
import {
  checkProviderUser,
  openProviderLogin,
  openProviderPayment,
  openProviderTrial,
  type ProviderUser,
} from "./provider";
import { unknownStatus, type PlusPage, type PlusStatus } from "./tier";

const STORAGE_KEY = "plus.status";

/**
 * The cached answer, in the worker's memory.
 *
 * `null` means "not read from storage yet", which is not the same as "free" — see
 * `ensureLoaded`. Getting those two confused would make every cold worker report a
 * paying customer as unpaid for the length of one storage read, and the surfaces poll,
 * so it would be visible as the Plus panes flickering shut and open again.
 */
let cached: PlusStatus | null = null;
let loading: Promise<PlusStatus> | null = null;
let refreshing: Promise<PlusStatus> | null = null;
let paymentPolling: Promise<PlusStatus> | null = null;

const PAYMENT_POLL_ATTEMPTS = 120;
const PAYMENT_POLL_INTERVAL_MS = 1_000;

/**
 * Keeps the in-memory answer in step with local storage.
 *
 * Payment-page events use the worker's ordinary top-level message listener and call
 * `refreshPlus` directly; the only listener owned here is the memo invalidation below.
 */
export function startPlus(): void {
  /*
   * The memo may not outlive the thing it is a copy of.
   *
   * `cached` is held for the whole life of the worker, and the stored value it was read
   * from can change underneath it — a profile sync, a storage clear, or anything else
   * that empties `chrome.storage.local`. Without this the worker would keep answering
   * from a copy of a record that no longer exists, which is exactly the failure this
   * project has already had three times over (`NEXT_AI_HANDOFF.md` rule 16: anything
   * cleared on disk has to be cleared in memory too, and the size model in particular
   * wrote deleted data straight back).
   *
   * Dropping the memo rather than adopting the new value: the next read re-normalises
   * from storage, which is the one code path that knows what a valid record looks like.
   */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(STORAGE_KEY in changes)) return;
    cached = null;
    loading = null;
  });
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

async function ensureLoaded(): Promise<PlusStatus> {
  if (cached) return cached;
  if (!loading) {
    loading = chrome.storage.local
      .get(STORAGE_KEY)
      .then((stored) => {
        cached = normalize(stored[STORAGE_KEY]);
        return cached;
      })
      .catch(() => {
        // A storage read that fails leaves `cached` null rather than writing a free
        // answer into it, so the next call retries instead of pinning a paying customer
        // to the free tier for the life of the worker.
        loading = null;
        return unknownStatus();
      });
  }
  return loading;
}

/**
 * The current answer, refreshing in the background when it is old.
 *
 * Deliberately does not await the refresh. Every gate in the product calls this, several
 * of them on a render path, and blocking a settings pane on a network round trip to
 * decide whether to draw a disclosure is how a paid tier becomes the reason the page
 * feels slow. The refresh lands in storage and the surfaces re-read on their own clock.
 */
export async function plusStatus(): Promise<PlusStatus> {
  const status = await ensureLoaded();
  if (Date.now() - status.checkedAt > PLUS_REFRESH_MS) void refreshPlus(false);
  return withStaleness(status);
}

/**
 * Asks the provider, and writes the answer down.
 *
 * Coalesced: several surfaces polling at once must not become several HTTP requests.
 * `force` skips the coalescing window only in the sense that it always performs a
 * check — it still joins an in-flight one, because two checks issued a millisecond
 * apart cannot disagree usefully.
 */
export async function refreshPlus(force: boolean): Promise<PlusStatus> {
  if (refreshing) return refreshing;
  const previous = await ensureLoaded();
  if (!force && Date.now() - previous.checkedAt <= PLUS_REFRESH_MS) {
    return withStaleness(previous);
  }

  refreshing = (async () => {
    try {
      const user = await checkProviderUser();
      const next = fromUser(user);
      cached = next;
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
      return next;
    } catch (error) {
      // The whole failure policy, in one return. Not `unknownStatus()`, and not a
      // downgrade of `previous` — the last successful answer stands, and only
      // `checkedAt` is left alone so `withStaleness` can start saying it is old.
      console.warn("Byte Budget: could not reach the subscription service", error);
      return withStaleness(previous);
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

/**
 * Refreshes after ExtensionPay's completion page reports a trial or payment.
 *
 * Trial confirmation has already written its provider record, so one check is enough.
 * Stripe's payment webhook can arrive after the browser reaches the success page; for
 * that event we keep checking for up to two minutes, matching the provider library's
 * retry window. The message event stays alive while this promise is pending, which in
 * turn keeps the MV3 worker alive instead of trusting a timer across worker teardown.
 */
export async function refreshPlusAfterProviderEvent(
  event: "payment" | "trial",
): Promise<PlusStatus> {
  if (event === "trial") return refreshPlus(true);
  if (paymentPolling) return paymentPolling;

  const task = (async () => {
    let latest = await refreshPlus(true);
    for (let attempt = 1; attempt < PAYMENT_POLL_ATTEMPTS; attempt++) {
      if (latest.reason === "paid") return latest;
      await new Promise<void>((resolve) => setTimeout(resolve, PAYMENT_POLL_INTERVAL_MS));
      latest = await refreshPlus(true);
    }
    return latest;
  })();
  paymentPolling = task;
  try {
    return await task;
  } finally {
    if (paymentPolling === task) paymentPolling = null;
  }
}

function withStaleness(status: PlusStatus): PlusStatus {
  return { ...status, stale: Date.now() - status.checkedAt > PLUS_STALE_MS };
}

/* ------------------------------------------------------------------ *
 * Mapping what the provider says onto what the product means
 * ------------------------------------------------------------------ */

/**
 * The one place the provider's vocabulary becomes the product's.
 *
 * Two decisions in here are policy rather than translation, and both are stated in the
 * UI rather than being silent:
 *
 * - **A trial is Plus.** ExtensionPay reports `paid: false` throughout a trial and hands
 *   over the start date; deciding when it ends is the extension's job. `TRIAL_DAYS` is
 *   the whole of that decision.
 *
 * - **`past_due` keeps Plus.** A failed renewal is usually an expired card, and Stripe
 *   retries for days before giving up. Cutting someone off at the first failed charge
 *   punishes the person most likely to fix it, so the access stays and the Plus section
 *   says the payment failed and links to the billing page. When the retries are
 *   exhausted the status becomes `canceled` and this falls through to `expired`, which
 *   is where access actually ends.
 */
function fromUser(user: ProviderUser): PlusStatus {
  const now = Date.now();
  const trialStartedAt = user.trialStartedAt ? user.trialStartedAt.getTime() : null;
  const trialEndsAt =
    trialStartedAt === null ? null : trialStartedAt + TRIAL_DAYS * 24 * 60 * 60 * 1000;
  const inTrial = trialEndsAt !== null && now < trialEndsAt;
  const pastDue = user.subscriptionStatus === "past_due";

  const plus = user.paid || pastDue || inTrial;
  const reason: PlusStatus["reason"] = user.paid
    ? "paid"
    : pastDue
      ? "past_due"
      : inTrial
        ? "trial"
        : user.paidAt || trialStartedAt !== null
          ? "expired"
          : "never";

  return {
    plus,
    reason,
    trialEndsAt,
    trialAvailable: trialStartedAt === null,
    interval: user.plan?.interval ?? null,
    checkedAt: now,
    stale: false,
  };
}

/** Reads a stored status back, tolerating anything an older build may have written. */
function normalize(value: unknown): PlusStatus {
  if (!value || typeof value !== "object") return unknownStatus();
  const raw = value as Partial<PlusStatus>;
  if (typeof raw.plus !== "boolean" || typeof raw.checkedAt !== "number") {
    return unknownStatus();
  }
  return {
    plus: raw.plus,
    reason: raw.reason ?? (raw.plus ? "paid" : "never"),
    trialEndsAt: typeof raw.trialEndsAt === "number" ? raw.trialEndsAt : null,
    trialAvailable: raw.trialAvailable !== false,
    interval: raw.interval ?? null,
    checkedAt: raw.checkedAt,
    stale: false,
  };
}

/* ------------------------------------------------------------------ *
 * The pages
 * ------------------------------------------------------------------ */

/**
 * Opens one of ExtensionPay's hosted pages.
 *
 * All three are theirs, on their origin. Card details remain there; the account status
 * reply is reduced by `provider.ts` before it reaches this module.
 */
export async function openPlusPage(page: PlusPage): Promise<void> {
  switch (page) {
    case "payment":
      await openProviderPayment();
      return;
    case "trial":
      // The string is display text on their page, not an identifier: it is what the
      // person reads above the confirm button. `TRIAL_DAYS` feeds it so the page and
      // `fromUser` above cannot come to disagree about how long a trial lasts.
      await openProviderTrial(TRIAL_DAYS);
      return;
    case "login":
      await openProviderLogin();
      return;
  }
}

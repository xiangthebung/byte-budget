/**
 * The request ledger's input: `chrome.webRequest`, used purely as an observer.
 *
 * This is the only source that sees *every* request — including ones no page can
 * observe, from service workers, from other extensions, and from the browser
 * itself. Resource timings from the page only ever enrich what is recorded here
 * (PLAN.md §1.2), never replace it.
 *
 * Byte arithmetic, stated plainly so the numbers can be argued with:
 *
 * - Body bytes come from `Content-Length`, which is the encoded (post-gzip)
 *   length and therefore what actually crossed the wire.
 * - Header bytes are computed from names and values, then halved. See
 *   `HEADER_WIRE_FACTOR` in `wire.ts` for why, and for why that approximation is
 *   deliberately kept out of the measured-share figure.
 * - A response served from cache costs no body bytes. What it *would* have cost is
 *   recorded separately as `cacheAvoided`, so the cache gets credit without being
 *   counted as traffic.
 * - WebSocket frames are invisible to extensions. Only the handshake is counted,
 *   and the dashboard says so rather than reporting a chat app as weightless.
 * - A redirect keeps one `requestId`, and only the final hop's request headers are
 *   counted. Accepted: the missing bytes are a few hundred per redirect.
 */

import { ensureEnforcementReady, isEnforcedByUs } from "../limit/enforce";
import { optimizeSettings } from "../optimize/apply";
import { packForRedirect } from "../optimize/packs";
import {
  creditRewrite,
  isRefusedByOptimizer,
  forgetRewrite,
  isRewritable,
  noteRewrite,
  observeBaseline,
} from "../optimize/savings";
import { hostFromUrl } from "../core/sites";
import { asResourceType, type ResourceType } from "../core/types";
import { sizeModel } from "./estimate";
import { ledger, type CommitEntry } from "./ledger";
import { addPending } from "./reconcile";
import { ensureTabsReady, tabRecord } from "./tabs";
import {
  attributeSite,
  bodyImpossible,
  contentLength,
  requestUpBytes,
  responseHeaderBytes,
} from "./wire";

const REQUEST_FILTER: chrome.webRequest.RequestFilter = {
  urls: ["http://*/*", "https://*/*"],
};

/** Cap on in-flight request bookkeeping, in case completions are ever missed. */
const MAX_IN_FLIGHT = 4000;

/** Request-header bytes per in-flight request, keyed by `requestId`. */
const upBytes = new Map<string, number>();

function remember(requestId: string, bytes: number): void {
  if (upBytes.size >= MAX_IN_FLIGHT) {
    // Map iteration is insertion-ordered, so this drops the oldest.
    const oldest = upBytes.keys().next();
    if (!oldest.done) upBytes.delete(oldest.value);
  }
  upBytes.set(requestId, bytes);
}

function takeUpBytes(requestId: string): number {
  const bytes = upBytes.get(requestId) ?? 0;
  upBytes.delete(requestId);
  return bytes;
}

function siteForTab(tabId: number): string | undefined {
  return tabRecord(tabId)?.site;
}

function baseEntry(details: {
  tabId: number;
  type: string;
  url: string;
  initiator?: string;
  timeStamp: number;
}): { entry: CommitEntry; host: string; type: ResourceType } {
  const host = hostFromUrl(details.url) ?? "";
  const type = asResourceType(details.type);
  const entry: CommitEntry = {
    at: details.timeStamp || Date.now(),
    site: attributeSite(details, siteForTab),
    host,
    type,
    tabId: details.tabId,
    // Read now, not when the entry is finally committed. A chunked response is
    // priced up to eight seconds later, by which point the tab may be showing
    // another page, and these bytes belong to the load that asked for them.
    visitId: tabRecord(details.tabId)?.visitId ?? null,
    down: 0,
    up: 0,
    estimatedDown: 0,
    fromCache: false,
    cacheAvoided: 0,
    saved: 0,
    savedMeasured: 0,
    blocked: false,
    rewritten: 0,
  };
  return { entry, host, type };
}

export function registerRequestListeners(): void {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      remember(details.requestId, requestUpBytes(details.url, details.method, details.requestHeaders));
    },
    REQUEST_FILTER,
    ["requestHeaders"],
  );

  // Both handlers are fire-and-forget, so a rejected promise here is a request
  // that vanishes from the ledger with nothing said. The totals would just be
  // quietly low, which is the one failure this extension must not have.
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      handleCompleted(details).catch((error: unknown) => {
        console.error("Byte Budget: dropped a completed request", details.url, error);
      });
    },
    REQUEST_FILTER,
    ["responseHeaders"],
  );

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    handleError(details).catch((error: unknown) => {
      console.error("Byte Budget: dropped a failed request", details.url, error);
    });
  }, REQUEST_FILTER);

  // The only place a `declarativeNetRequest` rewrite becomes observable. The rule is
  // applied inside the network stack without notifying anyone, and by `onCompleted` the
  // request wears its new URL as though it had always had it.
  chrome.webRequest.onBeforeRedirect.addListener(
    (details) => {
      const settings = optimizeSettings();
      if (!settings) return;
      const pack = packForRedirect(
        details.url,
        details.redirectUrl,
        (id) => settings.packs[id] === true,
      );
      if (pack) noteRewrite(details.requestId, details.url, pack.id);
    },
    REQUEST_FILTER,
  );
}

async function handleCompleted(details: chrome.webRequest.OnCompletedDetails): Promise<void> {
  try {
    await priceCompleted(details);
  } finally {
    // `creditRewrite` already forgets the ones it prices. Anything still here is a
    // request whose body bytes could not be priced at all — served from cache, a
    // status that cannot carry a body, or parked for a size that arrives later — and
    // the record must not survive to be charged against some other request.
    //
    // The parked case is a known and accepted gap rather than an oversight: a
    // rewritten variant that arrives chunked goes uncredited. Every host a pack
    // rewrites is an image CDN and declares a `Content-Length`, and crediting it
    // later would mean an await on the synchronous commit path in `reconcile`.
    forgetRewrite(details.requestId);
  }
}

async function priceCompleted(details: chrome.webRequest.OnCompletedDetails): Promise<void> {
  await ensureTabsReady();
  await sizeModel.load();

  const { entry, host, type } = baseEntry(details);
  entry.up = takeUpBytes(details.requestId);

  const headerDown = responseHeaderBytes(details.statusLine, details.responseHeaders);

  if (details.fromCache) {
    // No body crossed the network. A revalidation did send and receive headers; a
    // straight cache hit did not, and `webRequest` does not distinguish them, so
    // the headers are counted only for the status that proves a round trip.
    entry.fromCache = true;
    entry.down = details.statusCode === 304 ? headerDown : 0;
    entry.cacheAvoided = sizeModel.estimate(host, type);
    ledger.record(entry);
    return;
  }

  if (type === "websocket") {
    entry.down = headerDown;
    ledger.record(entry);
    return;
  }

  const body = contentLength(details.responseHeaders);
  if (body !== null) {
    entry.down = headerDown + body;
    sizeModel.observe(host, type, entry.down);
    await creditOptimizer(entry, details);
    ledger.record(entry);
    return;
  }

  if (bodyImpossible(details.statusCode, details.method)) {
    entry.down = headerDown;
    ledger.record(entry);
    return;
  }

  // Chunked or streamed: park it and wait for the page to report a size.
  entry.down = headerDown;
  addPending(entry, details.url, headerDown, sizeModel.estimate(host, type));
}

/**
 * Books a rewrite's saving, or remembers what an un-rewritten variant cost.
 *
 * Both halves matter and they are two sides of the same mechanism. When a pack rewrote
 * this request, the saving is the original size minus this one — measured if the
 * original has ever been seen, modelled from the pack's expected ratio if not. When a
 * pack *would* have rewritten it but did not — because the pack is off, or because this
 * load is a control — then this response *is* the original, and recording its size is
 * what turns every future saving on that URL from a model into arithmetic.
 */
async function creditOptimizer(
  entry: CommitEntry,
  details: chrome.webRequest.OnCompletedDetails,
): Promise<void> {
  const credit = await creditRewrite(details.requestId, entry.down);
  if (credit) {
    entry.saved += credit.saved;
    entry.savedMeasured += credit.measured;
    entry.rewritten += 1;
    return;
  }
  if (entry.down > 0 && isRewritable(details.url)) observeBaseline(details.url, entry.down);
}

/** What Chrome reports when an extension refuses a request. */
const BLOCKED_ERROR = "net::ERR_BLOCKED_BY_CLIENT";

/**
 * A request that did not complete: refused by a rule, cancelled, or failed.
 *
 * A refusal is the interesting case, and it is the only place a *saving* can
 * honestly be recorded: the request was never dispatched, so the bytes it would
 * have cost are bytes that did not happen. How many that is has to come from the
 * size model — there is no other source for the weight of something that never
 * arrived — so it is booked as an estimate, like any other modelled figure.
 *
 * Credited only when this extension is the one enforcing. Chrome reports the same
 * error for every extension's block, so an ad blocker's work would otherwise show
 * up here as bytes Byte Budget saved.
 *
 * For an ordinary cancellation there is a known undercount. Chrome aborts loads it
 * decides it no longer needs — an image whose bytes turn out not to decode, a fetch
 * the page cancelled, a navigation replaced by another — and by then part of the
 * body has usually arrived. No API reports how much. Counting the declared
 * `Content-Length` would over-report a download that stopped early; counting zero
 * under-reports it. Zero wins because it cannot invent traffic, and the request is
 * still counted so the request total stays right.
 *
 * That last clause used to be a claim rather than a description: the function
 * returned early unless it had request-header bytes to book, so a cancellation
 * where `onSendHeaders` never fired — or where the in-flight cap had already
 * evicted its entry — disappeared from the request counts that the per-host and
 * per-visit tables are built from.
 */
async function handleError(details: chrome.webRequest.OnErrorOccurredDetails): Promise<void> {
  await ensureTabsReady();
  await ensureEnforcementReady();
  await sizeModel.load();

  const { entry, host, type } = baseEntry(details);
  entry.up = takeUpBytes(details.requestId);

  if (details.error === BLOCKED_ERROR) {
    entry.blocked = true;
    // Either subsystem may be the reason, and neither should be credited for the
    // other's work — or for an ad blocker's, which reports the same error.
    const ours = isEnforcedByUs(entry.site, type) || isRefusedByOptimizer(type);
    entry.saved = ours ? sizeModel.estimate(host, type) : 0;
    ledger.record(entry);
    return;
  }

  ledger.record(entry);
}

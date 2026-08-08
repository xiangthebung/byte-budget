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
 * - Every size that leaves this module is header-inclusive, and `sizeModel` is
 *   trained on header-inclusive figures. Nothing downstream may add a header block
 *   to an estimate; `reconcile.ts` did, and every estimated request carried one
 *   halved header block twice.
 * - `Cookie` and `Set-Cookie` are missing from the header arrays below. Chrome
 *   withholds both unless a listener opts in with `"extraHeaders"`, and this build
 *   does not: the flag takes every request in the browser off Chrome's optimized
 *   request-handling path, which is a real cost paid on all traffic to correct one
 *   field. So `up` is structurally low wherever someone is signed in — a session
 *   `Cookie` runs to a few kB and goes out with every request to that site — and it
 *   is counted as zero *before* the halving above, not after it. Disclosed in
 *   README "What is approximate"; if that entry is ever removed, this flag has to
 *   go in.
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

/* ------------------------------------------------------------------ *
 * The upload mirror
 * ------------------------------------------------------------------ */

/**
 * Where the mirrored uploads live between worker lifetimes.
 *
 * `chrome.storage.session` and not `local`: an in-flight request cannot outlive
 * the browser, so neither should the record of it.
 */
const UPLOAD_SESSION_KEY = "uploads";

/**
 * Above this many declared body bytes, an in-flight request is mirrored.
 *
 * The whole map used to be plain module state, and the failure that made this
 * necessary is specific: `onSendHeaders` folds in the declared `Content-Length`
 * and a long upload then fires no further events, so thirty quiet seconds tear the
 * worker down, the map goes with it, and a 500 MB upload is recorded with zero
 * up-bytes. Not every request, because the mirror costs a write: below this a
 * request is a header block whose loss is inside the halving error anyway, and
 * above it the request is precisely the kind that goes quiet for minutes.
 */
const UPLOAD_MIRROR_THRESHOLD = 64 * 1024;

/**
 * How long a mirrored upload waits before it is assumed never to be priced.
 *
 * Generous on purpose — the entries here are large uploads on connections slow
 * enough to be worth budgeting. What it bounds is the request that neither
 * completes nor errors: a renderer killed mid-POST, a network that went away. That
 * record would otherwise sit in session storage until the browser restarts.
 */
const UPLOAD_MIRROR_TTL_MS = 60 * 60 * 1000;

/** Cap on mirrored uploads, so a pathological page cannot fill session storage. */
const MAX_MIRRORED_UPLOADS = 256;

interface MirroredUpload {
  bytes: number;
  /** For the sweep only, and only ever compared against another reading. */
  at: number;
}

const mirrored = new Map<string, MirroredUpload>();
let mirrorReady: Promise<void> | null = null;
let mirrorWriteQueued = false;

/**
 * Reads back the uploads a previous worker had in flight.
 *
 * Awaited before anything reads the map, on both pricing paths. Entries already in
 * memory win: a `requestId` seen by *this* worker is live, and a restored row with
 * the same id could only be a stale one.
 */
function ensureUploadsReady(): Promise<void> {
  if (mirrorReady) return mirrorReady;
  mirrorReady = (async () => {
    try {
      const stored = await chrome.storage.session.get(UPLOAD_SESSION_KEY);
      const raw = stored[UPLOAD_SESSION_KEY] as Record<string, MirroredUpload> | undefined;
      for (const [requestId, row] of Object.entries(raw ?? {})) {
        if (mirrored.has(requestId)) continue;
        if (!row || typeof row.bytes !== "number" || !(row.bytes > 0)) continue;
        mirrored.set(requestId, {
          bytes: row.bytes,
          at: typeof row.at === "number" ? row.at : Date.now(),
        });
      }
    } catch {
      // Costs the uploads in flight across this one teardown, which is the state
      // before the mirror existed. Not worth failing the request path over.
    }
  })();
  return mirrorReady;
}

function queueMirrorWrite(): void {
  if (mirrorWriteQueued) return;
  mirrorWriteQueued = true;
  // Behind the restore, not merely coalesced. A fresh worker woken *by* a large
  // upload would otherwise write a map holding only that request and delete every
  // upload the previous worker had in flight — losing exactly what this mirror
  // exists to keep. Coalescing matters too: a page posting a dozen files fires
  // `onSendHeaders` for all of them in one turn, and that is one write.
  void ensureUploadsReady().then(() => {
    mirrorWriteQueued = false;
    const rows: Record<string, MirroredUpload> = {};
    for (const [requestId, row] of mirrored) rows[requestId] = row;
    return chrome.storage.session.set({ [UPLOAD_SESSION_KEY]: rows });
  }).catch(() => undefined);
}

/**
 * Drops mirrored uploads that will never be priced.
 *
 * Exported for the one-minute `maintenance()` alarm in `background.ts`. Nothing
 * else revisits the mirror: `takeUpBytes` only removes the ids it is asked for, so
 * a request that never reaches `onCompleted` or `onErrorOccurred` has no other
 * route out.
 */
export async function sweepUploads(now = Date.now()): Promise<void> {
  await ensureUploadsReady();
  let dropped = 0;
  for (const [requestId, row] of mirrored) {
    // A backwards clock step only makes this wait longer, never shorter, so a
    // stale id cannot be swept while its request is still running.
    if (now - row.at < UPLOAD_MIRROR_TTL_MS) continue;
    mirrored.delete(requestId);
    dropped += 1;
  }
  if (dropped > 0) queueMirrorWrite();
}

function remember(requestId: string, bytes: number): void {
  if (upBytes.size >= MAX_IN_FLIGHT) {
    // Map iteration is insertion-ordered, so this drops the oldest.
    const oldest = upBytes.keys().next();
    if (!oldest.done) upBytes.delete(oldest.value);
  }
  upBytes.set(requestId, bytes);

  if (bytes < UPLOAD_MIRROR_THRESHOLD) return;
  if (mirrored.size >= MAX_MIRRORED_UPLOADS) {
    const oldest = mirrored.keys().next();
    if (!oldest.done) mirrored.delete(oldest.value);
  }
  mirrored.set(requestId, { bytes, at: Date.now() });
  queueMirrorWrite();
}

/**
 * The bytes this request sent, and forgets it.
 *
 * Callers must have awaited `ensureUploadsReady()`, or a request that outlived a
 * worker teardown reads as zero — which is the defect this pair exists to fix, not
 * a state worth falling back to silently.
 */
function takeUpBytes(requestId: string): number {
  const mirror = mirrored.get(requestId);
  if (mirror) {
    mirrored.delete(requestId);
    queueMirrorWrite();
  }
  const bytes = upBytes.get(requestId);
  upBytes.delete(requestId);
  // Memory first: this worker saw the request start, so its figure is the live
  // one. The mirror is what is left when the worker that saw it is gone.
  return bytes ?? mirror?.bytes ?? 0;
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
  // Restored eagerly rather than only on the first completion, so a worker woken by
  // something other than the upload it is holding still has the mirror loaded
  // before `queueMirrorWrite` can overwrite it.
  void ensureUploadsReady();

  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      remember(details.requestId, requestUpBytes(details.url, details.method, details.requestHeaders));
    },
    REQUEST_FILTER,
    // `"requestHeaders"` without `"extraHeaders"`, so no `Cookie` — a deliberate
    // and documented undercount of `up`. See the module header before adding it.
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
    // Also without `"extraHeaders"`: `Set-Cookie` is invisible here for the same
    // reason `Cookie` is above, and costs the same way.
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
  await ensureUploadsReady();

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
    observeCachedBaseline(details, headerDown);
    ledger.record(entry);
    return;
  }

  if (type === "websocket") {
    entry.down = headerDown;
    ledger.record(entry);
    return;
  }

  // Ahead of `Content-Length`, not behind it. A HEAD response declares the size of
  // the body it is deliberately *not* sending, so testing the header first booked
  // that figure as traffic and fed it to `sizeModel.observe` — and on a cold key
  // the model takes the first sample as the mean outright, so a single HEAD against
  // a 60 MB file went on to price every blocked request and every cache hit on that
  // host. Same shape for 204/205/304.
  if (bodyImpossible(details.statusCode, details.method)) {
    entry.down = headerDown;
    ledger.record(entry);
    return;
  }

  const body = contentLength(details.responseHeaders);
  if (body !== null) {
    entry.down = headerDown + body;
    // Header-inclusive, and this is one of the two places that fixes the model's
    // convention. Anything consuming `sizeModel.estimate` is consuming a whole wire
    // size and must not add headers to it — see `reconcile.ts`.
    sizeModel.observe(host, type, entry.down);
    await creditOptimizer(entry, details);
    ledger.record(entry);
    return;
  }

  // Chunked or streamed: park it and wait for the page to report a size.
  entry.down = headerDown;
  addPending(entry, details.url, headerDown, sizeModel.estimate(host, type));
}

/**
 * Records what an un-rewritten variant weighs, from a response that cost nothing.
 *
 * The savings mechanism rests on knowing the original's size, and the load whose
 * entire purpose is to record that — a holdout control, or any load with the pack
 * off — banks nothing here without this. On a repeat visit most images come from
 * cache, so the control arm was systematically the arm that learned least, which is
 * backwards. Chrome still hands us `responseHeaders` for a cache hit, so the
 * declared size is knowable without a byte crossing the wire.
 *
 * Header-inclusive to match `entry.down`, which is what `creditRewrite` subtracts a
 * baseline from; a body-only baseline would show a saving one header block too
 * large on every rewritten image.
 *
 * `isRewritable` is false for a pack's own output — every pack is tested against
 * that — so a cached *rewritten* variant cannot overwrite the original it came
 * from.
 */
function observeCachedBaseline(
  details: chrome.webRequest.OnCompletedDetails,
  headerDown: number,
): void {
  const declared = contentLength(details.responseHeaders);
  if (declared === null || declared <= 0) return;
  if (!isRewritable(details.url)) return;
  observeBaseline(details.url, headerDown + declared);
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
  await ensureUploadsReady();

  const { entry, host, type } = baseEntry(details);
  entry.up = takeUpBytes(details.requestId);

  if (details.error === BLOCKED_ERROR) {
    entry.blocked = true;
    // Either subsystem may be the reason, and neither should be credited for the
    // other's work — or for an ad blocker's, which reports the same error.
    //
    // Both questions are therefore site- and tab-scoped. A bare type test was not
    // one: it asked "would the optimizer ever refuse this type" rather than "did we
    // install a rule that refused *this* request", so on an excluded site or a
    // holdout tab — where no optimizer rule exists at all — every other extension's
    // block was booked as a saving Byte Budget had made.
    const ours =
      isEnforcedByUs(entry.site, type) || isRefusedByOptimizer(entry.site, type, entry.tabId);
    entry.saved = ours ? sizeModel.estimate(host, type) : 0;
    ledger.record(entry);
    return;
  }

  ledger.record(entry);
}

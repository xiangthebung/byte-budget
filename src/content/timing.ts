/**
 * Reports what the page can see about its own transfer sizes.
 *
 * The service worker knows about every request but often not how big it was: a
 * chunked or streamed response has no `Content-Length` to read. The page does
 * know, through `PerformanceResourceTiming.transferSize`, so this ships those
 * figures back and the worker settles the requests it had parked (ARCHITECTURE.md "Reconciliation").
 *
 * What gets sent is deliberately narrower than what gets measured. The first
 * version posted every resource from every frame on every page load, for numbers the
 * worker mostly threw away — one message per resource is real work on the bus and in
 * the worker, and it kept the worker awake to do it. Three filters, all of which can
 * be *proved* from what the page sees rather than guessed:
 *
 * 1. A zero size. That means an opaque cross-origin response with no
 *    `Timing-Allow-Origin`, or a cache hit; in neither case is it a measurement, so
 *    sending it would be noise and, worse, a number that could be mistaken for zero
 *    bytes.
 * 2. A URL that is not `http:` or `https:`. Only those reach `webRequest`, so a
 *    `blob:` media segment or a `data:` image has no parked request to settle and
 *    never will.
 * 3. A transfer smaller than the body it delivered. That body did not come off the
 *    wire — it came out of the cache, with a revalidating 304 as the whole transfer.
 *    The worker prices cache hits from `details.fromCache` the moment they complete
 *    and never parks one, so nothing is waiting for this number.
 *
 * Plus one sample per URL per batch; see `queue`.
 *
 * What is deliberately *not* filtered: whether the response carried a
 * `Content-Length`, which is the property that actually decides whether the worker
 * parked the request. A page cannot read response headers, so that test does not
 * exist here at any price. Every proxy for it — trusting `initiatorType`, assuming a
 * same-origin response is always sized — would throw away exactly the streamed and
 * chunked bodies this path exists for, and `scripts/smoke.mjs` pins one of them:
 * "the streamed fetch is measured from resource timing". Sending a report the worker
 * discards costs a message; withholding one it needed costs a measurement, and the
 * request is then priced by a model instead. The filter only removes responses that
 * provably never crossed the network.
 *
 * Two structural constraints, both learned the hard way:
 *
 * 1. This file imports nothing. Manifest content scripts are classic scripts, so
 *    a bundle with an `import` in it loads fine in the popup and silently does
 *    nothing on a page. `assert-classic-scripts` in vite.config.ts fails the build
 *    if that ever stops being true.
 * 2. Everything is inside an IIFE behind a marker on `window`. The worker injects
 *    this script into already-open tabs on install, and the manifest also declares
 *    it — so it can run twice in the same isolated world. With top-level
 *    declarations, the second run dies on "Identifier 't' has already been
 *    declared" after the minifier hoists a const, which is a real error in a real
 *    page's console and was exactly what the first version did.
 */

(() => {
  const MARKER = "__byteBudgetTiming";
  const target = window as unknown as Record<string, boolean>;
  if (target[MARKER]) return;
  target[MARKER] = true;

  interface TimingSample {
    url: string;
    transferSize: number;
    encodedBodySize: number;
    initiatorType: string;
  }

  const BATCH_DELAY_MS = 1500;
  /** Send early rather than let a heavy page build an unbounded batch. Distinct URLs. */
  const MAX_BATCH = 250;

  /**
   * One sample per URL, in the order the resources finished.
   *
   * The worker matches a report to a parked request on `tabId|url` and hands the size
   * to the oldest request still waiting under that key, so a second sample for the
   * same URL in the same batch is an entry that can only settle a request the first
   * one already settled. On a page that fetches one URL repeatedly — a poll, a tile
   * server, a sprite requested from several frames — those duplicates were most of
   * what crossed the bus. The first sample is kept rather than the last, which is the
   * same end of the queue the worker pairs from.
   *
   * The cost is real and worth stating: a URL fetched twice inside one batch window
   * leaves the second request to expire on the parked queue's own timer and be priced
   * by the size model. That request is then recorded as estimated, so the total stays
   * honest about which part of itself is measured — it is only less precise.
   */
  const queue = new Map<string, TimingSample>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disconnected = false;

  function send(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (disconnected || queue.size === 0) return;
    const entries: TimingSample[] = [...queue.values()];
    queue.clear();
    try {
      chrome.runtime.sendMessage({ type: "REPORT_TIMINGS", entries }, () => {
        // Reading `lastError` is what stops Chrome logging "message port closed"
        // for a fire-and-forget message the worker answered by returning.
        void chrome.runtime.lastError;
      });
    } catch {
      // The extension was reloaded or removed while this page stayed open. Nothing
      // will ever accept these again, so stop observing rather than throwing on
      // every resource for the rest of the page's life.
      disconnected = true;
    }
  }

  function schedule(): void {
    if (disconnected) return;
    if (queue.size >= MAX_BATCH) {
      send();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(send, BATCH_DELAY_MS);
  }

  /**
   * Whether a request under this URL could be parked in the worker at all.
   *
   * `webRequest` only ever sees http and https, so anything else — `blob:`, `data:`,
   * `filesystem:`, an extension URL — has no counterpart there to settle. Tested on
   * the prefix rather than by parsing, because this runs once per resource on every
   * page in the browser and `new URL()` here would allocate for all of them.
   */
  function isNetworkUrl(url: string): boolean {
    return url.startsWith("https://") || url.startsWith("http://");
  }

  function collect(entries: PerformanceEntryList): void {
    for (const entry of entries) {
      const timing = entry as PerformanceResourceTiming;
      const transferSize = Number(timing.transferSize);
      if (!Number.isFinite(transferSize) || transferSize <= 0) continue;

      const url = timing.name;
      if (!isNetworkUrl(url)) continue;

      const encodedBodySize = Number(timing.encodedBodySize) || 0;
      // Strictly smaller, so a body of zero — a 204, a redirect, an empty streamed
      // response — still counts as a network transfer worth reporting. Only a body
      // larger than the transfer that supposedly carried it proves the cache served
      // it, and the worker has already priced that request from `details.fromCache`.
      if (encodedBodySize > 0 && transferSize < encodedBodySize) continue;

      // Same URL twice in one batch: keep the first. See `queue`.
      if (queue.has(url)) continue;
      queue.set(url, {
        url,
        transferSize,
        encodedBodySize,
        initiatorType: timing.initiatorType || "other",
      });
    }
    if (queue.size > 0) schedule();
  }

  function observe(type: "resource" | "navigation"): void {
    try {
      const observer = new PerformanceObserver((list) => collect(list.getEntries()));
      // `buffered` catches entries recorded between the navigation starting and
      // this script running, which at document_start is short but not empty — and
      // is the whole window when the worker injects into an already-open tab.
      observer.observe({ type, buffered: true });
    } catch {
      // An entry type this browser does not support. The other observer still runs.
    }
  }

  observe("resource");
  observe("navigation");

  // A page being hidden or unloaded is the last chance to report; the batch timer
  // may not fire again. `pagehide` covers both closing and going into the back/
  // forward cache, where the timer is frozen rather than run.
  addEventListener("pagehide", send);
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") send();
  });
})();

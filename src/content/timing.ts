/**
 * Reports what the page can see about its own transfer sizes.
 *
 * The service worker knows about every request but often not how big it was: a
 * chunked or streamed response has no `Content-Length` to read. The page does
 * know, through `PerformanceResourceTiming.transferSize`, so this ships those
 * figures back and the worker settles the requests it had parked (PLAN.md §1.2).
 *
 * Only non-zero sizes are sent. A zero means one of two things — an opaque
 * cross-origin response with no `Timing-Allow-Origin`, or a cache hit — and in
 * neither case is it a measurement, so posting it would be noise on the message
 * bus and, worse, a number that could be mistaken for zero bytes.
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
  /** Send early rather than let a heavy page build an unbounded batch. */
  const MAX_BATCH = 250;

  let queue: TimingSample[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disconnected = false;

  function send(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (disconnected || queue.length === 0) return;
    const entries: TimingSample[] = queue;
    queue = [];
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
    if (queue.length >= MAX_BATCH) {
      send();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(send, BATCH_DELAY_MS);
  }

  function collect(entries: PerformanceEntryList): void {
    for (const entry of entries) {
      const timing = entry as PerformanceResourceTiming;
      const transferSize = Number(timing.transferSize);
      if (!Number.isFinite(transferSize) || transferSize <= 0) continue;
      queue.push({
        url: timing.name,
        transferSize,
        encodedBodySize: Number(timing.encodedBodySize) || 0,
        initiatorType: timing.initiatorType || "other",
      });
    }
    if (queue.length > 0) schedule();
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

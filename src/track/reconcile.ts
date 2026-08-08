/**
 * Requests that finished without telling us how big they were.
 *
 * A response with no `Content-Length` — anything chunked or streamed, which
 * includes most HTML documents and all adaptive video — leaves `webRequest` with
 * nothing to count. The page itself can often see the real figure through
 * `PerformanceResourceTiming.transferSize`, so such a request is parked here for a
 * few seconds while the content script's next batch arrives, and settled with the
 * exact number if it does.
 *
 * If it does not, it is committed with the size model's estimate and marked as
 * estimated, which is the whole reason `UsageTotals.estimatedDown` exists. The one
 * thing that must never happen is a request quietly counting as zero: that is a
 * wrong number wearing the clothes of a right one. A request quietly counting as
 * *nothing at all* is the same failure with better camouflage, which is what
 * `scheduleSweep` exists to prevent — see the comment there.
 *
 * Known gap, accepted: a redirected request completes under its final URL while
 * the page reports the timing under the URL it originally asked for, so a
 * redirected chunked response settles by expiry rather than by measurement.
 * Chasing it would mean tracking every redirect chain to save a rounding error.
 *
 * One convention runs through all of it: **every size here is header-inclusive.**
 * `transferSize` is header-inclusive by definition, and `sizeModel` is trained on
 * header-inclusive figures from both commit paths — `settleTiming` below and
 * `priceCompleted` in `requests.ts`, which observes `headerDown + body`. So the
 * model's estimate is already a whole wire size and nothing may add a header block
 * to it. `commitEstimate` used to, and every estimated request was inflated by one
 * halved header block.
 */

import { ledger, type CommitEntry } from "./ledger";
import { sizeModel } from "./estimate";

/** How long a sizeless request waits for the page to report its size. */
const PENDING_TTL_MS = 8000;

/**
 * Slack on the sweep timer, so the entry at the head of the queue is genuinely
 * past its TTL when the sweep looks rather than a millisecond short of it.
 */
const SWEEP_SLACK_MS = 250;

/**
 * Cap on parked requests. A page that streams hundreds of responses and has no
 * content script — an extension page, a PDF viewer, a blocked-script origin —
 * would otherwise grow this without limit.
 */
const MAX_PENDING = 600;

interface Pending {
  matchKey: string;
  /** Everything except the body size, which is what we are waiting for. */
  entry: CommitEntry;
  /**
   * Bytes of response headers, holding `entry.down` up while the request waits.
   *
   * Not an addend. Both commit paths overwrite `entry.down` with a
   * header-inclusive figure — see the convention in the module header — so this
   * survives only as the floor under `commitEstimate`.
   */
  headerBytes: number;
  /** What to charge if nothing ever reports a size. Header-inclusive. */
  estimate: number;
  /**
   * When it was parked, on the same wall clock `expirePending` is given.
   *
   * A copy of `entry.at`, not a reference to it: a backwards clock step rebases
   * this, and `entry.at` is the timestamp the ledger files the row under.
   */
  at: number;
  settled: boolean;
}

/** Oldest first. Committed entries are dropped as they reach the front. */
const queue: Pending[] = [];

/**
 * `tabId|url` to the entries still waiting under it.
 *
 * Only ever holds live entries: one is spliced out the instant it is committed.
 * The first version left it in place behind a `settled` flag and deleted the
 * bucket only once every entry in it had settled — so a bucket outlived the page
 * it belonged to, and `settleTiming` would hand a measured size to a request from
 * a *previous* page in the same tab for any URL two pages share. Fonts, analytics
 * and CDN assets are shared by almost every page on a site.
 */
const index = new Map<string, Pending[]>();

/**
 * How many entries in `queue` are still waiting.
 *
 * Counted rather than derived, because the cap is tested on every parked request.
 * And it has to be this number rather than `queue.length`, which also counts
 * entries already committed and merely waiting to reach the front: measuring the
 * cap against that tripped it early, and then the whole force budget was spent
 * estimating requests parked milliseconds ago whose real sizes were still on their
 * way.
 */
let live = 0;

/** The timer that commits parked requests when no more traffic is coming. */
let sweep: ReturnType<typeof setTimeout> | null = null;

/**
 * The largest `now` any sweep has been handed.
 *
 * The TTL is measured against `Date.now()`, which is wall clock and can step
 * backwards: an NTP correction, a manual change, a laptop resuming with a stale
 * RTC. Then `now - pending.at` is negative for every parked entry, the age test is
 * never true again, and the only things that can still drain the queue are
 * `forgetTab`, `drainPending` and the cap — none of which is guaranteed to arrive
 * for a request parked as the last thing a page does. There is no monotonic clock
 * that survives a service-worker teardown, so the guard is to notice the step and
 * rebase the ages onto the new reading.
 */
let lastSweepNow = 0;

/** Drops the fragment: it is never sent, so it can only break a match. */
export function matchableUrl(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

function matchKeyFor(tabId: number, url: string): string {
  return `${tabId}|${matchableUrl(url)}`;
}

/**
 * Parks a request whose body size is unknown.
 *
 * `entry.down` should already hold the response header bytes, so a request torn
 * down before it can be committed is at least not worth zero. Both commit paths
 * then *replace* that figure with a header-inclusive one rather than adding to it
 * — see the convention in the module header.
 */
export function addPending(
  entry: CommitEntry,
  url: string,
  headerBytes: number,
  estimate: number,
): void {
  const matchKey = matchKeyFor(entry.tabId, url);
  const pending: Pending = { matchKey, entry, headerBytes, estimate, at: entry.at, settled: false };

  queue.push(pending);
  live += 1;
  const bucket = index.get(matchKey);
  if (bucket) bucket.push(pending);
  else index.set(matchKey, [pending]);

  if (live > MAX_PENDING) expirePending(Date.now(), Math.floor(MAX_PENDING / 2));
  scheduleSweep();
}

/**
 * Commits parked requests when their wait is up, without waiting for more traffic.
 *
 * This is load-bearing and was missing. Expiry used to happen only from the
 * pre-flush hook and the one-minute maintenance alarm, and neither can reach a
 * request parked as the last thing a page does. The flush two seconds later looks
 * too early — the eight-second TTL has not elapsed, so the entry is correctly left
 * alone — and then nothing looks again. The queue is plain module state, so when
 * Chrome tears the worker down after thirty idle seconds it goes with it, and the
 * alarm later wakes a *fresh* worker whose queue is empty. The request was not
 * estimated, it was lost, and precisely for the responses hardest to measure:
 * streamed bodies with no usable resource timing.
 *
 * A timer inside the TTL fires while this worker is still alive — eight seconds
 * against a thirty-second idle teardown — so the request is committed instead. The
 * flush that follows is what puts it on disk; nothing else is going to ask.
 */
function scheduleSweep(): void {
  if (sweep !== null || live === 0) return;
  sweep = setTimeout(() => {
    sweep = null;
    expirePending(Date.now());
    void ledger.flush();
    scheduleSweep();
  }, PENDING_TTL_MS + SWEEP_SLACK_MS);
}

function cancelSweep(): void {
  if (sweep === null) return;
  clearTimeout(sweep);
  sweep = null;
}

/**
 * Takes an entry out of the queue's bookkeeping. Does not record it.
 *
 * Split from recording because the two commit paths price the request
 * differently, and only one of them has a measurement to feed back into the size
 * model.
 */
function unpark(pending: Pending): void {
  pending.settled = true;
  live -= 1;
  const bucket = index.get(pending.matchKey);
  if (bucket) {
    const at = bucket.indexOf(pending);
    if (at >= 0) bucket.splice(at, 1);
    if (bucket.length === 0) index.delete(pending.matchKey);
  }
  if (live <= 0) {
    live = 0;
    cancelSweep();
  }
}

/**
 * Commits a parked request with the size model's guess, and says so.
 *
 * The estimate *replaces* `entry.down`; it is not added to the header bytes. The
 * model is trained on header-inclusive sizes at both of its inputs, so its output
 * is a whole wire size — adding a header block to it charged the same headers
 * twice and inflated every estimated request by one halved header block.
 *
 * The measured header block is kept as a floor. A model mean can sit below it on a
 * host that serves tiny bodies, and pricing a request under what was watched
 * crossing the wire is exactly the under-report `HEADER_WIRE_FACTOR` is
 * deliberately pessimistic to avoid.
 *
 * `estimatedDown` is then the whole figure, including the part that came from real
 * headers. That over-states the uncertainty by a few hundred bytes, which is the
 * safe direction: the alternative is a request claiming a measurement it does not
 * have.
 */
function commitEstimate(pending: Pending): void {
  unpark(pending);
  const entry = pending.entry;
  entry.down = Math.max(pending.estimate, pending.headerBytes);
  entry.estimatedDown = entry.down;
  ledger.record(entry);
}

/**
 * Settles a parked request with the size the page measured.
 *
 * `transferSize` already includes response headers, so it replaces our header
 * estimate rather than adding to it. Returns whether anything matched, which is
 * what tells the caller a timing report was useful rather than noise.
 */
export function settleTiming(tabId: number, url: string, transferSize: number): boolean {
  if (transferSize <= 0) return false;
  const bucket = index.get(matchKeyFor(tabId, url));
  // A miss is normal and not an error: most resources were already sized from a
  // `Content-Length`, so nothing was parked for them.
  if (!bucket) return false;

  // The oldest entry still waiting. Several identical URLs in one tab are the same
  // resource requested more than once, and any pairing of sizes to requests is as
  // good as another.
  const pending = bucket[0];
  if (!pending) return false;

  unpark(pending);
  const entry = pending.entry;
  entry.down = transferSize;
  entry.estimatedDown = 0;
  sizeModel.observe(entry.host, entry.type, transferSize);
  ledger.record(entry);
  return true;
}

/**
 * Moves every parked entry's age onto a clock that has jumped backwards.
 *
 * The TTL is a duration, so subtracting the step from each `at` preserves the age
 * each entry had a moment ago — an entry parked six seconds ago is still six
 * seconds old. Only `Pending.at` is touched: `entry.at` is the timestamp the
 * ledger keys the row by, and moving that would file the request in the wrong
 * hour of the day chart.
 */
function rebaseAges(skew: number): void {
  for (const pending of queue) pending.at -= skew;
}

/**
 * Commits requests that waited long enough, using the estimate.
 *
 * Also called with a `force` count when the queue is over its cap, in which case
 * the oldest entries are committed early rather than dropped — an early estimate
 * is worse than a measurement and much better than a missing request.
 */
export function expirePending(now: number, force = 0): void {
  if (now < lastSweepNow) rebaseAges(lastSweepNow - now);
  lastSweepNow = now;

  let expired = 0;
  while (queue.length > 0) {
    const pending = queue[0];
    if (!pending) break;
    // Already committed by a timing report; it only remains here until it reaches
    // the front, and it does not spend the force budget.
    if (pending.settled) {
      queue.shift();
      continue;
    }
    const tooOld = now - pending.at >= PENDING_TTL_MS;
    if (!tooOld && expired >= force) break;

    queue.shift();
    commitEstimate(pending);
    expired += 1;
  }

  if (live === 0) {
    index.clear();
    cancelSweep();
  }
}

/**
 * Commits everything parked, right now.
 *
 * For `runtime.onSuspend`. The queue is module state, so anything still waiting
 * when the worker is torn down is gone; an estimate is worse than the measurement
 * that was two seconds away and far better than a request that silently never
 * happened.
 */
export function drainPending(): void {
  expirePending(Date.now(), queue.length);
}

/** Charges everything parked for a tab that has gone away. */
export function forgetTab(tabId: number): void {
  const prefix = `${tabId}|`;
  // `commitEstimate` splices the index but leaves `queue` alone, so iterating it
  // here is safe.
  for (const pending of queue) {
    if (pending.settled || !pending.matchKey.startsWith(prefix)) continue;
    commitEstimate(pending);
  }
}

/** How many requests are still waiting for a size. */
export function pendingCount(): number {
  return live;
}

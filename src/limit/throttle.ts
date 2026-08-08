/**
 * A genuine download speed cap, for the throttle channel only.
 *
 * `chrome.debugger` + `Network.emulateNetworkConditions` is the one API that can
 * actually pace bytes rather than refuse them: it sets a throughput ceiling on a
 * tab, and the page's own adaptive-bitrate logic responds the way it would to a slow
 * connection — video steps down to a smaller representation and keeps playing,
 * rather than stopping. That is a better experience than blocking, and it is what
 * "limit the bandwidth of a website" actually means.
 *
 * It is not in the store build, for a reason worth writing down. Chrome does not
 * allow `debugger` as an optional permission
 * ([permissions list](https://developer.chrome.com/docs/extensions/reference/api/permissions)),
 * so it cannot be requested at runtime from the people who want it — it would be an
 * install-time warning for everyone, on an extension whose whole proposition is that
 * it is unobtrusive and local. And attaching shows Chrome's "an extension is
 * debugging this browser" banner, which cannot be suppressed and should not be.
 *
 * So: two channels. `dist/` refuses requests, `dist-throttle/` paces them. Every
 * function here compiles to nothing in the store build, because `__THROTTLE_BUILD__`
 * is a literal `false` and the bodies are unreachable.
 *
 * Two maps, and the split is the whole design. `desired` is what the budgets say the
 * tabs should be paced at, keyed by tab and carrying the site that asked; `attached`
 * is what Chrome is actually doing. Every pass computes the first and diffs it
 * against the second, so a tab already paced at the right rate is left alone. The
 * version before this one had only `attached` and no site key, so with two budgeted
 * sites each site's pass detached the other's tabs and the next pass reattached them
 * — an attach/detach cycle every sixty seconds, flashing a debugging banner that
 * cannot be suppressed at someone who set a speed limit and touched nothing since.
 */

const PROTOCOL_VERSION = "1.3";

/** What each tab should be paced at, and which budgeted site is asking. */
export interface ThrottleTarget {
  site: string;
  kbps: number;
}

/** Tabs currently attached, and the cap in bytes per second Chrome is applying. */
const attached = new Map<number, number>();

/** Tabs that should be paced. The site is kept so a per-site caller can retract only its own. */
const desired = new Map<number, ThrottleTarget>();

/** Serialises the diffs: two overlapping passes would detach what the other just attached. */
let chain: Promise<void> = Promise.resolve();

export function throttleAvailable(): boolean {
  return __THROTTLE_BUILD__ && typeof chrome !== "undefined" && Boolean(chrome.debugger);
}

/**
 * A kilobits-per-second setting as `Network.emulateNetworkConditions` wants it: bytes
 * per second, so 1000/8 = 125 per kbps.
 *
 * SI kilobits, not 1024 — that is the unit every carrier plan and speed test quotes,
 * and it is the unit the setting is labelled in. The factor is worth stating because
 * both ways of getting it wrong are silent: a missing /8 paces eight times too fast,
 * which is a cap in name only, and a 1024 paces 2.4% slow forever.
 */
export function bytesPerSecond(kbps: number): number {
  return Math.max(1, Math.round((kbps * 1000) / 8));
}

/**
 * Notices when something else takes a tab we were pacing.
 *
 * Opening DevTools on a paced tab detaches us. Without this the tab stays in
 * `attached` at its old rate, every later diff sees the cap already applied and sends
 * nothing, and the tab runs uncapped for the rest of the session while the UI still
 * says it is limited. Clearing the entry is enough: the tab is still in `desired`, so
 * the next pass reattaches if it can.
 *
 * Registered on first attach rather than at module scope because there is nothing to
 * correct until something is attached, and the map it keeps honest does not outlive
 * the worker either. Our own `detach()` lands here too; deleting twice costs nothing.
 */
let watchingDetach = false;

function watchDetach(): void {
  if (watchingDetach) return;
  watchingDetach = true;
  chrome.debugger.onDetach.addListener((source) => {
    if (typeof source.tabId === "number") attached.delete(source.tabId);
  });
}

async function attach(tabId: number): Promise<boolean> {
  watchDetach();
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
    return true;
  } catch (error) {
    // Already attached by DevTools, or the tab went away. Neither is worth
    // reporting to the person: they asked for a speed cap, not a debugger session.
    void error;
    return false;
  }
}

async function detach(tabId: number): Promise<void> {
  try {
    await chrome.debugger.sendCommand({ tabId }, "Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  } catch {
    // The tab may already be gone; detaching is what matters.
  }
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Never attached, or the tab closed first.
  }
  attached.delete(tabId);
}

/** Brings Chrome in line with `desired`, touching only the tabs that differ. */
async function reconcile(): Promise<void> {
  for (const tabId of [...attached.keys()]) {
    if (!desired.has(tabId)) await detach(tabId);
  }

  for (const [tabId, target] of desired) {
    const rate = bytesPerSecond(target.kbps);
    if (attached.get(tabId) === rate) continue;
    // A failed attach leaves the tab in `desired` on purpose: DevTools owning it is
    // usually temporary, and the next pass should get the cap back rather than give
    // up on it for the session.
    if (!attached.has(tabId) && !(await attach(tabId))) continue;
    try {
      await chrome.debugger.sendCommand({ tabId }, "Network.emulateNetworkConditions", {
        offline: false,
        // Left at zero: this is a data cap expressed as a rate, not a simulation of
        // a bad connection, and adding latency would make pages feel broken for a
        // reason the person did not ask for.
        latency: 0,
        downloadThroughput: rate,
        uploadThroughput: -1,
      });
      attached.set(tabId, rate);
    } catch {
      await detach(tabId);
    }
  }
}

function queue(): Promise<void> {
  chain = chain.then(reconcile, reconcile);
  return chain;
}

/**
 * Applies the whole desired state at once: every tab that should be paced, with the
 * site that asked for it.
 *
 * This is the one to call from a governor that knows all the budgets, because it is
 * the only version that can tell "no site wants this tab any more" from "the site
 * that wanted it was not in this call". A no-op without the `debugger` permission,
 * which is every store install.
 */
export async function syncThrottle(next: ReadonlyMap<number, ThrottleTarget>): Promise<void> {
  if (!throttleAvailable()) return;
  desired.clear();
  for (const [tabId, target] of next) {
    if (target.kbps > 0) desired.set(tabId, { site: target.site, kbps: target.kbps });
  }
  await queue();
}

/**
 * Applies one site's cap to the tabs showing it, leaving every other site's tabs alone.
 *
 * The per-site entry point, for a caller inside a loop over budgets. It only ever
 * retracts claims this site made, which is the whole difference from the version that
 * treated `attached` as the desired state: there, site B's pass saw site A's tabs as
 * unwanted and detached them.
 *
 * `syncThrottle` is the better shape where the caller has the full picture — a site
 * whose budget is deleted stops calling in here at all, and its tabs stay paced until
 * `clearAllThrottles`.
 */
export async function applyThrottleToTabs(
  site: string,
  kbps: number | null,
  tabIds: readonly number[],
): Promise<void> {
  if (!throttleAvailable()) return;

  // Zero means "this site wants no cap", which is a retraction, not a claim of no tabs.
  const rate = kbps !== null && kbps > 0 ? kbps : 0;
  const wanted = rate > 0 ? new Set(tabIds) : new Set<number>();

  for (const [tabId, target] of [...desired]) {
    if (target.site === site && !wanted.has(tabId)) desired.delete(tabId);
  }
  for (const tabId of wanted) desired.set(tabId, { site, kbps: rate });

  await queue();
}

export async function clearAllThrottles(): Promise<void> {
  if (!throttleAvailable()) return;
  desired.clear();
  await queue();
}

/** Tabs currently being paced, for the UI to disclose the banner honestly. */
export function throttledTabs(): number[] {
  return [...attached.keys()];
}

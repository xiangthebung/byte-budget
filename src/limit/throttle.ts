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
 */

const PROTOCOL_VERSION = "1.3";

/** Tabs currently attached, and the cap in bytes per second. */
const attached = new Map<number, number>();

export function throttleAvailable(): boolean {
  return __THROTTLE_BUILD__ && typeof chrome !== "undefined" && Boolean(chrome.debugger);
}

/** Kilobits per second as the protocol wants it: bytes per second. */
export function bytesPerSecond(kbps: number): number {
  return Math.max(1, Math.round((kbps * 1000) / 8));
}

async function attach(tabId: number): Promise<boolean> {
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

/**
 * Applies a site's cap to the tabs showing it, and lifts it from tabs that have
 * navigated away.
 *
 * A no-op without the `debugger` permission, which is every store install.
 */
export async function applyThrottleToTabs(
  site: string,
  kbps: number | null,
  tabIds: readonly number[],
): Promise<void> {
  if (!throttleAvailable()) return;
  void site;

  const wanted = new Set(tabIds);
  const target = kbps && kbps > 0 ? bytesPerSecond(kbps) : null;

  for (const tabId of [...attached.keys()]) {
    if (!wanted.has(tabId) || target === null) await detach(tabId);
  }
  if (target === null) return;

  for (const tabId of wanted) {
    if (attached.get(tabId) === target) continue;
    if (!attached.has(tabId) && !(await attach(tabId))) continue;
    try {
      await chrome.debugger.sendCommand({ tabId }, "Network.emulateNetworkConditions", {
        offline: false,
        // Left at zero: this is a data cap expressed as a rate, not a simulation of
        // a bad connection, and adding latency would make pages feel broken for a
        // reason the person did not ask for.
        latency: 0,
        downloadThroughput: target,
        uploadThroughput: -1,
      });
      attached.set(tabId, target);
    } catch {
      await detach(tabId);
    }
  }
}

export async function clearAllThrottles(): Promise<void> {
  if (!throttleAvailable()) return;
  for (const tabId of [...attached.keys()]) await detach(tabId);
}

/** Tabs currently being paced, for the UI to disclose the banner honestly. */
export function throttledTabs(): number[] {
  return [...attached.keys()];
}

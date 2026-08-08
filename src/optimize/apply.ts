/**
 * Turning the optimizer on: publishing the rules, and registering the page script.
 *
 * The content script is registered dynamically rather than declared in the manifest,
 * which is the whole reason the master switch is meaningful: with optimization off, no
 * code of ours runs on any page. A manifest-declared script would run everywhere and
 * check a setting, which is a different and worse promise.
 */

import { runtimeFile } from "../core/runtime";
import { publishRules } from "../rules/session";
import {
  activePageFeatures,
  anyPageFeature,
  getOptimizeSettings,
  type OptimizeSettings,
  type PageFeatureId,
} from "./features";
import { holdoutTabIds } from "./holdout";
import { optimizeRules, refusedTypes } from "./rules";
import { setRefusedTypes } from "./savings";

const SCRIPT_ID = "byte-budget-optimize";

let current: OptimizeSettings | null = null;

export function optimizeSettings(): OptimizeSettings | null {
  return current;
}

/** The page-side features a content script should apply, for it to ask for on load. */
export function pageFeatures(): PageFeatureId[] {
  return current ? activePageFeatures(current) : [];
}

/**
 * Brings rules, the registered script and the refusal set in line with the settings.
 *
 * Called at startup, whenever the settings change, and whenever the holdout tab set
 * changes. Idempotent.
 */
export async function applyOptimize(settings?: OptimizeSettings): Promise<number> {
  current = settings ?? (await getOptimizeSettings());
  setRefusedTypes(refusedTypes(current));

  const rules = optimizeRules({ settings: current, holdoutTabIds: holdoutTabIds() });
  await publishRules("optimize", rules);
  await syncContentScript(current);
  return rules.length;
}

async function syncContentScript(settings: OptimizeSettings): Promise<void> {
  let registered: chrome.scripting.RegisteredContentScript[] = [];
  try {
    registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  } catch {
    registered = [];
  }

  const wanted = anyPageFeature(settings);
  if (!wanted) {
    if (registered.length > 0) {
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      } catch {
        // Already gone.
      }
    }
    return;
  }

  const script: chrome.scripting.RegisteredContentScript = {
    id: SCRIPT_ID,
    js: [runtimeFile("optimize.js")],
    matches: ["http://*/*", "https://*/*"],
    /**
     * Always present, even when empty.
     *
     * `updateContentScripts` merges — a field left out keeps its previous value — so
     * omitting this when there is nothing to exclude does not clear the list, it
     * preserves it. Removing a site from the never-optimize list therefore appeared to
     * work everywhere except where it mattered: the site stayed excluded, and the only
     * symptom was that its pages were never optimized again.
     *
     * The excluded sites are enforced here as well as in the network rules. An opt-out
     * that stopped the rewrites but left the page being rearranged would not be one.
     */
    excludeMatches: settings.exclusions.flatMap(excludePatterns),
    runAt: "document_start",
    allFrames: true,
    persistAcrossSessions: true,
  };

  try {
    if (registered.length > 0) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
    scriptError = null;
  } catch (error) {
    // Recorded as well as logged. A failure here leaves the page optimizers silently
    // absent while the network rules carry on working, so the UI needs to be able to say
    // so rather than the only trace being a line in the worker's console.
    scriptError = error instanceof Error ? error.message : String(error);
    console.error("Byte Budget: could not register the page optimizer", error);
  }
}

let scriptError: string | null = null;

/** Why the page optimizer is not registered, if it should be and is not. */
export function pageScriptError(): string | null {
  return scriptError;
}

const IP_OR_SINGLE_LABEL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[^.]+)$/;

/**
 * Match patterns covering a site and its subdomains.
 *
 * Chrome rejects a `*.` wildcard in front of an IP address or a single-label host, and
 * `registerContentScripts` rejects the *whole* call when any pattern is invalid — so
 * excluding `127.0.0.1` left the page optimizer unregistered everywhere, with the
 * failure visible only in the worker's console. Hosts that cannot take a subdomain
 * wildcard get the bare pattern instead.
 *
 * Two syntaxes for one intent, which is why this is a named function: match patterns
 * need the wildcard spelled out, while `declarativeNetRequest`'s `initiatorDomains`
 * takes a bare domain and covers subdomains implicitly.
 */
function excludePatterns(site: string): string[] {
  if (IP_OR_SINGLE_LABEL.test(site)) return [`*://${site}/*`];
  return [`*://${site}/*`, `*://*.${site}/*`];
}

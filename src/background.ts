/**
 * The service worker: the only writer, and the only thing that talks to Chrome's
 * network events.
 *
 * Everything here is registered at the top level, synchronously. An MV3 worker is
 * started *by* an event, and a listener added inside a promise callback is a
 * listener that is not there yet when the event that woke the worker is
 * dispatched — which shows up as "the first request after every idle gap is
 * missing" and nothing else.
 */

import { bucketRange, clearAllUsage, getAll, STORES } from "./core/db";
import { formatBytesBadge } from "./core/format";
import { dayKey, retentionCutoff } from "./core/period";
import { runtimeFile } from "./core/runtime";
import { getSettings, onSettingsChanged, saveSettings } from "./core/settings";
import type { Envelope, ExtensionRequest } from "./core/messages";
import { emptyTotals, type Settings, type UsageRow } from "./core/types";
import {
  checkAllowanceAlerts,
  clearAlertHistory,
  getAlertSettings,
  isAlertNotification,
  saveAlertSettings,
} from "./limit/alerts";
import {
  grantBytes,
  putBudget,
  removeBudget,
  resumeBudget,
  snoozeBudget,
  type BudgetPeriod,
  type BudgetShape,
} from "./limit/budgets";
import {
  clearEnforcement,
  enforcementSnapshot,
  ensureEnforcementReady,
  refreshEnforcementTabs,
  setEnforcement,
} from "./limit/enforce";
import {
  budgetStatuses,
  budgetsChanged,
  currentPeriodKey,
  forgetAnnouncedTab,
  noteUsage,
  noticeForTab,
  refreshWindows,
  resetCounters,
  startGovernor,
  syncEnforcement,
} from "./limit/governor";
import { isTier } from "./limit/tiers";
import { applyOptimize, optimizeSettings as applied, pageFeatures } from "./optimize/apply";
import { getOptimizeSettings, optimizes, saveOptimizeSettings } from "./optimize/features";
import {
  decideHoldout,
  ensureHoldoutReady,
  isHoldoutTab,
  noteVisitOutcome,
  refreshHoldoutStats,
  setTabHoldout,
} from "./optimize/holdout";
import { savingsReport } from "./optimize/report";
import { pruneBaselines } from "./optimize/savings";
import { ruleCounts } from "./rules/session";
import { sizeModel } from "./track/estimate";
import { ledger, pruneOldRows } from "./track/ledger";
import { drainPending, expirePending, forgetTab, settleTiming } from "./track/reconcile";
import { registerRequestListeners, sweepUploads } from "./track/requests";
import { siteKeyFromUrl } from "./core/sites";
import {
  closeTab,
  ensureTabsReady,
  noteNavigation,
  resetOpenVisits,
  setOptimizedResolver,
  setVisitObserver,
  tabIdsForSite,
  tabRecord,
} from "./track/tabs";
import { dailySeries, exportData, overview, siteDetail, storageReport } from "./track/stats";

const MAINTENANCE_ALARM = "maintenance";
const PRUNE_ALARM = "prune";

/* ------------------------------------------------------------------ *
 * Network observation
 * ------------------------------------------------------------------ */

ledger.setPreFlush(() => expirePending(Date.now()));
ledger.setUsageObserver(noteUsage);
setOptimizedResolver((site, tabId) => {
  const settings = optimizeSettingsSnapshot();
  return Boolean(settings) && optimizes(settings!, site) && !isHoldoutTab(tabId);
});
setVisitObserver(noteVisitOutcome);
registerRequestListeners();
startGovernor();

/**
 * The optimizer settings as last applied.
 *
 * Read synchronously in `onBeforeNavigate` and when a visit starts, both of which have
 * to decide immediately. `null` until `applyOptimize` has run once, and `null` means
 * "do nothing", which is the safe answer for both callers.
 */
function optimizeSettingsSnapshot() {
  return applied();
}

/**
 * Enforcement readiness first, and awaited.
 *
 * Both publishers go through `rules/session.ts`, whose `install()` removes every
 * session rule Chrome holds before adding back the set it composes from module
 * memory. On a cold worker that memory is empty, and with Data Saver shipping off
 * `applyOptimize` composes nothing at all — so an unordered start has the worker's
 * first act be deleting every limit rule and installing none. `ensureEnforcementReady`
 * republishes what the restored decisions imply; awaiting it here is what stops the
 * two racing.
 *
 * It is also loaded eagerly for its own sake: the `onErrorOccurred` handler has to
 * decide whether a refused request was this extension's doing, and it should not have
 * to wait to find out.
 */
const optimizeReady = ensureEnforcementReady().then(() => applyOptimize());
void ensureHoldoutReady();

/**
 * The holdout decision, taken before the document request goes out.
 *
 * `onBeforeNavigate` rather than `onCommitted` because a control load has to be
 * genuinely unoptimized from its first subresource. Deciding after the commit would
 * leave the first requests already rewritten, which would not fail — it would quietly
 * make the control group slightly optimized and the comparison meaningless.
 *
 * Synchronous apart from the rule install, which happens while the document is still in
 * flight. And almost always a no-op: `setTabHoldout` reports whether the set actually
 * changed, and for the vast majority of loads it does not.
 */
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  const settings = optimizeSettingsSnapshot();
  if (!settings) return;
  const site = siteKeyFromUrl(details.url);
  const decision = site ? decideHoldout(site, settings) : { hold: false as const };
  if (setTabHoldout(details.tabId, decision.hold)) void applyOptimize(settings);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  // Top-level only. A subframe navigating does not change which site the tab is
  // showing, and treating it as a new page load would end the visit that the
  // subframe belongs to.
  if (details.frameId !== 0) return;
  // The banner went with the old document, so whatever this tab was told no longer
  // exists on screen. Forgetting it here is what lets a reload of an already-limited
  // site be told again, instead of the tier looking unchanged and the new page being
  // left to look broken on its own.
  forgetAnnouncedTab(details.tabId);
  void noteNavigation(details.tabId, details.url).then(syncEnforcementTabs);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // Order matters: the parked requests are charged first, while the tab record
  // still exists to attribute them to.
  forgetTab(tabId);
  forgetAnnouncedTab(tabId);
  if (setTabHoldout(tabId, false)) void applyOptimize();
  void closeTab(tabId).then(syncEnforcementTabs);
});

/**
 * Keeps the tab-scoped half of the enforcement rules pointing at the right tabs.
 *
 * Rules are scoped by tab id because that is how bytes are attributed, so a tab
 * navigating away from a limited site has to stop being limited, and a second tab
 * opening the same site has to start. Cheap: it returns immediately when nothing
 * is being enforced, which is the normal case.
 */
function syncEnforcementTabs(): void {
  // Two steps, and the order matters. The rules are re-scoped first so a tab that
  // just navigated onto a limited site is covered immediately; the governor then
  // re-evaluates, which is what shows the banner in that tab.
  //
  // Caught rather than left to `void`: a rejected rule install here would otherwise
  // be an unhandled rejection, and the next navigation retries anyway.
  void refreshEnforcementTabs(tabIdsForSite)
    .then(() => syncEnforcement())
    .catch((error: unknown) => {
      console.error("Byte Budget: could not re-scope the limit rules", error);
    });
}

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  forgetTab(removedTabId);
  forgetAnnouncedTab(removedTabId);
  void closeTab(removedTabId);
  void ensureTabsReady().then(() => refreshTab(addedTabId));
});

async function refreshTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) await noteNavigation(tabId, tab.url);
  } catch {
    // The tab went away between the event and this call.
  }
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener((details) => {
  void setUpAlarms();
  void ensureTabsReady();
  // A newly installed or updated extension has no content script in any page that
  // is already open, so until each is reloaded every streamed response there would
  // fall back to an estimate. Injecting once closes that gap immediately.
  if (details.reason === "install" || details.reason === "update") {
    void injectIntoOpenTabs();
  }
});

chrome.runtime.onStartup.addListener(() => {
  void setUpAlarms();
  void ensureTabsReady();
});

chrome.runtime.onSuspend.addListener(() => {
  // Not guaranteed to run, which is why the flush debounce is two seconds rather
  // than something that would rely on this.
  //
  // Parked requests are drained rather than left to expire on their own schedule:
  // there is no next worker for them to expire in, since the queue is module state.
  // `reconcile`'s own sweep timer normally gets there first; this is the case where
  // the browser is closing.
  drainPending();
  void ledger.flush();
});

async function setUpAlarms(): Promise<void> {
  try {
    await ensureAlarm(MAINTENANCE_ALARM, 1);
    await ensureAlarm(PRUNE_ALARM, 360);
  } catch (error) {
    // Swallowed rather than rejected: all three callers are fire-and-forget, and an
    // unhandled rejection in a worker's top level is a line nobody sees attached to a
    // stack that says nothing.
    console.error("Byte Budget: could not set up the alarms", error);
  }
}

/**
 * Creates an alarm only if it is missing.
 *
 * `alarms.create` on an existing name *replaces* it, which restarts its period. That
 * is harmless from `onInstalled`/`onStartup`, which fire once, and not harmless from
 * the top level: a worker that wakes more often than once a minute would push the
 * maintenance alarm's next firing out on every wake, and the flush backstop, the
 * budget rollover and the snooze expiry would simply never run.
 */
async function ensureAlarm(name: string, periodInMinutes: number): Promise<void> {
  // Typed as always resolving to an `Alarm`; it resolves to `undefined` when there is
  // no alarm by that name, which is the entire question being asked here.
  const existing: chrome.alarms.Alarm | undefined = await chrome.alarms.get(name);
  if (existing) return;
  await chrome.alarms.create(name, { periodInMinutes });
}

/**
 * Asserted here, not only from `onInstalled` and `onStartup`.
 *
 * Those two fire once per install and once per browser start; if an alarm is ever
 * lost in between — and both calls were `void`ed with no catch, so a failure was
 * silent — nothing recreates it until the browser is restarted, and the flush
 * backstop, retention pruning, window rollover and snooze expiry go with it.
 */
void setUpAlarms();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MAINTENANCE_ALARM) void maintenance();
  if (alarm.name === PRUNE_ALARM) void prune();
});

/**
 * The backstop.
 *
 * Requests keep the worker alive, so the debounced flush normally does all the
 * work. This covers the case where traffic stops right after a request is parked:
 * the flush timer may be cut short by the worker being torn down, and the parked
 * request would then sit in `chrome.storage.session`-less memory. Waking once a
 * minute to expire and write costs nothing measurable and removes that hole.
 */
async function maintenance(): Promise<void> {
  await ensureTabsReady();
  expirePending(Date.now());
  await ledger.flush();
  // Also what makes a budget window roll over at midnight, a snooze expire, and a
  // granted allowance evaporate — none of which needs a timer of its own.
  await refreshWindows();
  // And what keeps the holdout counts honest: they are read synchronously when a
  // navigation starts, so they cannot be fetched on demand.
  await refreshHoldoutStats();
  // The upload mirror is the one store nothing else revisits. A large upload that is
  // cancelled, or whose tab dies mid-body, leaves an entry no completion event will
  // ever claim — bounded by the browser session, but only because this sweeps it.
  await sweepUploads();
  // After the rollover above, never before it: an alert composed against a window that
  // has already reset would name a figure nothing on any surface agrees with.
  await raiseAlerts();
  await updateBadge();
}

/**
 * Offers every budget's live numbers to the alerting module.
 *
 * Not a timer of its own — it rides the maintenance alarm that already rolls the windows
 * over — and not the whole story either. The low-latency call belongs inside
 * `governor.syncEnforcement`, which computes the same share on the request path and can
 * therefore speak within a second of a threshold rather than within a minute; this is
 * what makes alerting reachable while that lands, and it stays useful afterwards because
 * a window can roll over or a snooze expire with no traffic at all to notice it.
 *
 * `checkAllowanceAlerts` deduplicates per window, so the two paths cannot produce two
 * copies of the same alert.
 */
async function raiseAlerts(): Promise<void> {
  const statuses = await budgetStatuses();
  if (statuses.length === 0) return;
  const { units } = await getSettings();
  await checkAllowanceAlerts(
    statuses.map((status) => ({
      site: status.budget.site,
      used: status.used,
      allowance: status.allowance,
      periodKey: status.periodKey,
      resetsAt: status.resetsAt,
    })),
    units,
  );
}

/**
 * Registered at the top level like every other listener in this file: a notification
 * click can be the event that wakes the worker, and a listener added inside a promise
 * callback is not there yet when the event that woke it is dispatched.
 *
 * Guarded because the namespace is absent in a build that does not declare the
 * permission, and a throw at the top level of a service worker takes down every listener
 * after it, not just this one.
 */
if (chrome.notifications) {
  chrome.notifications.onClicked.addListener((id) => {
    if (!isAlertNotification(id)) return;
    // Cleared explicitly: Chrome leaves a clicked notification in the tray on some
    // platforms, and an alert that stays on screen after it has been acted on reads as
    // a second one.
    void chrome.notifications.clear(id);
    void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });
}

async function prune(): Promise<void> {
  const settings = await getSettings();
  await pruneOldRows(retentionCutoff(settings.retentionDays), dayKey());
  await sizeModel.prune();
  await sizeModel.flush();
  await pruneBaselines();
}

async function injectIntoOpenTabs(): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || tab.id < 0) return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: [runtimeFile("timing.js")],
        });
      } catch {
        // Chrome Web Store pages, PDF viewers and other restricted origins refuse
        // injection. They are still counted through `webRequest`, just estimated.
      }
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Badge
 * ------------------------------------------------------------------ */

async function updateBadge(settings?: Settings): Promise<void> {
  const resolved = settings ?? (await getSettings());
  if (resolved.badge === "off") {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  const totals = emptyTotals();
  if (resolved.badge === "session") {
    const session = await ledger.sessionUsage();
    for (const delta of Object.values(session.sites)) {
      totals.down += delta.down;
      totals.up += delta.up;
    }
  } else {
    const today = dayKey();
    for (const row of await getAll<UsageRow>(STORES.daily, bucketRange(today, today))) {
      totals.down += row.down;
      totals.up += row.up;
    }
  }

  await chrome.action.setBadgeBackgroundColor({ color: "#0f6a62" });
  await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  await chrome.action.setBadgeText({
    text: formatBytesBadge(totals.down + totals.up, resolved.units),
  });
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

void getSettings().then((settings) => {
  ledger.setTrackHosts(settings.trackHosts);
  void updateBadge(settings);
});

onSettingsChanged((settings) => {
  ledger.setTrackHosts(settings.trackHosts);
  void updateBadge(settings);
});

/* ------------------------------------------------------------------ *
 * Messaging
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message as ExtensionRequest, sender)
    .then((payload) => sendResponse({ ok: true, ...payload } satisfies Envelope<object>))
    .catch((error: unknown) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Something went wrong.",
      } satisfies Envelope<object>),
    );
  return true;
});

async function handle(
  request: ExtensionRequest,
  sender: chrome.runtime.MessageSender,
): Promise<object> {
  switch (request.type) {
    case "REPORT_TIMINGS": {
      const tabId = sender.tab?.id ?? -1;
      if (tabId >= 0) {
        for (const entry of request.entries) {
          settleTiming(tabId, entry.url, entry.transferSize);
        }
      }
      return {};
    }

    case "GET_OVERVIEW": {
      // Flushed first so an open popup can never show a total that is behind the
      // traffic it is watching. Parked requests are deliberately *not* forced to
      // expire here: a measurement two seconds away beats an estimate now, and a
      // committed estimate cannot be corrected later.
      await ledger.flush();
      return overview(request.period, await getSettings());
    }

    case "GET_SITE": {
      await ledger.flush();
      return siteDetail(request.site, request.period, await getSettings());
    }

    case "GET_SERIES": {
      await ledger.flush();
      return { points: await dailySeries(request.days) };
    }

    case "GET_SETTINGS":
      return { settings: await getSettings() };

    case "SAVE_SETTINGS": {
      const settings = await saveSettings(request.changes);
      ledger.setTrackHosts(settings.trackHosts);
      await updateBadge(settings);
      return { settings };
    }

    case "GET_ALERTS":
      return { alerts: await getAlertSettings() };

    case "SAVE_ALERTS": {
      // No rules to rebuild and nothing to re-evaluate: the next pass reads the
      // preference, and the per-window record is deliberately untouched. Switching
      // per-site alerts on at 95% should say so at 95%, not replay 75% and 90%.
      const alerts = await saveAlertSettings(request.changes);
      return { alerts };
    }

    case "GET_STORAGE_REPORT": {
      await ledger.flush();
      return storageReport();
    }

    case "EXPORT": {
      await ledger.flush();
      return exportData(request.format, request.days);
    }

    case "CLEAR_DATA": {
      await ledger.flush();
      await clearAllUsage();
      await ledger.resetSession();
      // Open tabs hold their own running counters, and the next flush would write
      // them back into the visits store that was just emptied.
      resetOpenVisits();
      // Same argument for the size model. `clearAllUsage` empties its store, and an
      // observation is recorded usage, but the model is held in memory for the whole
      // life of the worker — so without this the next request rewrote its key with
      // every sample it had ever seen.
      sizeModel.reset();
      // Budgets are settings and survive, but their windows restart from zero —
      // otherwise a site would stay limited on the strength of usage that no longer
      // exists anywhere.
      await resetCounters();
      // After the governor, not before: it is what walks the budgeted sites back to
      // `off` and withdraws their banners. This then drops anything it does not know
      // about — a site whose budget was removed while it was being enforced, or an
      // entry restored from the session mirror with no budget behind it any more.
      // Rules outliving the usage they were derived from is the case where someone
      // deletes everything and the browser stays broken.
      await clearEnforcement();
      // The record of which thresholds have already been announced goes with the usage
      // it was derived from. `resetCounters` above has just put every window back to
      // zero, so a kept record would mean climbing through 75% and 90% again in total
      // silence — for the rest of the window, which on a monthly budget is up to a
      // month. The alert preferences are settings and stay, like the budgets do.
      await clearAlertHistory();
      await updateBadge();
      return {};
    }

    case "SET_ENFORCEMENT": {
      if (!isTier(request.tier)) throw new Error(`Unknown tier: ${String(request.tier)}`);
      await ensureTabsReady();
      const { rules } = await setEnforcement(
        request.site,
        request.tier,
        tabIdsForSite(request.site),
      );
      return { rules, enforcement: enforcementSnapshot() };
    }

    case "GET_ENFORCEMENT": {
      await ensureEnforcementReady();
      return { enforcement: enforcementSnapshot() };
    }

    case "GET_BUDGETS":
      return { statuses: await budgetStatuses() };

    case "PUT_BUDGET": {
      if (!request.site) throw new Error("Which site is the limit for?");
      if (!Number.isFinite(request.bytes) || request.bytes <= 0) {
        throw new Error("Give the limit a size.");
      }
      await putBudget({
        site: request.site,
        bytes: request.bytes,
        period: request.period as BudgetPeriod,
        ...(request.shape ? { shape: request.shape as BudgetShape } : {}),
        ...(request.kbps ? { kbps: request.kbps } : {}),
      });
      await budgetsChanged();
      return { statuses: await budgetStatuses() };
    }

    case "REMOVE_BUDGET": {
      await removeBudget(request.site);
      await budgetsChanged();
      return { statuses: await budgetStatuses() };
    }

    case "SNOOZE_BUDGET": {
      await snoozeBudget(request.site, Math.max(1, request.minutes));
      await budgetsChanged();
      return { statuses: await budgetStatuses() };
    }

    case "RESUME_BUDGET": {
      await resumeBudget(request.site);
      await budgetsChanged();
      return { statuses: await budgetStatuses() };
    }

    case "GRANT_BYTES": {
      await grantBytes(request.site, request.bytes, await currentPeriodKey(request.site));
      await budgetsChanged();
      return { statuses: await budgetStatuses() };
    }

    case "GET_TAB_NOTICE": {
      const tabId = sender.tab?.id ?? -1;
      if (tabId < 0) return { notice: null };
      await ensureTabsReady();
      const site = tabRecord(tabId)?.site;
      return { notice: site ? await noticeForTab(site) : null };
    }

    case "OPEN_DASHBOARD": {
      await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
      return {};
    }

    case "GET_OPTIMIZE": {
      const optimize = await getOptimizeSettings();
      return { optimize, rules: ruleCounts().optimize };
    }

    case "SAVE_OPTIMIZE": {
      const optimize = await saveOptimizeSettings(request.changes);
      const rules = await applyOptimize(optimize);
      return { optimize, rules };
    }

    case "SET_SITE_OPTIMIZE": {
      const current = await getOptimizeSettings();
      const exclusions = request.optimize
        ? current.exclusions.filter((site) => site !== request.site)
        : [...new Set([...current.exclusions, request.site])];
      const optimize = await saveOptimizeSettings({ exclusions });
      const rules = await applyOptimize(optimize);
      return { optimize, rules };
    }

    case "GET_SAVINGS": {
      await ledger.flush();
      return savingsReport(request.days);
    }

    case "GET_PAGE_FEATURES": {
      await optimizeReady;
      const tabId = sender.tab?.id ?? -1;
      const settings = optimizeSettingsSnapshot();
      const site = siteKeyFromUrl(sender.tab?.url ?? sender.url ?? "");
      const enabled =
        tabId >= 0 &&
        settings !== null &&
        site !== null &&
        optimizes(settings, site) &&
        !isHoldoutTab(tabId);
      return { features: enabled ? pageFeatures() : [] };
    }

    default: {
      /**
       * Reachable in the wild, not only in theory: `timing.js` and `notice.js` both
       * survive an extension update in every tab that is already open, so a content
       * script from the previous build can send a message this build has never heard
       * of. Without this the switch fell out returning `undefined`, the listener
       * spread that into `{ok: true}`, and the sender got a success envelope with
       * every field missing — which fails somewhere else entirely, as a null read.
       *
       * The `never` binding is the other half: it makes adding a request type without
       * handling it a compile error rather than a runtime one.
       */
      const unhandled: never = request;
      throw new Error(`Unknown request: ${(unhandled as { type?: string }).type ?? "(none)"}`);
    }
  }
}

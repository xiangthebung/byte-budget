/**
 * Which site each tab is showing, and where one page load ends and the next
 * begins.
 *
 * This is the piece that makes the numbers mean anything: a request carries a
 * `tabId`, and the site it should be charged to is whatever that tab has
 * committed at the top level (PLAN.md §1.3).
 *
 * The map is mirrored into `chrome.storage.session` because the service worker is
 * torn down after thirty idle seconds and the next request that wakes it must
 * still know which site the tab it came from is showing. An in-memory map alone
 * would silently reattribute every long-lived tab to `#background` after the
 * first idle gap, which is the kind of bug that looks like "the numbers seem
 * low" rather than like a crash.
 */

import { put, STORES } from "../core/db";
import { originFromUrl, siteKeyFromUrl } from "../core/sites";
import type { Visit } from "../core/types";

const SESSION_KEY = "tabs";

export interface TabRecord {
  tabId: number;
  site: string;
  origin: string;
  /** Id of the visit currently accumulating bytes for this tab. */
  visitId: string;
  startedAt: number;
  /** Set once the page load is over. Absent while it is still in flight. */
  endedAt?: number;
  down: number;
  up: number;
  requests: number;
  /** Phase 3: were optimizers active for this load. */
  optimized: boolean;
  saved: number;
  /** Set when the stored visit row is behind these counters. */
  dirty: boolean;
  /** Whether a row for this visit has been written yet. */
  stored: boolean;
}

const tabs = new Map<number, TabRecord>();

/**
 * Page loads that have ended, keyed by visit id.
 *
 * A request is priced when it finishes, and a chunked one up to eight seconds
 * later still — see `reconcile`. By then its tab may have committed another page,
 * and the bytes belong to the load that asked for them, not to whatever is on
 * screen when the number finally arrives. So a finished load stays addressable for
 * a while, and late bytes are written back to its own row.
 *
 * Bounded: this is a courtesy for requests in flight across a navigation, not a
 * history. Sixty-four covers the parked-request TTL through a burst of tab closes.
 */
const retired = new Map<string, TabRecord>();
const MAX_RETIRED = 64;

let ready: Promise<void> | null = null;
let persistQueued = false;

/**
 * Hooks, so this module stays ignorant of optimization.
 *
 * A visit has to record whether optimizers were active for it, because that flag is
 * what the whole savings comparison rests on. But "was this load optimized" is a
 * question for `optimize/`, and importing it here — when it already reads visits to
 * decide holdouts — would be a cycle. So the answer is injected.
 */
let optimizedResolver: ((site: string, tabId: number) => boolean) | null = null;
let visitObserver: ((site: string, optimized: boolean, at: number) => void) | null = null;

export function setOptimizedResolver(fn: (site: string, tabId: number) => boolean): void {
  optimizedResolver = fn;
}

export function setVisitObserver(fn: (site: string, optimized: boolean, at: number) => void): void {
  visitObserver = fn;
}

function newVisitId(): string {
  return crypto.randomUUID();
}

function makeRecord(tabId: number, site: string, origin: string): TabRecord {
  return {
    tabId,
    site,
    origin,
    visitId: newVisitId(),
    startedAt: Date.now(),
    down: 0,
    up: 0,
    requests: 0,
    // Resolved once, at the start of the load, and not revisited. A load that was
    // optimized for its first half and not its second belongs on neither side of the
    // comparison, so the flag is fixed when the page load is.
    optimized: optimizedResolver ? optimizedResolver(site, tabId) : false,
    saved: 0,
    dirty: false,
    stored: false,
  };
}

/** Keeps a finished load addressable for the requests still settling against it. */
function retire(record: TabRecord): void {
  // Re-inserted rather than updated in place, so the map's insertion order stays
  // the eviction order.
  retired.delete(record.visitId);
  retired.set(record.visitId, record);
  while (retired.size > MAX_RETIRED) {
    const oldest = retired.keys().next();
    if (oldest.done) break;
    retired.delete(oldest.value);
  }
}

function visitFrom(record: TabRecord, endedAt?: number): Visit {
  return {
    id: record.visitId,
    site: record.site,
    origin: record.origin,
    tabId: record.tabId,
    startedAt: record.startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    down: record.down,
    up: record.up,
    requests: record.requests,
    optimized: record.optimized,
    saved: record.saved,
  };
}

/**
 * Loads the mirrored map, then reconciles it against the tabs that actually
 * exist.
 *
 * Both directions matter. Tabs closed while the worker was asleep leave records
 * that would otherwise keep a dead `tabId` mapped — and Chrome reuses ids. Tabs
 * opened before the extension was installed or enabled are not in the mirror at
 * all, and without this pass their traffic would be charged to `#background`
 * until the person happened to reload them.
 */
export function ensureTabsReady(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      const stored = await chrome.storage.session.get(SESSION_KEY);
      const records = stored[SESSION_KEY] as TabRecord[] | undefined;
      for (const record of records ?? []) {
        if (record && typeof record.tabId === "number") tabs.set(record.tabId, record);
      }
    } catch {
      // A missing session store is not worth failing startup over; the query
      // below rebuilds what matters.
    }

    try {
      const open = await chrome.tabs.query({});
      const live = new Set<number>();
      for (const tab of open) {
        if (tab.id === undefined || tab.id < 0) continue;
        live.add(tab.id);
        const site = tab.url ? siteKeyFromUrl(tab.url) : null;
        const origin = tab.url ? originFromUrl(tab.url) : null;
        if (!site || !origin) continue;
        const existing = tabs.get(tab.id);
        if (existing?.site === site) continue;
        tabs.set(tab.id, makeRecord(tab.id, site, origin));
      }
      for (const tabId of [...tabs.keys()]) {
        if (!live.has(tabId)) tabs.delete(tabId);
      }
    } catch {
      // No `tabs` access yet, or the browser is shutting down. Attribution falls
      // back to `#background`, which is visible in the UI rather than silent.
    }

    queuePersist();
  })();
  return ready;
}

function queuePersist(): void {
  if (persistQueued) return;
  persistQueued = true;
  // Coalesced: a window opening restores a dozen tabs in one turn of the event
  // loop, and that should be one write.
  queueMicrotask(() => {
    persistQueued = false;
    void chrome.storage.session.set({ [SESSION_KEY]: [...tabs.values()] }).catch(() => undefined);
  });
}

export function tabRecord(tabId: number): TabRecord | undefined {
  return tabs.get(tabId);
}

/**
 * Charges bytes to the page load that asked for them.
 *
 * The `visitId` is not decoration. This used to take a `tabId` alone and credit
 * whatever that tab was showing at the moment the request was priced — which for a
 * chunked response is up to eight seconds after it finished, comfortably long
 * enough for the person to have clicked a link. Those bytes then landed on the
 * *next* page's row. Nothing looked wrong, because the period totals are keyed by
 * site and stayed correct; `visits` quietly became the wrong shape instead. And
 * `visits` is the only input to the optimizer's on-versus-off comparison, so the
 * error correlated with the very thing being measured.
 *
 * A request with no visit — no tab record existed when it was priced — is counted
 * in the period totals and left out of the visit rows, rather than guessed at.
 */
export function addTabBytes(
  tabId: number,
  visitId: string | null,
  down: number,
  up: number,
  requests: number,
): void {
  const record = visitRecord(tabId, visitId);
  if (!record) return;
  record.down += down;
  record.up += up;
  record.requests += requests;
  record.dirty = true;
}

function visitRecord(tabId: number, visitId: string | null): TabRecord | undefined {
  if (!visitId) return undefined;
  const live = tabs.get(tabId);
  if (live && live.visitId === visitId) return live;
  return retired.get(visitId);
}

/**
 * A top-level navigation committed: the previous page load is over.
 *
 * Called for every committed main-frame navigation, including one to the same
 * site, because the unit here is a page load. Phase 3 compares mean bytes per
 * page load with optimizers on and off, and that comparison is only sound if
 * both sides count the same thing.
 */
export async function noteNavigation(tabId: number, url: string): Promise<void> {
  await ensureTabsReady();
  const site = siteKeyFromUrl(url);
  const origin = originFromUrl(url);

  const previous = tabs.get(tabId);

  // The new record is installed before the previous visit is written, and that
  // order matters. `finishVisit` awaits an IndexedDB write, and the document's own
  // `onCompleted` arrives just after `onCommitted` — so with the write first, the
  // request that *is* the new page was priced while the old page's record was still
  // the one installed, along with every subresource that beat the write to disk.
  if (site && origin) {
    tabs.set(tabId, makeRecord(tabId, site, origin));
  } else {
    // A `chrome://` or `file://` page. Forget the tab rather than leaving the old
    // site mapped, or the new page's subresources would be charged to it.
    tabs.delete(tabId);
  }
  queuePersist();

  if (previous) await finishVisit(previous, Date.now());
}

export async function closeTab(tabId: number): Promise<void> {
  const record = tabs.get(tabId);
  if (!record) return;
  tabs.delete(tabId);
  queuePersist();
  await finishVisit(record, Date.now());
}

async function finishVisit(record: TabRecord, endedAt: number): Promise<void> {
  record.endedAt = endedAt;
  // Retired even when there is nothing to write, because a request parked while
  // this load was open can still arrive and give it a size.
  retire(record);

  // A page load that cost nothing measurable is not worth a row; it is usually a
  // redirect hop or a tab restored but never rendered.
  if (record.down <= 0 && record.up <= 0) return;
  record.dirty = false;
  record.stored = true;
  await put(STORES.visits, visitFrom(record, endedAt));
  visitObserver?.(record.site, record.optimized, record.startedAt);
}

/**
 * Writes visits that have changed since the last call.
 *
 * Called from the ledger flush, so a worker that is killed mid-page-load loses at
 * most a few seconds of one visit rather than the whole thing. Finished loads are
 * included: a chunked request settled after the navigation adds bytes to a row that
 * was already written, and it has to be written again for those bytes to exist
 * anywhere.
 */
export async function persistOpenVisits(): Promise<void> {
  const open = [...tabs.values()].filter((record) => record.dirty);
  const late = [...retired.values()].filter((record) => record.dirty);
  if (open.length === 0 && late.length === 0) return;

  // A finished load that had nothing to write when it ended, and only became worth
  // a row through late bytes, still owes the holdout accounting its outcome.
  const unannounced = late.filter((record) => !record.stored);

  for (const record of [...open, ...late]) {
    record.dirty = false;
    record.stored = true;
  }
  await Promise.all([
    ...open.map((record) => put(STORES.visits, visitFrom(record))),
    ...late.map((record) => put(STORES.visits, visitFrom(record, record.endedAt))),
  ]);
  for (const record of unannounced) {
    visitObserver?.(record.site, record.optimized, record.startedAt);
  }
  queuePersist();
}

/** Snapshot for the dashboard's live view. */
export function openTabRecords(): TabRecord[] {
  return [...tabs.values()];
}

/**
 * Tabs currently showing a site, sorted so the list is comparable.
 *
 * Enforcement rules are scoped by tab id because that is how bytes are attributed
 * — see `limit/rules.ts`. Sorted because the caller decides whether to reinstall
 * rules by comparing this against the previous list.
 */
export function tabIdsForSite(site: string): number[] {
  const ids: number[] = [];
  for (const record of tabs.values()) {
    if (record.site === site) ids.push(record.tabId);
  }
  return ids.sort((a, b) => a - b);
}

/**
 * Zeroes the counters on every open tab and starts a fresh visit for each.
 *
 * Called after "delete all recorded usage". Without it, the visit rows are deleted
 * from the database and then written straight back by the next flush, because the
 * in-memory records still hold everything the tab had accumulated — so the button
 * would appear not to work on whatever page was open at the time.
 */
export function resetOpenVisits(): void {
  // Finished loads go too. They exist so late bytes can find their own row, and
  // after a clear there is no row of theirs left to find — writing one back would
  // be the same bug as the open tabs, one navigation older.
  retired.clear();
  for (const record of tabs.values()) {
    record.visitId = newVisitId();
    record.startedAt = Date.now();
    delete record.endedAt;
    record.down = 0;
    record.up = 0;
    record.requests = 0;
    record.saved = 0;
    record.dirty = false;
    record.stored = false;
  }
  queuePersist();
}

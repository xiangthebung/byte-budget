/**
 * The ledger: where a finished request's bytes are added up and written down.
 *
 * Requests arrive far too fast to write each one to disk — a single page load is
 * a few hundred of them — so deltas accumulate in memory and are flushed on a
 * short debounce. The bound on how much can be lost is the debounce, two seconds,
 * and the reason that is safe rather than optimistic is that every `webRequest`
 * event resets Chrome's thirty-second idle timer: while traffic is flowing the
 * worker cannot be killed, and by the time it can be, there is nothing buffered.
 *
 * Three resolutions are written, for three different questions:
 * - `daily`  — the one that has to be right, kept for as long as retention says.
 * - `hourly` — "where did today go", pruned after three days.
 * - `hosts`  — "who inside this site", pruned with `daily`, switchable off.
 *
 * Plus a session total in `chrome.storage.session`, which Chrome clears when the
 * browser closes. That is the definition of "this session", and it is why the
 * session number is not an in-memory counter: the worker restarts many times a
 * day and "since the worker woke" is not a thing anyone asked about.
 */

import { bucketRange, put, remove, runTransaction, STORES } from "../core/db";
import { dayKeyFromMs, hourKeyFromMs } from "../core/period";
import {
  addTotals,
  addTypeBytes,
  emptyTotals,
  type HostRow,
  type ResourceType,
  type TypeBytes,
  type UsageRow,
  type UsageTotals,
} from "../core/types";
import { flushBaselines } from "../optimize/savings";
import { addTabBytes, persistOpenVisits } from "./tabs";
import { sizeModel } from "./estimate";

/** How long a finished request may sit in memory before it is written. */
const FLUSH_DELAY_MS = 2000;

const SESSION_KEY = "sessionUsage";

/**
 * Days of `hourly` rows to keep, counting today. Enough for "today" plus a night's
 * sleep, and for a session that began the day before yesterday.
 */
const HOURLY_RETENTION_DAYS = 3;

export interface Delta extends UsageTotals {
  byType: TypeBytes;
}

function emptyDelta(): Delta {
  return { ...emptyTotals(), byType: {} };
}

function addDelta(into: Delta, from: Readonly<Delta>): Delta {
  addTotals(into, from);
  addTypeBytes(into.byType, from.byType);
  return into;
}

/** One finished request, priced and attributed, ready to be counted. */
export interface CommitEntry {
  /** When the request finished. Decides which day and hour it lands in. */
  at: number;
  site: string;
  host: string;
  type: ResourceType;
  /** -1 when the request did not belong to a tab. */
  tabId: number;
  /**
   * The page load this request belongs to, as it was when the request was priced.
   *
   * Named rather than looked up, because a parked request is committed seconds
   * later and the tab may have moved on by then. `null` when the tab had no record
   * — the bytes still count towards the site, they just have no visit to join.
   */
  visitId: string | null;
  down: number;
  up: number;
  /** How much of `down` is the size model's guess rather than a measurement. */
  estimatedDown: number;
  fromCache: boolean;
  /** Bytes the HTTP cache avoided. Always an estimate. */
  cacheAvoided: number;
  /** Bytes a limit refused or an optimizer removed. */
  saved: number;
  /** How much of `saved` rests on a measurement rather than a model. */
  savedMeasured: number;
  /** The request never went out. */
  blocked: boolean;
  /** The request was redirected to a smaller variant. */
  rewritten: number;
}

export interface SessionUsage {
  startedAt: number;
  sites: Record<string, Delta>;
}

interface SessionStore {
  startedAt: number;
  sites: Record<string, Delta>;
}

class Ledger {
  private daily = new Map<string, Delta>();
  private hourly = new Map<string, Delta>();
  private hosts = new Map<string, Omit<HostRow, "key" | "bucket" | "site" | "host">>();
  private session: SessionStore | null = null;
  private sessionLoading: Promise<SessionStore> | null = null;
  /** Bumped by `resetSession`, so a read already in flight knows it is stale. */
  private sessionEpoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private trackHosts = true;
  private preFlush: (() => void) | null = null;
  private usageObserver: ((site: string, bytes: number) => void) | null = null;
  /** Serialises flushes; see `flush`. */
  private chain: Promise<void> = Promise.resolve();
  /** A flush that has been scheduled but has not yet swapped the buffers. */
  private unstarted: Promise<void> | null = null;

  setTrackHosts(value: boolean): void {
    this.trackHosts = value;
  }

  /**
   * Runs immediately before every flush, synchronously.
   *
   * This exists so `reconcile` can commit its expired requests into the same
   * flush that is about to write, without `ledger` importing `reconcile` — which
   * would be a cycle, since `reconcile` records through the ledger.
   */
  setPreFlush(hook: () => void): void {
    this.preFlush = hook;
  }

  /**
   * Called synchronously for every request, with the site and the bytes it cost.
   *
   * This is how the budget governor sees traffic. A hook rather than a direct call
   * for the same reason as `setPreFlush`: the governor reads the ledger to prime its
   * counters, so importing it here would be a cycle. It also keeps the ledger
   * ignorant of limits, which is the right split — one module counts, another decides.
   */
  setUsageObserver(hook: (site: string, bytes: number) => void): void {
    this.usageObserver = hook;
  }

  /**
   * Counts one finished request.
   *
   * Synchronous on purpose. It is called from a `webRequest` listener, which runs
   * for every subresource on every page in the browser; anything awaited here
   * would be a promise per request and a reason for the worker to stay hot.
   */
  record(entry: CommitEntry): void {
    const day = dayKeyFromMs(entry.at);
    const hour = hourKeyFromMs(entry.at);

    const delta: Delta = {
      down: entry.down,
      up: entry.up,
      requests: 1,
      estimatedDown: Math.min(entry.estimatedDown, entry.down),
      cacheHits: entry.fromCache ? 1 : 0,
      cacheAvoided: entry.cacheAvoided,
      saved: entry.saved,
      savedMeasured: Math.min(entry.savedMeasured, entry.saved),
      blocked: entry.blocked ? 1 : 0,
      rewritten: entry.rewritten,
      byType: entry.down > 0 ? { [entry.type]: entry.down } : {},
    };

    addDelta(this.bucket(this.daily, `${day}|${entry.site}`), delta);
    addDelta(this.bucket(this.hourly, `${hour}|${entry.site}`), delta);
    this.sessionAdd(entry.site, delta);

    if (this.trackHosts && entry.host) {
      const key = `${day}|${entry.site}|${entry.host}`;
      const row = this.hosts.get(key) ?? { down: 0, up: 0, requests: 0, blocked: 0, saved: 0 };
      row.down += entry.down;
      row.up += entry.up;
      row.requests += 1;
      row.blocked += entry.blocked ? 1 : 0;
      row.saved += entry.saved;
      this.hosts.set(key, row);
    }

    if (entry.tabId >= 0) addTabBytes(entry.tabId, entry.visitId, entry.down, entry.up, 1);

    // Before the flush is scheduled, so a budget crossing is acted on now rather
    // than two seconds and several megabytes later.
    if (this.usageObserver && entry.down + entry.up > 0) {
      try {
        this.usageObserver(entry.site, entry.down + entry.up);
      } catch (error) {
        console.error("Byte Budget: usage observer failed", error);
      }
    }

    this.flushSoon();
  }

  private bucket(map: Map<string, Delta>, key: string): Delta {
    let delta = map.get(key);
    if (!delta) {
      delta = emptyDelta();
      map.set(key, delta);
    }
    return delta;
  }

  /**
   * Session totals are kept in memory *and* mirrored, so `record` stays
   * synchronous. If the mirror has not loaded yet the delta is still counted and
   * merged in when it arrives, rather than dropped.
   */
  private sessionAdd(site: string, delta: Delta): void {
    if (!this.session) {
      void this.loadSession().then((session) => {
        addDelta(this.sessionSite(session, site), delta);
      });
      return;
    }
    addDelta(this.sessionSite(this.session, site), delta);
  }

  private sessionSite(session: SessionStore, site: string): Delta {
    const existing = session.sites[site];
    if (existing) return existing;
    const created = emptyDelta();
    session.sites[site] = created;
    return created;
  }

  private loadSession(): Promise<SessionStore> {
    if (this.session) return Promise.resolve(this.session);
    if (this.sessionLoading) return this.sessionLoading;
    const epoch = this.sessionEpoch;
    this.sessionLoading = (async () => {
      let stored: SessionStore | undefined;
      try {
        const raw = await chrome.storage.session.get(SESSION_KEY);
        stored = raw[SESSION_KEY] as SessionStore | undefined;
      } catch {
        stored = undefined;
      }
      // The read was issued before "delete all recorded usage" ran, so it is
      // holding the numbers that were just deleted. Merging them back in resurrected
      // the whole session total — and its start time — and the next flush wrote it to
      // disk, so the button appeared not to work while traffic was flowing.
      if (this.sessionEpoch !== epoch) {
        this.sessionLoading = null;
        return this.session ?? { startedAt: Date.now(), sites: {} };
      }
      const session: SessionStore = {
        startedAt: typeof stored?.startedAt === "number" ? stored.startedAt : Date.now(),
        sites: {},
      };
      for (const [site, delta] of Object.entries(stored?.sites ?? {})) {
        session.sites[site] = addDelta(emptyDelta(), { ...emptyDelta(), ...delta });
      }
      // A delta may have been merged into `this.session` by a concurrent caller
      // while this read was in flight; fold it in rather than replacing it.
      if (this.session) {
        for (const [site, delta] of Object.entries(this.session.sites)) {
          addDelta(this.sessionSite(session, site), delta);
        }
        session.startedAt = Math.min(session.startedAt, this.session.startedAt);
      }
      this.session = session;
      this.sessionLoading = null;
      return session;
    })();
    return this.sessionLoading;
  }

  async sessionUsage(): Promise<SessionUsage> {
    const session = await this.loadSession();
    return { startedAt: session.startedAt, sites: session.sites };
  }

  /**
   * Empties the session total. Called after "clear all data", where the mirror on
   * disk and this in-memory copy both have to go — clearing only the mirror would
   * let the next flush write the old numbers straight back.
   */
  async resetSession(): Promise<void> {
    this.sessionEpoch += 1;
    this.session = { startedAt: Date.now(), sites: {} };
    this.daily = new Map();
    this.hourly = new Map();
    this.hosts = new Map();
    await this.writeSession();
  }

  private flushSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  /**
   * Writes everything buffered at the moment of the call, and resolves once it is
   * on disk. Called before every read, so an open popup never shows a total that is
   * behind the traffic it is watching.
   *
   * The subtlety is why this is not simply "return the flush already in progress".
   * A running flush swapped its buffers before this call, so it is not carrying
   * anything recorded since; awaiting it would resolve while the newest requests
   * were still in memory and the reader would render a stale total. The smoke test
   * caught exactly that — one request short, intermittently.
   *
   * So callers are split. Anyone arriving while a flush is *scheduled but not yet
   * started* is covered by it and shares the promise. Anyone arriving after the
   * swap gets a fresh flush chained behind the current one, because two
   * read-modify-write passes over the same rows must not overlap.
   */
  flush(): Promise<void> {
    if (this.unstarted) return this.unstarted;
    const started = this.chain.then(() => {
      // Cleared before `doFlush` runs its synchronous prologue, which is where the
      // buffers are swapped. From here on, a new caller needs a new flush.
      this.unstarted = null;
      return this.doFlush();
    });
    this.unstarted = started;
    this.chain = started.catch(() => undefined);
    return started;
  }

  private async doFlush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Before the buffers are swapped, so anything the hook records is written by
    // this flush rather than waiting for the next one.
    try {
      this.preFlush?.();
    } catch (error) {
      console.error("Byte Budget: pre-flush hook failed", error);
    }

    // Swap the buffers out before the first await. Anything recorded during the
    // write lands in the fresh maps and is written by the next flush, so no
    // request is counted twice and none is dropped.
    const daily = this.daily;
    const hourly = this.hourly;
    const hosts = this.hosts;
    this.daily = new Map();
    this.hourly = new Map();
    this.hosts = new Map();

    const tasks: Promise<unknown>[] = [];
    if (daily.size > 0) tasks.push(mergeUsageRows(STORES.daily, daily));
    if (hourly.size > 0) tasks.push(mergeUsageRows(STORES.hourly, hourly));
    if (hosts.size > 0) tasks.push(mergeHostRows(hosts));
    tasks.push(this.writeSession());
    tasks.push(persistOpenVisits());
    tasks.push(sizeModel.flush());
    tasks.push(flushBaselines());

    const results = await Promise.allSettled(tasks);
    const failure = results.find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") {
      // Surfaced rather than swallowed: a failing write means the numbers are
      // wrong, and the worker's console is where that should be visible.
      console.error("Byte Budget: flush failed", failure.reason);
    }
  }

  private async writeSession(): Promise<void> {
    if (!this.session) return;
    try {
      await chrome.storage.session.set({ [SESSION_KEY]: this.session });
    } catch {
      // Session storage is capped. Dropping the mirror costs the session total
      // after the next worker restart and nothing else, so it is not worth
      // failing the whole flush over.
    }
  }
}

function mergeTotalsInto(row: UsageRow, delta: Delta): UsageRow {
  addTotals(row, delta);
  addTypeBytes(row.byType, delta.byType);
  return row;
}

/**
 * Read-modify-write of a set of usage rows in one transaction.
 *
 * The `get` calls are issued synchronously and each `put` happens inside its own
 * success callback. That is deliberate: an `await` on anything other than an
 * IndexedDB request between the two would let the transaction auto-commit
 * underneath us, and the puts would throw `TransactionInactiveError` on a busy
 * page and nowhere else.
 */
function mergeUsageRows(
  store: typeof STORES.daily | typeof STORES.hourly,
  deltas: Map<string, Delta>,
): Promise<void> {
  return runTransaction(store, "readwrite", (transaction) => {
    const objectStore = transaction.objectStore(store);
    for (const [key, delta] of deltas) {
      const separator = key.indexOf("|");
      const bucket = key.slice(0, separator);
      const site = key.slice(separator + 1);
      const request = objectStore.get(key);
      request.onsuccess = () => {
        const existing = request.result as UsageRow | undefined;
        const row: UsageRow = existing
          ? { ...existing, byType: { ...existing.byType } }
          : { key, bucket, site, ...emptyTotals(), byType: {} };
        objectStore.put(mergeTotalsInto(row, delta));
      };
    }
  });
}

function mergeHostRows(
  deltas: Map<string, Omit<HostRow, "key" | "bucket" | "site" | "host">>,
): Promise<void> {
  return runTransaction(STORES.hosts, "readwrite", (transaction) => {
    const objectStore = transaction.objectStore(STORES.hosts);
    for (const [key, delta] of deltas) {
      const [bucket = "", site = "", host = ""] = key.split("|");
      const request = objectStore.get(key);
      request.onsuccess = () => {
        const existing = request.result as HostRow | undefined;
        const row: HostRow = existing ?? {
          key,
          bucket,
          site,
          host,
          down: 0,
          up: 0,
          requests: 0,
          blocked: 0,
          saved: 0,
        };
        row.down += delta.down;
        row.up += delta.up;
        row.requests += delta.requests;
        row.blocked += delta.blocked;
        row.saved += delta.saved;
        objectStore.put(row);
      };
    }
  });
}

export const ledger = new Ledger();

/* ------------------------------------------------------------------ *
 * Retention
 * ------------------------------------------------------------------ */

/**
 * Drops rows past their retention window.
 *
 * Hourly rows go after three days regardless of the retention setting: they exist
 * to answer "where did today go", and keeping a year of them would be twenty-four
 * rows per site per day for a question nobody asks about last March.
 */
export async function pruneOldRows(dailyCutoff: string | null, today: string): Promise<void> {
  // `HOURLY_RETENTION_DAYS - 1` because today is one of the days kept, and the
  // bound is the *first* hour to keep. Off by one the other way, this dropped
  // everything before `today - 3` and so kept four days' worth while claiming three.
  const hourlyCutoff = `${addDaysTo(today, -(HOURLY_RETENTION_DAYS - 1))}T00`;
  await remove(STORES.hourly, IDBKeyRange.upperBound(`${hourlyCutoff}|`, true));

  if (!dailyCutoff) return;
  const range = IDBKeyRange.upperBound(`${dailyCutoff}|`, true);
  await remove(STORES.daily, range);
  await remove(STORES.hosts, range);
  await pruneOldVisits(dailyCutoff);
}

function addDaysTo(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const value = new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
  value.setDate(value.getDate() + days);
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

async function pruneOldVisits(dailyCutoff: string): Promise<void> {
  const [year, month, date] = dailyCutoff.split("-").map(Number);
  const cutoffMs = new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1).getTime();
  await runTransaction(STORES.visits, "readwrite", (transaction) => {
    const index = transaction.objectStore(STORES.visits).index("byStart");
    const request = index.openCursor(IDBKeyRange.upperBound(cutoffMs, true));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  });
}

/** Exported for the dashboard's "clear today" affordance and for tests. */
export async function clearDay(day: string): Promise<void> {
  await remove(STORES.daily, bucketRange(day, day));
  await remove(STORES.hosts, bucketRange(day, day));
  await remove(STORES.hourly, IDBKeyRange.bound(`${day}T`, `${day}T\uffff`));
}

/** Used by tests to seed a row without going through the request path. */
export async function seedUsageRow(row: UsageRow): Promise<void> {
  await put(STORES.daily, row);
}

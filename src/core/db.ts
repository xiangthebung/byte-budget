/**
 * A small promise wrapper over IndexedDB, plus this extension's schema.
 *
 * Deliberately not a dependency. The surface actually used here is `get`,
 * `getAll`, `put`, `delete` and a couple of key ranges; a library for that would
 * be more code to audit than the sixty lines it replaces, and `pagepack` in this
 * workspace already hand-rolls the same thing.
 *
 * Key shapes matter and are load-bearing:
 * - `daily`  key `YYYY-MM-DD|site`
 * - `hourly` key `YYYY-MM-DDTHH|site`
 * - `hosts`  key `YYYY-MM-DD|site|host`
 *
 * All three are fixed-width dates in front of a `|`, so a lexicographic key
 * range over `from|` … `to|\uffff` is exactly "every row in this date range".
 * That is why the dates are stored as text and not as numbers.
 */

import { DB_NAME, DB_VERSION } from "./types";

export const STORES = {
  daily: "daily",
  hourly: "hourly",
  hosts: "hosts",
  visits: "visits",
  sizeModel: "sizeModel",
  /** Phase 3: observed bytes for an un-rewritten URL, for measured savings. */
  baselines: "baselines",
  meta: "meta",
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

let connection: Promise<IDBDatabase> | null = null;

function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORES.daily)) {
    const daily = db.createObjectStore(STORES.daily, { keyPath: "key" });
    // Compound so "this site, over this range" is one cursor rather than a scan
    // of every site's rows followed by a filter.
    daily.createIndex("bySiteBucket", ["site", "bucket"]);
    daily.createIndex("byBucket", "bucket");
  }
  if (!db.objectStoreNames.contains(STORES.hourly)) {
    const hourly = db.createObjectStore(STORES.hourly, { keyPath: "key" });
    hourly.createIndex("bySiteBucket", ["site", "bucket"]);
  }
  if (!db.objectStoreNames.contains(STORES.hosts)) {
    const hosts = db.createObjectStore(STORES.hosts, { keyPath: "key" });
    hosts.createIndex("bySiteBucket", ["site", "bucket"]);
  }
  if (!db.objectStoreNames.contains(STORES.visits)) {
    const visits = db.createObjectStore(STORES.visits, { keyPath: "id" });
    visits.createIndex("bySiteStart", ["site", "startedAt"]);
    visits.createIndex("byStart", "startedAt");
  }
  if (!db.objectStoreNames.contains(STORES.sizeModel)) {
    const model = db.createObjectStore(STORES.sizeModel, { keyPath: "key" });
    model.createIndex("byUpdated", "updatedAt");
  }
  if (!db.objectStoreNames.contains(STORES.baselines)) {
    const baselines = db.createObjectStore(STORES.baselines, { keyPath: "url" });
    baselines.createIndex("byUpdated", "updatedAt");
  }
  if (!db.objectStoreNames.contains(STORES.meta)) {
    db.createObjectStore(STORES.meta, { keyPath: "key" });
  }
}

export function openDb(): Promise<IDBDatabase> {
  if (connection) return connection;
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => {
      const db = request.result;
      // A newer version opened elsewhere closes this handle; drop the cache so
      // the next call reopens instead of using a dead connection.
      db.onclose = () => {
        connection = null;
      };
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      connection = null;
      reject(request.error ?? new Error("Could not open the usage database."));
    };
  });
  return connection;
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Database request failed."));
  });
}

/** Runs `operation` inside one transaction and resolves when it commits. */
export async function runTransaction<T>(
  stores: StoreName | StoreName[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => T | Promise<T>,
): Promise<T> {
  const db = await openDb();
  const names = Array.isArray(stores) ? stores : [stores];
  const transaction = db.transaction(names, mode);
  const settled = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Transaction aborted."));
  });
  const result = await operation(transaction);
  // Read transactions do not need to be awaited for correctness, but writes do:
  // resolving early would let a caller read back a value that has not committed.
  if (mode !== "readonly") await settled;
  return result;
}

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return wrap<T | undefined>(db.transaction(store, "readonly").objectStore(store).get(key));
}

export async function getMany<T>(store: StoreName, keys: IDBValidKey[]): Promise<(T | undefined)[]> {
  if (keys.length === 0) return [];
  const db = await openDb();
  const objectStore = db.transaction(store, "readonly").objectStore(store);
  return Promise.all(keys.map((key) => wrap<T | undefined>(objectStore.get(key))));
}

export async function getAll<T>(
  store: StoreName,
  query?: IDBKeyRange | IDBValidKey,
  count?: number,
): Promise<T[]> {
  const db = await openDb();
  return wrap<T[]>(
    db.transaction(store, "readonly").objectStore(store).getAll(query ?? null, count),
  );
}

export async function getAllFromIndex<T>(
  store: StoreName,
  index: string,
  query?: IDBKeyRange | IDBValidKey,
  count?: number,
): Promise<T[]> {
  const db = await openDb();
  return wrap<T[]>(
    db
      .transaction(store, "readonly")
      .objectStore(store)
      .index(index)
      .getAll(query ?? null, count),
  );
}

export async function put(store: StoreName, value: unknown): Promise<void> {
  await runTransaction(store, "readwrite", (transaction) => {
    transaction.objectStore(store).put(value);
  });
}

export async function putMany(store: StoreName, values: readonly unknown[]): Promise<void> {
  if (values.length === 0) return;
  await runTransaction(store, "readwrite", (transaction) => {
    const objectStore = transaction.objectStore(store);
    for (const value of values) objectStore.put(value);
  });
}

export async function remove(store: StoreName, key: IDBValidKey | IDBKeyRange): Promise<void> {
  await runTransaction(store, "readwrite", (transaction) => {
    transaction.objectStore(store).delete(key);
  });
}

export async function clearStore(store: StoreName): Promise<void> {
  await runTransaction(store, "readwrite", (transaction) => {
    transaction.objectStore(store).clear();
  });
}

export async function countRows(
  store: StoreName,
  query?: IDBKeyRange | IDBValidKey,
): Promise<number> {
  const db = await openDb();
  return wrap<number>(
    db.transaction(store, "readonly").objectStore(store).count(query ?? undefined),
  );
}

/**
 * Every key range in this schema is "text prefix, then anything", so it is worth
 * one named helper rather than a `\uffff` literal at each call site.
 */
export function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, `${prefix}\uffff`);
}

/** Rows whose `bucket|…` key falls in an inclusive day or hour range. */
export function bucketRange(from: string, to: string): IDBKeyRange {
  return IDBKeyRange.bound(`${from}|`, `${to}|\uffff`);
}

/* ------------------------------------------------------------------ *
 * meta
 * ------------------------------------------------------------------ */

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await get<{ key: string; value: T }>(STORES.meta, key);
  return row ? row.value : fallback;
}

export async function setMeta<T>(key: string, value: T): Promise<void> {
  await put(STORES.meta, { key, value });
}

/** Drops every usage store. Settings live in `chrome.storage` and survive. */
export async function clearAllUsage(): Promise<void> {
  await runTransaction(
    [STORES.daily, STORES.hourly, STORES.hosts, STORES.visits, STORES.sizeModel, STORES.baselines],
    "readwrite",
    (transaction) => {
      for (const store of [
        STORES.daily,
        STORES.hourly,
        STORES.hosts,
        STORES.visits,
        STORES.sizeModel,
        STORES.baselines,
      ]) {
        transaction.objectStore(store).clear();
      }
    },
  );
}

/**
 * What a test needs in place before it can import the extension's TypeScript
 * sources and run them the way the browser does.
 *
 * Two jobs, and they happen at different moments.
 *
 * **Resolution**, through the `resolve` hook. Node 23 and later strips type
 * annotations itself, so there is no compile step. The one thing that still gets in
 * the way is that the sources use extensionless relative specifiers (`./types`),
 * which Vite resolves and Node's ESM resolver does not. Appending `.ts` here is
 * cheaper than putting extensions in shipped code to satisfy a test runner.
 * Registered by `tests/register-hooks.mjs`, which the `test` script passes to
 * `node --import` so it is in place before any test file loads.
 *
 * **The browser globals Node does not have**, through the two `install*` factories
 * below — `chrome.storage`, and IndexedDB with its key ranges. These are imported
 * directly by the test files that need them and install nothing when this module is
 * merely loaded, so a test that does not ask for a fake runs in the same bare
 * environment it always did.
 *
 * They live here rather than in one test file because three test files need them,
 * and a copy of an IndexedDB double per file is a way to have three of them disagree
 * about what a key range means — which would turn "these rows survived the prune"
 * into a statement about whichever copy the test happened to import.
 */

/** Anything already carrying a module extension is left alone. */
const HAS_EXTENSION = /\.([cm]?[jt]s|json|node|html|css)$/;

export function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !HAS_EXTENSION.test(specifier)) {
    return next(`${specifier}.ts`, context);
  }
  return next(specifier, context);
}

/* ------------------------------------------------------------------ *
 * chrome.storage
 * ------------------------------------------------------------------ */

/**
 * One storage area, with Chrome's actual return shapes.
 *
 * `get` returning `{}` for a missing key rather than `undefined` is the whole point
 * of the double: `src/core/settings.ts` reads `stored[SETTINGS_KEY]` and hands the
 * `undefined` straight to `normalize()`, so a fake that returned the key regardless
 * would test a path the browser never takes.
 *
 * Values are cloned in and out. Chrome serialises across the storage boundary, so a
 * caller cannot mutate what is stored by holding on to the object it saved, and a
 * fake that handed back live references would let a test pass on aliasing.
 */
function storageArea(name, onChanged) {
  const data = new Map();
  return {
    async get(query) {
      if (query === null || query === undefined) return structuredClone(Object.fromEntries(data));
      let keys = [];
      let defaults = {};
      if (typeof query === "string") keys = [query];
      else if (Array.isArray(query)) keys = query;
      else {
        defaults = query;
        keys = Object.keys(query);
      }
      const out = {};
      for (const key of keys) {
        if (data.has(key)) out[key] = structuredClone(data.get(key));
        else if (key in defaults) out[key] = structuredClone(defaults[key]);
      }
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data.has(key) ? structuredClone(data.get(key)) : undefined };
        data.set(key, structuredClone(value));
        changes[key].newValue = structuredClone(value);
      }
      onChanged(changes, name);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of list) {
        if (!data.has(key)) continue;
        changes[key] = { oldValue: structuredClone(data.get(key)), newValue: undefined };
        data.delete(key);
      }
      onChanged(changes, name);
    },
    async clear() {
      data.clear();
    },
    /** For a test that wants to plant a value without going through `set`. */
    seed(key, value) {
      data.set(key, structuredClone(value));
    },
    /** For a test that wants to read what actually landed on disk. */
    raw(key) {
      return data.has(key) ? structuredClone(data.get(key)) : undefined;
    },
  };
}

/**
 * Installs `chrome.storage` on `globalThis`, with `sync`, `local` and `session`.
 *
 * Returns the areas so a test can seed a corrupt value — the case every `normalize`
 * in this codebase exists for — and read back what a save actually wrote.
 */
export function installFakeChromeStorage() {
  const listeners = [];
  const fire = (changes, area) => {
    if (Object.keys(changes).length === 0) return;
    for (const listener of listeners) listener(changes, area);
  };
  const storage = {
    sync: storageArea("sync", fire),
    local: storageArea("local", fire),
    session: storageArea("session", fire),
    onChanged: {
      addListener(listener) {
        listeners.push(listener);
      },
      removeListener(listener) {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      },
    },
  };
  globalThis.chrome = { ...(globalThis.chrome ?? {}), storage };
  return storage;
}

/* ------------------------------------------------------------------ *
 * IndexedDB
 * ------------------------------------------------------------------ */

/**
 * IndexedDB's key ordering, which is not JavaScript's.
 *
 * Numbers sort before dates before strings before arrays, arrays compare
 * element-wise and a prefix sorts first. `src/core/db.ts` leans on exactly this:
 * the day keys are fixed-width text so that a lexicographic range *is* a date
 * comparison, and the compound indexes are `[site, bucket]` pairs. Getting this
 * wrong here would make a prune test pass against ordering no browser uses.
 */
function typeRank(key) {
  if (Array.isArray(key)) return 3;
  if (typeof key === "string") return 2;
  if (key instanceof Date) return 1;
  return 0;
}

function compareKeys(a, b) {
  const rankA = typeRank(a);
  const rankB = typeRank(b);
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;
  if (rankA === 3) {
    const shared = Math.min(a.length, b.length);
    for (let index = 0; index < shared; index++) {
      const order = compareKeys(a[index], b[index]);
      if (order !== 0) return order;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }
  if (rankA === 2) return a < b ? -1 : a > b ? 1 : 0;
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * `IDBKeyRange`, with the open/closed bounds spelled out.
 *
 * The half-open bound is the whole of the retention boundary: `pruneOldRows` deletes
 * with `upperBound(`${cutoff}|`, true)`, and whether the cutoff day itself survives
 * is decided entirely by that `true`. A double that ignored the flag would report the
 * off-by-one as fixed whichever way the source had it.
 */
class FakeKeyRange {
  constructor(lower, upper, lowerOpen, upperOpen) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
  }

  includes(key) {
    if (this.lower !== undefined) {
      const order = compareKeys(key, this.lower);
      if (order < 0 || (order === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const order = compareKeys(key, this.upper);
      if (order > 0 || (order === 0 && this.upperOpen)) return false;
    }
    return true;
  }

  static bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
  }

  static lowerBound(lower, open = false) {
    return new FakeKeyRange(lower, undefined, open, false);
  }

  static upperBound(upper, open = false) {
    return new FakeKeyRange(undefined, upper, false, open);
  }

  static only(value) {
    return new FakeKeyRange(value, value, false, false);
  }
}

function selects(query, key) {
  if (query === null || query === undefined) return true;
  if (query instanceof FakeKeyRange) return query.includes(key);
  return compareKeys(query, key) === 0;
}

function keyFor(keyPath, value) {
  if (Array.isArray(keyPath)) return keyPath.map((path) => value[path]);
  return value[keyPath];
}

class FakeStore {
  constructor(name, keyPath) {
    this.name = name;
    this.keyPath = keyPath;
    /** Primary key to stored value. Every primary key in this schema is a string. */
    this.rows = new Map();
    this.indexes = new Map();
  }

  createIndex(name, keyPath) {
    this.indexes.set(name, keyPath);
    return { name, keyPath };
  }

  /** Every row, ordered by primary key, the way a cursor or `getAll` sees them. */
  ordered() {
    return [...this.rows.entries()].sort((a, b) => compareKeys(a[0], b[0]));
  }

  /** Every row, ordered by an index key then by primary key. */
  orderedByIndex(indexName) {
    const keyPath = this.indexes.get(indexName);
    if (keyPath === undefined) throw new Error(`No index ${indexName} on ${this.name}`);
    return [...this.rows.entries()]
      .map(([primaryKey, value]) => ({ indexKey: keyFor(keyPath, value), primaryKey, value }))
      .sort(
        (a, b) =>
          compareKeys(a.indexKey, b.indexKey) || compareKeys(a.primaryKey, b.primaryKey),
      );
  }
}

/**
 * A request whose handlers are attached synchronously and fired on a microtask.
 *
 * `src/core/db.ts` always assigns `onsuccess` in the same synchronous block that
 * created the request, so a microtask is late enough. Anything that assigned a
 * handler after an await would miss it here — and would miss it in a browser too.
 */
function fireRequest(transaction, request, work) {
  transaction.pending += 1;
  queueMicrotask(() => {
    try {
      request.result = work();
      request.onsuccess?.({ target: request });
    } catch (error) {
      transaction.error = error;
      request.error = error;
      request.onerror?.({ target: request });
      transaction.aborted = true;
    } finally {
      transaction.pending -= 1;
      drain(transaction);
    }
  });
  return request;
}

function drain(transaction) {
  if (transaction.settled) return;
  if (transaction.pending > 0) {
    queueMicrotask(() => drain(transaction));
    return;
  }
  transaction.settled = true;
  if (transaction.aborted) transaction.onabort?.();
  else transaction.oncomplete?.();
}

function storeHandle(transaction, store) {
  const request = () => ({ result: undefined, error: null, onsuccess: null, onerror: null });
  return {
    get(key) {
      return fireRequest(transaction, request(), () => {
        const found = store.rows.get(key);
        return found === undefined ? undefined : structuredClone(found);
      });
    },
    getAll(query, count) {
      return fireRequest(transaction, request(), () => {
        const out = [];
        for (const [key, value] of store.ordered()) {
          if (!selects(query, key)) continue;
          out.push(structuredClone(value));
          if (count !== undefined && count !== null && out.length >= count) break;
        }
        return out;
      });
    },
    count(query) {
      return fireRequest(transaction, request(), () => {
        let total = 0;
        for (const [key] of store.ordered()) if (selects(query, key)) total += 1;
        return total;
      });
    },
    put(value) {
      return fireRequest(transaction, request(), () => {
        const key = keyFor(store.keyPath, value);
        store.rows.set(key, structuredClone(value));
        return key;
      });
    },
    delete(query) {
      return fireRequest(transaction, request(), () => {
        for (const [key] of store.ordered()) if (selects(query, key)) store.rows.delete(key);
        return undefined;
      });
    },
    clear() {
      return fireRequest(transaction, request(), () => {
        store.rows.clear();
        return undefined;
      });
    },
    index(name) {
      return {
        getAll(query, count) {
          return fireRequest(transaction, request(), () => {
            const out = [];
            for (const entry of store.orderedByIndex(name)) {
              if (!selects(query, entry.indexKey)) continue;
              out.push(structuredClone(entry.value));
              if (count !== undefined && count !== null && out.length >= count) break;
            }
            return out;
          });
        },
        openCursor(query) {
          // A snapshot rather than a live cursor. The only cursor in the extension
          // walks a range deleting as it goes, which a snapshot models exactly; a
          // caller that inserted into its own range mid-walk would diverge, and none
          // does.
          const matching = store
            .orderedByIndex(name)
            .filter((entry) => selects(query, entry.indexKey));
          const cursorRequest = request();
          let at = 0;
          const step = () =>
            fireRequest(transaction, cursorRequest, () => {
              const entry = matching[at];
              if (!entry) return null;
              at += 1;
              return {
                key: entry.indexKey,
                primaryKey: entry.primaryKey,
                value: structuredClone(entry.value),
                delete() {
                  store.rows.delete(entry.primaryKey);
                },
                continue: step,
              };
            });
          return step();
        },
      };
    },
  };
}

class FakeDatabase {
  constructor(name) {
    this.name = name;
    this.version = 0;
    this.stores = new Map();
    this.objectStoreNames = { contains: (storeName) => this.stores.has(storeName) };
  }

  createObjectStore(name, options) {
    const store = new FakeStore(name, options.keyPath);
    this.stores.set(name, store);
    return store;
  }

  transaction(names, mode) {
    const wanted = Array.isArray(names) ? names : [names];
    const transaction = {
      mode,
      pending: 0,
      settled: false,
      aborted: false,
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: (name) => {
        if (!wanted.includes(name)) throw new Error(`${name} is not in this transaction`);
        const store = this.stores.get(name);
        if (!store) throw new Error(`No store ${name}`);
        return storeHandle(transaction, store);
      },
    };
    // Queued now, not on the first request: `runTransaction` runs its whole
    // synchronous body before any microtask, so by the time this fires the requests
    // are already counted — and a transaction that issues none still has to complete,
    // or its caller awaits `settled` forever.
    queueMicrotask(() => drain(transaction));
    return transaction;
  }

  close() {}
}

/**
 * Installs `indexedDB` and `IDBKeyRange` on `globalThis`.
 *
 * `src/core/db.ts` caches its connection for the life of the module, so this has to
 * be called before the first database call in a test file and the handle it returns
 * empties the stores rather than replacing the database.
 */
export function installFakeIndexedDb() {
  const databases = new Map();
  globalThis.IDBKeyRange = FakeKeyRange;
  globalThis.indexedDB = {
    open(name, version) {
      const request = {
        result: undefined,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      let db = databases.get(name);
      if (!db) {
        db = new FakeDatabase(name);
        databases.set(name, db);
      }
      queueMicrotask(() => {
        request.result = db;
        if (db.version < version) {
          const oldVersion = db.version;
          db.version = version;
          request.onupgradeneeded?.({ oldVersion, newVersion: version });
        }
        request.onsuccess?.({ target: request });
      });
      return request;
    },
  };
  return {
    /** Empties every store, keeping the connection `db.ts` has already cached. */
    clear() {
      for (const db of databases.values()) {
        for (const store of db.stores.values()) store.rows.clear();
      }
    },
  };
}

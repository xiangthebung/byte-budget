/**
 * When the ledger started counting, so a day before that is unknown rather than zero.
 *
 * Every read of the daily store fills the days it finds no row for with 0, which is
 * right for a day the browser sat idle and wrong for a day the extension did not exist.
 * The projection is where the difference bites: installed on the 12th of a cycle that
 * began on the 1st, it used to read eleven days of measured nothing, call the rate
 * established after one page load, and print a confident figure for the month. Those
 * eleven days were not measured at all.
 *
 * So the day recording began is kept, and every window that reaches back past it says
 * so. It is set at install, moved forward when all recorded usage is deleted — the
 * days before a deletion are just as unknown as the days before an install — and, for a
 * profile that predates the field, taken from the oldest daily row on disk, which is
 * the earliest day anything can honestly claim to know about.
 *
 * `chrome.storage.local` rather than the `meta` store: `CLEAR_DATA` empties every usage
 * store and this has to survive that call in order to be moved by it.
 */

import { getAll, STORES } from "../core/db";
import { dayKey } from "../core/period";
import type { UsageRow } from "../core/types";

const SINCE_KEY = "recordingSince";

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

let cached: string | null = null;
let loading: Promise<string> | null = null;

/** The oldest day the daily store holds a row for, or `null` when it is empty. */
async function earliestRecordedDay(): Promise<string | null> {
  // The primary key is `${day}|${site}`, so key order is day order and the first row
  // is the oldest — one row read, not a scan.
  const [first] = await getAll<UsageRow>(STORES.daily, undefined, 1);
  return first && DAY_KEY.test(first.bucket) ? first.bucket : null;
}

/**
 * The day recording began, as a `YYYY-MM-DD` key.
 *
 * Read once per worker and then held: it changes only through `markRecordingStart`,
 * which updates the cache itself.
 */
export function recordingSince(): Promise<string> {
  if (cached !== null) return Promise.resolve(cached);
  if (loading) return loading;
  loading = (async () => {
    let since: string | null = null;
    try {
      const stored = await chrome.storage.local.get(SINCE_KEY);
      const raw = stored[SINCE_KEY];
      if (typeof raw === "string" && DAY_KEY.test(raw)) since = raw;
    } catch {
      // Fall through to the ledger, which is the other honest source.
    }
    if (since === null) {
      // A profile from before this field existed. The oldest row is the earliest day
      // the ledger can vouch for; an empty ledger has known nothing before today.
      try {
        since = (await earliestRecordedDay()) ?? dayKey();
      } catch {
        since = dayKey();
      }
      try {
        await chrome.storage.local.set({ [SINCE_KEY]: since });
      } catch {
        // Derived again next wake, from the same rows. Nothing is lost.
      }
    }
    cached = since;
    loading = null;
    return since;
  })();
  return loading;
}

/**
 * Records that everything before `day` is unknown.
 *
 * Called at install and after all recorded usage is deleted. The cache is replaced
 * rather than merged: an install event arriving after a derived value was read is the
 * more authoritative of the two, and a deletion always moves the date forward.
 */
export async function markRecordingStart(day: string = dayKey()): Promise<void> {
  cached = day;
  loading = null;
  await chrome.storage.local.set({ [SINCE_KEY]: day });
}

/** For tests, which install a fresh storage double per file. */
export function resetRecordingSinceCache(): void {
  cached = null;
  loading = null;
}

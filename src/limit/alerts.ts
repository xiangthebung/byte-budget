/**
 * Telling someone their allowance is running out, before they have spent it.
 *
 * Every other channel in this extension reaches a person only after the damage. The
 * in-page banner exists in a tab that is already loading a limited site, and it is
 * injected by `notify.ts` at the moment the tier changes — so it explains a limit that
 * has already started refusing things. The toolbar badge ships `off`. An install can
 * therefore be running, correct, and watch someone spend 90% of a month while saying
 * nothing at all, which is the difference between an instrument and a product.
 *
 * What this sends is a measurement: bytes counted against an allowance the person set,
 * the same figure every other surface prints. It is deliberately never a projection —
 * `core/forecast.ts` is not imported here and should not be. A modelled number arriving
 * with a notification's urgency is the one place in this codebase where a guess would be
 * harder to question than a measurement, and the dashboard is where a projection can be
 * shown next to its basis.
 *
 * On the `notifications` permission, weighed the way README.md weighs `debugger`: it
 * adds a line to the install prompt that every user reads and that most of them will
 * never see a notification from, and it buys the ability to interrupt — which is
 * uninstall-shaped if it is spent badly. So the design is bounded rather than trusted:
 * three thresholds and no stream, one alert per threshold per window, only the highest
 * threshold when several are crossed at once, per-site alerts off by default, and a
 * record of what has been said that outlives the worker. Three notifications a month,
 * for the one thing the extension exists to prevent, is what the warning is being spent
 * on. Unlike `debugger` this needs no second channel: it is not a capability anyone can
 * be harmed by, only annoyed by, and the annoyance is switchable off.
 */

import { formatAgo, formatBytes, formatPercent } from "../core/format";
import { runtimeFile } from "../core/runtime";
import { ALL_SITES, type Settings } from "../core/types";

/**
 * Where an alert fires, as a share of the allowance.
 *
 * Three, and not a curve: 75% is early enough that the rest of the window can still be
 * spent differently, 90% is the last point at which what is left can be rationed, and
 * 100% is a fact rather than a warning. A fourth would not change anyone's behaviour and
 * would spend the interruption budget that makes the first three land.
 */
export const ALERT_THRESHOLDS = [0.75, 0.9, 1] as const;

export interface AlertSettings {
  /** Alerts for the allowance that covers everything (`ALL_SITES`). */
  plan: boolean;
  /** Alerts for a limit on a single site. */
  sites: boolean;
}

/**
 * Plan alerts on, per-site alerts off.
 *
 * A per-site limit is something the user typed in, on a site they chose, expecting to
 * reach it — being told is being told what they already know. A plan running out is the
 * thing this extension is installed to avoid and the thing nobody is watching for, so it
 * is the one that earns an interruption without being asked for.
 */
export const DEFAULT_ALERT_SETTINGS: AlertSettings = { plan: true, sites: false };

/** One allowance, as the governor already knows it. */
export interface AllowanceReading {
  /** Site key. `ALL_SITES` marks the allowance that covers everything. */
  site: string;
  /** Bytes spent in this window. Measured; never a forecast. */
  used: number;
  /** The budget plus any grant for this window. */
  allowance: number;
  /** Identifies the window, so a rollover retires the previous window's alerts. */
  periodKey: string;
  /** Epoch ms the window rolls over, or `null` for a session budget. */
  resetsAt: number | null;
}

/**
 * The preferences sync and the history does not, for the reason stated in
 * `optimize/features.ts` and `limit/budgets.ts`: two booleans say nothing about anyone's
 * browsing, and a record keyed by site name is a list of the domains someone capped.
 *
 * `chrome.storage.session` would be the wrong home for the history even setting that
 * aside. A window outlives a browser session — a monthly budget by weeks — so a record
 * that dies with the session would announce 75% again on the next browser start, and
 * again after that, which is exactly the failure the record exists to prevent.
 */
const PREFS_KEY = "alerts";
const HISTORY_KEY = "alertHistory";

interface FiredRecord {
  periodKey: string;
  /** Thresholds already announced for that window. */
  thresholds: number[];
  /** Last write, for evicting the oldest when the record outgrows its cap. */
  at: number;
}

type AlertHistory = Record<string, FiredRecord>;

/**
 * Room for `MAX_BUDGETS` several times over.
 *
 * The cap is what bounds the record: an entry for a site whose budget was removed is
 * never revisited by name, so without one the only thing that ever shrinks this is
 * `clearAlertHistory`.
 */
const MAX_TRACKED_SITES = 64;

const ID_PREFIX = "byte-budget:allowance:";

/* ------------------------------------------------------------------ *
 * Preferences
 * ------------------------------------------------------------------ */

function normalizePrefs(value: Partial<AlertSettings> | undefined): AlertSettings {
  return {
    plan: typeof value?.plan === "boolean" ? value.plan : DEFAULT_ALERT_SETTINGS.plan,
    sites: typeof value?.sites === "boolean" ? value.sites : DEFAULT_ALERT_SETTINGS.sites,
  };
}

export async function getAlertSettings(): Promise<AlertSettings> {
  const stored = await chrome.storage.sync.get(PREFS_KEY);
  return normalizePrefs(stored[PREFS_KEY] as Partial<AlertSettings> | undefined);
}

export async function saveAlertSettings(changes: Partial<AlertSettings>): Promise<AlertSettings> {
  const next = normalizePrefs({ ...(await getAlertSettings()), ...changes });
  await chrome.storage.sync.set({ [PREFS_KEY]: next });
  return next;
}

/* ------------------------------------------------------------------ *
 * What has already been said
 * ------------------------------------------------------------------ */

function normalizeHistory(value: unknown): AlertHistory {
  const record: AlertHistory = {};
  if (!value || typeof value !== "object") return record;
  for (const [site, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Partial<FiredRecord>;
    if (typeof raw.periodKey !== "string") continue;
    // Filtered against the current thresholds rather than merely to numbers. A stored
    // value from a build with a different ladder would otherwise be compared with this
    // build's by count, and a set of the same size but different members reads as
    // "already announced" for a threshold nobody has been told about.
    const thresholds = Array.isArray(raw.thresholds)
      ? raw.thresholds.filter(
          (threshold): threshold is number =>
            typeof threshold === "number" &&
            (ALERT_THRESHOLDS as readonly number[]).includes(threshold),
        )
      : [];
    record[site] = {
      periodKey: raw.periodKey,
      thresholds,
      at: typeof raw.at === "number" ? raw.at : 0,
    };
  }
  return record;
}

let history: AlertHistory | null = null;

/**
 * Read from disk once per worker, then held in memory.
 *
 * A failed read is left to reject rather than defaulted to an empty record. Empty means
 * "nothing has been announced", and acting on that would send a second copy of every
 * alert this window has already produced — the precise thing the store exists to
 * prevent. Skipping the pass costs a minute, and the memo is not filled on failure, so
 * the next pass retries.
 */
async function ensureHistory(): Promise<AlertHistory> {
  if (history) return history;
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const loaded = normalizeHistory(stored[HISTORY_KEY]);
  history = loaded;
  return loaded;
}

async function writeHistory(record: AlertHistory): Promise<void> {
  const sites = Object.keys(record);
  if (sites.length > MAX_TRACKED_SITES) {
    const ordered = [...sites].sort((a, b) => (record[a]?.at ?? 0) - (record[b]?.at ?? 0));
    for (const site of ordered.slice(0, sites.length - MAX_TRACKED_SITES)) delete record[site];
  }
  await chrome.storage.local.set({ [HISTORY_KEY]: record });
}

/**
 * Forgets which thresholds have been announced.
 *
 * Called when all usage is deleted. The live counters restart from zero there, so a
 * profile that kept the record would climb back through 75% and 90% in silence — for the
 * rest of the window, which on a monthly budget is up to a month. The preferences are
 * left alone: they are settings, like the budgets they belong to, and deleting
 * measurements is not a request to change either.
 */
export async function clearAlertHistory(): Promise<void> {
  await chrome.storage.local.remove(HISTORY_KEY);
  history = {};
}

/* ------------------------------------------------------------------ *
 * Deciding and sending
 * ------------------------------------------------------------------ */

/**
 * Which threshold to announce for one reading, and what the record should say after.
 *
 * Pure, and split out of `run` deliberately: the dedupe rule is the whole of this
 * module's correctness and it is the only part of it that can be asserted under
 * `node --test` rather than watched in a browser for a month.
 *
 * Two rules live here. A threshold the share has fallen back below counts as unannounced
 * again — within a window `used` only grows, so the only thing that can lower a share is
 * the allowance going up (a grant, or an edited limit), after which the person really is
 * under 75% again and should hear about it if they climb back over. And only the highest
 * fresh threshold is announced: one video takes someone from 40% to 105%, crossing all
 * three, and three notifications arriving together bury the one that matters. The lower
 * two are still returned as said, so they cannot arrive later on their own.
 */
export function decideAlert(
  share: number,
  previous: { periodKey: string; thresholds: readonly number[] } | undefined,
  periodKey: string,
): { announce: number | null; thresholds: number[] } {
  const carried =
    previous && previous.periodKey === periodKey
      ? previous.thresholds.filter((threshold) => share >= threshold)
      : [];
  const reached = ALERT_THRESHOLDS.filter((threshold) => share >= threshold);
  const fresh = reached.filter((threshold) => !carried.includes(threshold));
  return { announce: fresh[fresh.length - 1] ?? null, thresholds: [...reached] };
}

/** Serialises the passes; see `checkAllowanceAlerts`. */
let queue: Promise<void> = Promise.resolve();

/**
 * Considers every allowance for an alert, and sends at most one per site.
 *
 * Takes the whole set rather than a single reading for two reasons: a pass then costs
 * one storage write however many budgets exist, and two callers — the enforcement path
 * and the maintenance alarm — cannot interleave a read-modify-write into two copies of
 * the same alert, because the calls queue on one chain.
 *
 * Never rejects. Both callers are on paths whose real work is enforcement and flushing,
 * and a notification that did not go out must not be able to abort either.
 */
export function checkAllowanceAlerts(
  readings: readonly AllowanceReading[],
  units: Settings["units"],
): Promise<void> {
  queue = queue
    .then(() => run(readings, units))
    .catch((error: unknown) => {
      console.error("Byte Budget: could not raise the usage alerts", error);
    });
  return queue;
}

async function run(
  readings: readonly AllowanceReading[],
  units: Settings["units"],
): Promise<void> {
  if (readings.length === 0) return;
  // Before the history read, so a profile with alerting switched off entirely does no
  // storage work on a path that runs once a minute for the life of the browser.
  const prefs = await getAlertSettings();
  if (!prefs.plan && !prefs.sites) return;

  const record = await ensureHistory();
  const pending: { reading: AllowanceReading; threshold: number }[] = [];
  let changed = false;

  for (const reading of readings) {
    if (reading.allowance <= 0) continue;
    if (!(reading.site === ALL_SITES ? prefs.plan : prefs.sites)) continue;

    const entry = record[reading.site];
    const { announce, thresholds } = decideAlert(
      reading.used / reading.allowance,
      entry,
      reading.periodKey,
    );
    if (announce !== null) pending.push({ reading, threshold: announce });

    // Compared by count rather than member by member: both sides are prefixes of
    // `ALERT_THRESHOLDS`, and `normalizeHistory` drops anything that is not one of them,
    // so equal lengths are equal sets.
    if (
      !entry ||
      entry.periodKey !== reading.periodKey ||
      entry.thresholds.length !== thresholds.length
    ) {
      record[reading.site] = { periodKey: reading.periodKey, thresholds, at: Date.now() };
      changed = true;
    }
  }

  // Written before anything is sent, on the same argument as `claimNotice` in
  // `notify.ts`: a `create` that fails because notifications are switched off at the OS
  // level is not worth retrying every minute forever, and a `create` that succeeds while
  // the write is still in flight is how a worker torn down in between sends a second
  // copy of an alert someone has already read.
  if (changed) await writeHistory(record);
  for (const item of pending) await send(item.reading, item.threshold, units);
}

async function send(
  reading: AllowanceReading,
  threshold: number,
  units: Settings["units"],
): Promise<void> {
  // The namespace is absent, not merely inert, in a build that does not declare the
  // permission — and this runs from the maintenance alarm, so an unguarded call would
  // take the flush backstop and the window rollover down with it every minute. The
  // widened type is what makes the guard legal against typings that assume the
  // permission is always there.
  const api: typeof chrome.notifications | undefined = chrome.notifications;
  if (!api) return;

  const { title, message } = describe(reading, threshold, units);
  try {
    await api.create(idFor(reading.site, reading.periodKey, threshold), {
      type: "basic",
      iconUrl: chrome.runtime.getURL(runtimeFile("icon.png")),
      title,
      message,
      priority: threshold >= 1 ? 2 : 0,
    });
  } catch {
    // Notifications refused by the operating system, or switched off for this extension
    // in Chrome's own settings. The allowance is still measured and still enforced; only
    // the warning is missing, and the record above has already treated it as delivered
    // rather than queueing a retry nobody asked for.
  }
}

/**
 * The wording, composed here for the same reason `notify.ts` composes the banner's:
 * byte formatting lives in one place, and a notification is the surface with the least
 * room to be wrong on.
 *
 * No tilde and no "about" anywhere in it. These are ledger figures — the same ones the
 * popup prints — and hedging a measurement reads as hedging the limit.
 */
function describe(
  reading: AllowanceReading,
  threshold: number,
  units: Settings["units"],
): { title: string; message: string } {
  const plan = reading.site === ALL_SITES;
  const spent = `${formatBytes(reading.used, units)} of ${formatBytes(reading.allowance, units)}`;
  const resets = reading.resetsAt ? ` Resets ${formatAgo(reading.resetsAt)}.` : "";

  if (threshold >= 1) {
    return {
      title: plan ? "Your data allowance is used up" : `${reading.site} has used up its limit`,
      message: `${spent}.${resets}`,
    };
  }

  const left = formatBytes(Math.max(0, reading.allowance - reading.used), units);
  return {
    title: plan
      ? `${formatPercent(threshold)} of your data allowance used`
      : `${formatPercent(threshold)} of the limit on ${reading.site}`,
    message: `${spent}. ${left} left.${resets}`,
  };
}

/**
 * Chrome replaces a notification carrying an id it already holds rather than stacking a
 * second one, so the window and the threshold are both in the id: the history above
 * decides whether to speak at all, and this decides that two alerts which are genuinely
 * different can never overwrite each other.
 */
function idFor(site: string, periodKey: string, threshold: number): string {
  return `${ID_PREFIX}${site}:${periodKey}:${threshold}`;
}

/** Whether a clicked notification is one of ours, for the worker's click handler. */
export function isAlertNotification(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

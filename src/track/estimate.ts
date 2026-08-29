/**
 * The size model: what to assume a response weighed when nothing measured it.
 *
 * Two situations need this. A response can arrive with no `Content-Length` (any
 * chunked or streamed body) and no usable resource timing (any opaque
 * cross-origin response) — see ARCHITECTURE.md "Measurement". And a request that a rule blocked
 * never had a size at all, but the bytes it would have cost are exactly the
 * number phase 3 has to report.
 *
 * So: a running mean per `host|type`, trained on the responses we did measure,
 * with a per-type default in front of it. The mean is arithmetic and its weight
 * is capped, which turns it into an exponential moving average once a key is well
 * observed — a host that switches from thumbnails to full-size images should
 * follow within a few dozen samples, not average the two forever.
 */

import { getAll, put, putMany, removeMany, STORES } from "../core/db";
import type { ResourceType, SizeSample } from "../core/types";

/**
 * Fallbacks for a `host|type` never seen before, and the band a cold key's first
 * sample is held to — see `FIRST_SAMPLE_RATIO`.
 *
 * Order-of-magnitude figures, not measurements, and chosen to be unsurprising
 * rather than flattering: `media` is deliberately not the size of a whole video,
 * because media arrives in range requests and pricing each chunk as a film would
 * make a blocked video look like a saving of gigabytes.
 */
export const DEFAULT_SIZES: Record<ResourceType, number> = {
  main_frame: 60_000,
  sub_frame: 40_000,
  stylesheet: 25_000,
  script: 70_000,
  image: 45_000,
  font: 35_000,
  media: 500_000,
  xmlhttprequest: 10_000,
  // Frames after the handshake are invisible to extensions; assuming a number
  // here would be inventing traffic rather than estimating it.
  websocket: 0,
  ping: 800,
  other: 15_000,
};

/** After this many samples the mean stops settling and starts tracking. */
const MAX_WEIGHT = 40;

/**
 * A sample further than this factor from the current mean is pulled back to the
 * factor before being blended in — winsorised, not discarded.
 *
 * The first attempt at this reduced the *weight* of the existing mean for an
 * outlier, which is backwards: it made one 40 MB video segment on an 8 kB API host
 * move the mean to 3.6 MB, a 450x jump from a single request. Clamping the sample
 * instead caps any one observation's influence at about 17%, while a host that has
 * genuinely changed what it serves still walks the mean all the way there in
 * roughly twenty samples.
 */
const OUTLIER_RATIO = 8;

/**
 * How far a cold key's first sample may sit from its per-type default.
 *
 * A cold key used to take its first sample at face value, which meant one
 * unrepresentative response defined the key for good: a HEAD probe against a 60 MB
 * file (`priceCompleted` trains on the declared length), a 302, an error page. That
 * one number then priced every blocked request and every cache hit on the host —
 * the estimated half of the savings figure and the whole "cache avoided" column.
 *
 * Wider than `OUTLIER_RATIO` because there is nothing observed to disagree with
 * yet: the default is an order-of-magnitude prior, not a measurement, so a host
 * that genuinely serves 1 MB images against a 45 kB `image` default has to be
 * believed. It is only the first sample that is held back, and only to the edge of
 * the band — three or four real samples walk the mean the rest of the way.
 */
const FIRST_SAMPLE_RATIO = 32;

/** Keys kept on disk. Beyond this, the least recently useful are dropped. */
const MAX_KEYS = 5000;

export function modelKey(host: string, type: ResourceType): string {
  return `${host}|${type}`;
}

/** The mean a key is born with: the sample, held to the prior's neighbourhood. */
function firstMean(type: ResourceType, bytes: number): number {
  const prior = DEFAULT_SIZES[type];
  // `websocket` is deliberately 0, and a zero prior gives a zero-width band that
  // would pin the key at zero for ever. No prior means nothing to clamp against.
  if (prior <= 0) return bytes;
  return Math.min(Math.max(bytes, prior / FIRST_SAMPLE_RATIO), prior * FIRST_SAMPLE_RATIO);
}

export class SizeModel {
  private samples = new Map<string, SizeSample>();
  private dirty = new Set<string>();
  private loaded = false;
  private loading: Promise<void> | null = null;

  /**
   * Reads the whole model into memory.
   *
   * The service worker is torn down every thirty idle seconds, so this runs
   * often; it is one `getAll` of at most 5,000 small records, which is cheaper
   * than the alternative of a database read on the hot path of every request.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const rows = await getAll<SizeSample>(STORES.sizeModel);
        for (const row of rows) {
          if (row && typeof row.key === "string") this.samples.set(row.key, row);
        }
      } catch (error) {
        // Degrade to the per-type defaults rather than reject. This is awaited on
        // the path that records every request, and a rejection here would be a
        // request silently missing from the ledger — and, because the promise is
        // memoised, every request after it too.
        console.error("Byte Budget: could not read the size model", error);
      }
      this.loaded = true;
      this.loading = null;
    })();
    return this.loading;
  }

  /** Best guess at the encoded size of a response, in bytes. */
  estimate(host: string, type: ResourceType): number {
    const sample = this.samples.get(modelKey(host, type));
    if (sample && sample.count > 0) return Math.round(sample.mean);
    return DEFAULT_SIZES[type];
  }

  /** How much of the estimate rests on observation, for the UI to disclose. */
  confidence(host: string, type: ResourceType): number {
    const sample = this.samples.get(modelKey(host, type));
    if (!sample) return 0;
    return Math.min(1, sample.count / MAX_WEIGHT);
  }

  /** Feeds a measured size back into the model. */
  observe(host: string, type: ResourceType, bytes: number): void {
    if (!host || bytes < 0 || !Number.isFinite(bytes)) return;
    const key = modelKey(host, type);
    const existing = this.samples.get(key);
    const now = Date.now();

    if (!existing || existing.count <= 0) {
      this.samples.set(key, { key, mean: firstMean(type, bytes), count: 1, updatedAt: now });
      this.dirty.add(key);
      return;
    }

    // A single 40 MB video segment in a list of 8 kB API responses should not
    // redefine the host, so a wild sample is pulled back towards the mean before
    // it is blended. It still counts, and enough of them still move the mean.
    const ceiling = existing.mean * OUTLIER_RATIO;
    const floor = existing.mean / OUTLIER_RATIO;
    const effective = Math.min(Math.max(bytes, floor), ceiling);
    const weight = Math.min(existing.count, MAX_WEIGHT);
    const mean = (existing.mean * weight + effective) / (weight + 1);

    this.samples.set(key, {
      key,
      mean,
      count: Math.min(existing.count + 1, MAX_WEIGHT),
      updatedAt: now,
    });
    this.dirty.add(key);
  }

  /** Writes everything observed since the last flush. */
  async flush(): Promise<void> {
    if (this.dirty.size === 0) return;
    const rows: SizeSample[] = [];
    for (const key of this.dirty) {
      const sample = this.samples.get(key);
      if (sample) rows.push(sample);
    }
    this.dirty.clear();
    await putMany(STORES.sizeModel, rows);
  }

  /**
   * Caps the store, dropping the keys least recently updated.
   *
   * Least-recently-used rather than least-observed: a host visited last year has
   * a well-trained mean that is worth nothing, and a host visited this morning
   * with two samples is worth keeping.
   */
  async prune(): Promise<void> {
    await this.load();
    const excess = this.samples.size - MAX_KEYS;
    if (excess <= 0) return;

    // Selection, not a sort. A prune drops the few keys that crossed the ceiling
    // since the last one, so ordering all 5,000 to take the oldest three is work
    // the worker does on an alarm for nothing. One pass holds the `excess` least
    // recently updated rows, ascending, and every key newer than the worst of them
    // — nearly all of them — costs one comparison.
    const doomed: SizeSample[] = [];
    for (const sample of this.samples.values()) {
      const worst = doomed[doomed.length - 1];
      if (doomed.length >= excess && worst && sample.updatedAt >= worst.updatedAt) continue;
      const at = doomed.findIndex((candidate) => candidate.updatedAt > sample.updatedAt);
      doomed.splice(at < 0 ? doomed.length : at, 0, sample);
      if (doomed.length > excess) doomed.pop();
    }

    const keys: string[] = [];
    for (const sample of doomed) {
      this.samples.delete(sample.key);
      this.dirty.delete(sample.key);
      keys.push(sample.key);
    }
    // One transaction for the batch: this loop used to await `remove` per key, so
    // dropping n keys was n separate commits.
    await removeMany(STORES.sizeModel, keys);
  }

  /**
   * Forgets everything learned.
   *
   * For "delete all recorded usage", which clears the `sizeModel` store on disk.
   * Without this the model survived in memory and the first observation afterwards
   * wrote its key straight back with the full accumulated count — so the learned
   * model outlived the button that says it deleted everything, and the dashboard's
   * storage report disagreed with itself about how many keys existed.
   */
  reset(): void {
    this.samples.clear();
    this.dirty.clear();
    // Still loaded: the store is empty, so there is nothing to read back, and a
    // reload here would race the clear that prompted it.
    this.loaded = true;
  }

  /** Exposed for the storage report in the dashboard. */
  get size(): number {
    return this.samples.size;
  }
}

export const sizeModel = new SizeModel();

/** Used by tests and by the first-run path, where nothing is loaded yet. */
export async function seedSample(sample: SizeSample): Promise<void> {
  await put(STORES.sizeModel, sample);
}

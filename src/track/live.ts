/**
 * What is eating the connection right now.
 *
 * Every other figure in the extension is a total over a window that ends now; this is
 * the one that answers "what is happening at this moment" — the tab left streaming in
 * the background, the page that turned out to be a 40 MB app bundle. It is fed from
 * the ledger's usage observer, which fires synchronously for every priced request, and
 * it keeps the last sixty seconds in memory and nothing more.
 *
 * Module memory is the right home, and the reason is the worker's own lifecycle: it
 * is torn down after thirty idle seconds, and thirty idle seconds means nothing was
 * eating the connection. A fresh worker answering "nothing in the last minute" is
 * telling the truth. Mirroring the ring to storage would cost a write per request to
 * preserve a number that is, by construction, only interesting while it is changing.
 *
 * Pure apart from the default clock, so the arithmetic runs under `node --test`.
 */

/** How far back "right now" reaches. Also the divisor for the per-second rate. */
export const LIVE_WINDOW_MS = 60_000;

/**
 * Samples kept, at most.
 *
 * A heavy page is a few hundred requests; sixty seconds of a busy browser is a few
 * thousand. Past this the oldest go, which shortens the window under extreme load
 * rather than growing without bound — and the figures still say how long the window
 * they cover is.
 */
const MAX_SAMPLES = 4000;

interface Sample {
  at: number;
  site: string;
  host: string;
  bytes: number;
}

export interface LiveHost {
  host: string;
  /** The site the bytes were attributed to — the tab's page, not the host's own. */
  site: string;
  bytes: number;
  requests: number;
}

export interface LiveSite {
  site: string;
  bytes: number;
  requests: number;
}

export interface LiveUsage {
  /** Milliseconds the figures cover. Normally `LIVE_WINDOW_MS`; shorter under the cap. */
  windowMs: number;
  /** Bytes across every host in the window. */
  total: number;
  /** Heaviest first. */
  hosts: LiveHost[];
  /** Heaviest first. */
  sites: LiveSite[];
}

/** Oldest first; a ring in all but name. */
const samples: Sample[] = [];

/** Records one priced request. Called from the ledger's observer, synchronously. */
export function noteLiveUsage(site: string, host: string, bytes: number, at = Date.now()): void {
  if (!(bytes > 0)) return;
  samples.push({ at, site, host: host || site, bytes });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

/** Drops samples older than the window. Cheap; the array is ordered by arrival. */
function trim(now: number): void {
  const cutoff = now - LIVE_WINDOW_MS;
  let drop = 0;
  // A backwards clock step leaves `at` in the future relative to `now`; those samples
  // are simply kept until the clock catches up, which errs towards showing traffic
  // rather than hiding it.
  while (drop < samples.length && samples[drop]!.at < cutoff) drop += 1;
  if (drop > 0) samples.splice(0, drop);
}

/**
 * The last minute, aggregated.
 *
 * `hosts` is capped by the caller's needs rather than here: a popup shows a handful,
 * a test wants all of them.
 */
export function liveUsage(now = Date.now()): LiveUsage {
  trim(now);
  const cutoff = now - LIVE_WINDOW_MS;
  const byHost = new Map<string, LiveHost>();
  const bySite = new Map<string, LiveSite>();
  let total = 0;
  let oldest = now;

  for (const sample of samples) {
    // `trim` drops the ordered prefix; a stale sample that arrived after a newer one
    // — the wall clock stepped back between two requests — survives it and is skipped
    // here instead. The ring is a bound on memory; this is the bound on the figure.
    if (sample.at < cutoff) continue;
    total += sample.bytes;
    if (sample.at < oldest) oldest = sample.at;

    const hostKey = `${sample.site}|${sample.host}`;
    const host = byHost.get(hostKey);
    if (host) {
      host.bytes += sample.bytes;
      host.requests += 1;
    } else {
      byHost.set(hostKey, {
        host: sample.host,
        site: sample.site,
        bytes: sample.bytes,
        requests: 1,
      });
    }

    const site = bySite.get(sample.site);
    if (site) {
      site.bytes += sample.bytes;
      site.requests += 1;
    } else {
      bySite.set(sample.site, { site: sample.site, bytes: sample.bytes, requests: 1 });
    }
  }

  return {
    // The window is the full minute whenever the ring has not overflowed; under the
    // cap it is however far back the oldest surviving sample reaches, so a rate
    // divided by it stays a rate rather than an undercount.
    windowMs: samples.length >= MAX_SAMPLES ? Math.max(1000, now - oldest) : LIVE_WINDOW_MS,
    total,
    hosts: [...byHost.values()].sort((a, b) => b.bytes - a.bytes),
    sites: [...bySite.values()].sort((a, b) => b.bytes - a.bytes),
  };
}

/** Forgets everything. For "delete all recorded usage", and for tests. */
export function resetLiveUsage(): void {
  samples.length = 0;
}

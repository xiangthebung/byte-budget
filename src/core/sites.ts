/**
 * Site keys: which bucket a request's bytes land in.
 *
 * Bytes are attributed to the *site* — the registrable domain of the tab's
 * top-level page — not to the host that served the response. A video stream from
 * `rr3---sn-8xgp1vo.googlevideo.com` is part of what YouTube costs you, and a
 * usage list that named the CDN instead would be technically true and useless.
 *
 * There is no browser API for "registrable domain", and shipping the full Public
 * Suffix List means shipping ~250 kB of data that changes without us. So this is
 * a rule plus a compact table: a set of second-level labels that act as a public
 * suffix under a set of ccTLDs, plus exact entries for the cases the rule misses
 * and for the hosting domains where each subdomain really is a different site.
 *
 * It is approximate, and the approximation is one-directional by design: an
 * unknown multi-label suffix groups *more* than it should (`example.co.zz` would
 * become `co.zz`), never less. Grouping too much shows one row where there should
 * be two; grouping too little scatters one site across a dozen rows, which is the
 * failure people actually notice. `tests/sites.test.mjs` pins the cases that
 * matter.
 */

/**
 * Second-level labels that act as a public suffix under the ccTLDs below.
 *
 * Deliberately conservative. `in` was removed after `in.gr` — a real Greek news
 * site — would have been read as a suffix, leaving every one of its pages under
 * `www.in.gr`. The same reasoning excludes `art`, `tm`, `web`, `info`, `biz`,
 * `name` and `pro`: each is a plausible registrable label, and being wrong that
 * way splits a site apart.
 */
const GENERIC_SECOND_LEVEL: ReadonlySet<string> = new Set([
  "ac",
  "asn",
  "asso",
  "co",
  "com",
  "edu",
  "gob",
  "gouv",
  "gov",
  "govt",
  "k12",
  "lib",
  "ltd",
  "mil",
  "ne",
  "net",
  "nhs",
  "nom",
  "or",
  "org",
  "plc",
  "police",
  "priv",
  "sch",
]);

/** ccTLDs that put registrations under a second level from the set above. */
const SECOND_LEVEL_TLDS: ReadonlySet<string> = new Set([
  "ae", "af", "ag", "ai", "ar", "at", "au", "az", "ba", "bd", "bh", "bn", "bo",
  "br", "bs", "bt", "bw", "bz", "cn", "co", "cr", "cu", "cy", "do", "dz", "ec",
  "ee", "eg", "es", "et", "fj", "fk", "gh", "gn", "gr", "gt", "gu", "hk", "hn",
  "hr", "hu", "id", "il", "im", "in", "iq", "ir", "je", "jm", "jo", "jp", "ke",
  "kh", "kn", "kr", "kw", "ky", "kz", "lb", "lc", "lk", "lr", "ls", "lv", "ly",
  "ma", "me", "mk", "mo", "mt", "mu", "mv", "mw", "mx", "my", "mz", "na", "nc",
  "nf", "ng", "ni", "np", "nz", "om", "pa", "pe", "pg", "ph", "pk", "pl", "pr",
  "ps", "pt", "py", "qa", "ro", "rs", "ru", "rw", "sa", "sb", "sc", "sd", "sg",
  "sh", "sl", "sn", "so", "sv", "sy", "sz", "th", "tj", "tn", "tr", "tt", "tw",
  "tz", "ua", "ug", "uk", "uy", "uz", "vc", "ve", "vi", "vn", "ye", "za", "zm",
  "zw",
]);

/**
 * Exact multi-label public suffixes.
 *
 * Two kinds, and they are here for the same reason. The first are cases the rule
 * above misses (`me.uk`, `gv.at`). The second are hosting domains where every
 * subdomain is a different person's site — grouping all of `github.io` into one
 * row would be like grouping the whole web into one row.
 */
const EXACT_SUFFIXES: ReadonlySet<string> = new Set([
  // Rule gaps.
  "me.uk",
  "mod.uk",
  "gv.at",
  "in.ua",
  "in.th",
  "in.net",
  "eu.org",
  "com.pl",
  "waw.pl",

  // One site per subdomain.
  "appspot.com",
  "blogspot.com",
  "firebaseapp.com",
  "github.io",
  "gitlab.io",
  "glitch.me",
  "herokuapp.com",
  "netlify.app",
  "pages.dev",
  "repl.co",
  "replit.dev",
  "surge.sh",
  "vercel.app",
  "web.app",
  "workers.dev",
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Normalises a hostname: lowercase, no trailing dot, no surrounding brackets. */
export function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.endsWith(".")) value = value.slice(0, -1);
  // An IPv6 literal arrives from `URL.hostname` wrapped in brackets.
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  return value;
}

/**
 * The public suffix of a host, or `null` when the host is not a domain name
 * (an IP address, `localhost`, a single-label intranet name).
 */
function publicSuffix(host: string): string | null {
  if (!host.includes(".")) return null;
  if (IPV4.test(host)) return null;
  if (host.includes(":")) return null; // IPv6

  const labels = host.split(".");
  const tld = labels[labels.length - 1];
  if (!tld) return null;

  if (labels.length >= 2) {
    const lastTwo = `${labels[labels.length - 2]}.${tld}`;
    if (EXACT_SUFFIXES.has(lastTwo)) return lastTwo;
    const secondLevel = labels[labels.length - 2];
    if (
      secondLevel &&
      SECOND_LEVEL_TLDS.has(tld) &&
      GENERIC_SECOND_LEVEL.has(secondLevel)
    ) {
      return lastTwo;
    }
  }
  return tld;
}

/**
 * The registrable domain of a host: one label in front of its public suffix.
 *
 * A host that *is* a public suffix, or that has no room for a label in front of
 * one, comes back unchanged. `www.` is not special-cased; it falls out of the
 * label count on its own.
 */
export function siteKeyFromHost(host: string): string {
  const normalized = normalizeHost(host);
  if (!normalized) return "";
  const suffix = publicSuffix(normalized);
  if (!suffix) return normalized;

  const suffixLabels = suffix.split(".").length;
  const labels = normalized.split(".");
  if (labels.length <= suffixLabels) return normalized;
  return labels.slice(labels.length - suffixLabels - 1).join(".");
}

/** `URL.hostname`, normalised, or `null` for anything that is not http(s). */
export function hostFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return normalizeHost(parsed.hostname);
  } catch {
    return null;
  }
}

/** The site key for a page URL, or `null` when it is not a trackable page. */
export function siteKeyFromUrl(url: string): string | null {
  const host = hostFromUrl(url);
  return host ? siteKeyFromHost(host) : null;
}

/** Scheme and host, with no path or query. See `Visit.origin` for why. */
export function originFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/** Whether a response host belongs to someone other than the site being viewed. */
export function isThirdParty(site: string, host: string): boolean {
  if (!site || site.startsWith("#")) return true;
  return siteKeyFromHost(host) !== site;
}

/**
 * A shorter host for display: drops a leading `www.`, which is never the
 * interesting part of a name in a list of forty of them.
 */
export function prettyHost(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * Site packs: rewriting a request to a smaller variant of the same thing.
 *
 * This is the only optimization that removes bytes rather than removing content. An
 * image CDN that will serve a 2048px JPEG will also serve a 680px one from the same
 * path, and on a phone-sized viewport the difference is invisible and about 85% of
 * the transfer. So the request is redirected before it is sent, and what arrives is
 * the smaller file.
 *
 * Every pack has to satisfy four things, and each is a unit test:
 *
 * 1. **It must match what it claims.** A pattern that misses is a pack that does
 *    nothing, quietly.
 * 2. **It must not match anything else.** A rewrite applied to the wrong URL is a
 *    broken image, and the person will blame the site.
 * 3. **It must not match its own output.** `declarativeNetRequest` re-evaluates a
 *    redirect, so a rule that matches what it produces is an infinite loop and the
 *    request fails outright. Every pattern here requires something the substitution
 *    removes.
 * 4. **It must not touch a signed URL.** Reddit's `preview.redd.it` was designed and
 *    then dropped for exactly this: its width parameter is covered by a signature, so
 *    changing it returns 403 and the image does not load at all. A pack that trades a
 *    smaller image for no image is worse than nothing.
 *
 * The `expectedRatio` on each pack is the fraction of the original transfer the
 * rewritten one is expected to be. It is only used to *model* a saving until a real
 * baseline for that URL has been observed, and anything derived from it is reported
 * as modelled. For images it is roughly the ratio of pixel areas, which is a decent
 * proxy for compressed size at a fixed quality.
 */

export interface Pack {
  id: string;
  /** The site or service, for the UI. */
  label: string;
  /** What it does, in one sentence, for the UI. */
  description: string;
  /** Hosts this pack rewrites, for display and for the exclusion check. */
  hosts: string[];
  /** RE2 syntax, as `declarativeNetRequest` requires. */
  regexFilter: string;
  /** `\1`-style backreferences into `regexFilter`. */
  regexSubstitution: string;
  resourceTypes: ("image" | "media" | "script" | "font" | "stylesheet")[];
  /** Expected rewritten size as a fraction of the original. Modelling only. */
  expectedRatio: number;
  /** Off by default when a rewrite is more likely to be noticed. */
  defaultOn: boolean;
}

/**
 * The width every image pack rewrites down to.
 *
 * 800 rather than something smaller because it still covers a full-width image on a
 * standard-density laptop screen, and because a pack whose results people notice is a
 * pack they switch off.
 */
export const TARGET_WIDTH = 800;

export const PACKS: readonly Pack[] = [
  {
    id: "twimg",
    label: "X / Twitter images",
    description:
      "Asks pbs.twimg.com for the 680px variant instead of the 2048px one. Same image, same path.",
    hosts: ["pbs.twimg.com"],
    // The whole URL is rebuilt from the media id and the format, because the only
    // other parameter twimg takes is the one being replaced.
    regexFilter:
      "^https://pbs\\.twimg\\.com/media/([A-Za-z0-9_-]+)\\?(?:.*&)?format=([a-z]+)(?:&.*)?name=(?:orig|large|medium|4096x4096|900x900)$",
    regexSubstitution: "https://pbs.twimg.com/media/\\1?format=\\2&name=small",
    resourceTypes: ["image"],
    // 680px vs 2048px on the long edge.
    expectedRatio: 0.18,
    defaultOn: true,
  },
  {
    id: "wikimedia",
    label: "Wikipedia and Wikimedia images",
    description:
      "Caps generated thumbnails at 800px wide. Wikimedia renders any width on demand, so nothing is missing.",
    hosts: ["upload.wikimedia.org"],
    // Four or more digits, so the 800px output cannot match and loop.
    regexFilter: "^(https://upload\\.wikimedia\\.org/wikipedia/[^/]+/thumb/.+/)\\d{4,}px-(.+)$",
    regexSubstitution: `\\1${TARGET_WIDTH}px-\\2`,
    resourceTypes: ["image"],
    expectedRatio: 0.3,
    defaultOn: true,
  },
  {
    id: "photon",
    label: "WordPress.com and Jetpack images",
    description:
      "Caps the Photon image proxy at 800px and asks for slightly stronger compression.",
    hosts: ["i0.wp.com", "i1.wp.com", "i2.wp.com"],
    regexFilter: "^(https://i[0-2]\\.wp\\.com/[^?]+\\?(?:[^&]*&)*?w=)\\d{4,}(.*)$",
    regexSubstitution: `\\1${TARGET_WIDTH}\\2`,
    resourceTypes: ["image"],
    expectedRatio: 0.35,
    defaultOn: true,
  },
  {
    id: "shopify",
    label: "Shopify product images",
    description: "Caps Shopify CDN images at 800px wide.",
    hosts: ["cdn.shopify.com"],
    regexFilter:
      "^(https://cdn\\.shopify\\.com/s/files/.+_)\\d{4,}x(\\d*\\.(?:jpg|jpeg|png|webp).*)$",
    regexSubstitution: `\\1${TARGET_WIDTH}x\\2`,
    resourceTypes: ["image"],
    expectedRatio: 0.35,
    defaultOn: true,
  },
  {
    id: "cloudinary",
    label: "Cloudinary images",
    description:
      "Adds automatic format and quality selection to unsigned Cloudinary URLs. Signed ones are left alone.",
    hosts: ["res.cloudinary.com"],
    // Requires a version segment straight after `upload/`, which is what a signed URL
    // does not have — and what the substitution displaces, so it cannot loop.
    regexFilter: "^(https://res\\.cloudinary\\.com/[^/]+/image/upload/)(v\\d+/.+)$",
    regexSubstitution: "\\1f_auto,q_auto:eco/\\2",
    resourceTypes: ["image"],
    expectedRatio: 0.55,
    defaultOn: true,
  },
];

export const PACKS_BY_ID: ReadonlyMap<string, Pack> = new Map(
  PACKS.map((pack) => [pack.id, pack]),
);

/**
 * Applies a pack's rewrite in JavaScript, so the packs can be tested without a browser.
 *
 * The two engines disagree about substitution syntax, and this is the translation.
 * Chrome's `regexSubstitution` writes backreferences as `\1` and treats `$` as an
 * ordinary character; `String.prototype.replace` writes them as `$1` and treats `$`
 * as special. So a literal `$` is doubled first, then `\1` is turned into `$1` —
 * in that order, or the `$` introduced by the second step would be escaped by the
 * first.
 *
 * The patterns themselves need no translation: RE2 and JavaScript agree on the subset
 * used above, which is why the packs stay inside it.
 *
 * Returns `null` when the pattern does not match, which is what the "must not match"
 * and "must not match its own output" tests assert.
 */
export function applyPack(pack: Pack, url: string): string | null {
  const pattern = new RegExp(pack.regexFilter);
  if (!pattern.test(url)) return null;
  const replacement = pack.regexSubstitution
    .replace(/\$/g, "$$$$")
    .replace(/\\(\d)/g, "$$$1");
  return url.replace(pattern, replacement);
}

/** Which pack, if any, claims a URL. First match wins, as in the rule set. */
export function packForUrl(url: string, enabled: (id: string) => boolean): Pack | null {
  for (const pack of PACKS) {
    if (!enabled(pack.id)) continue;
    if (new RegExp(pack.regexFilter).test(url)) return pack;
  }
  return null;
}

/**
 * Which pack, if any, caused an observed redirect.
 *
 * `declarativeNetRequest` applies a rewrite without telling anyone, so the only way to
 * see one is `webRequest.onBeforeRedirect` — which reports redirects from every source,
 * including the server's own. Attribution is by pattern: if an enabled pack claims the
 * original URL and the request went somewhere else, that redirect is ours.
 *
 * Deliberately not "does the substitution reproduce the redirect URL exactly". Chrome
 * evaluates the pattern with RE2 and normalises URLs on the way through, so an exact
 * string comparison would be a subtle source of missed attributions — and a missed
 * attribution here means an unreported saving, silently.
 */
export function packForRedirect(
  url: string,
  redirectUrl: string,
  enabled: (id: string) => boolean,
): Pack | null {
  if (!redirectUrl || redirectUrl === url) return null;
  return packForUrl(url, enabled);
}

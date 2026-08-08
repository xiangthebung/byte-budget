/**
 * Site packs: rewriting a request to a smaller variant of the same thing.
 *
 * This is the only optimization that removes bytes rather than removing content. An
 * image CDN that will serve a 2048px JPEG will also serve a 680px one from the same
 * path, and where the browser lays that image out at a few hundred CSS pixels the
 * difference is invisible and about 85% of the transfer. So the request is redirected
 * before it is sent, and what arrives is the smaller file. ("Invisible" is a claim
 * about a 1x display and only a 1x display — see `TARGET_WIDTH`.)
 *
 * Every pack has to satisfy five things, and each is a unit test:
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
 * 5. **The transformation must suit the media type.** Every pack here turns a raster
 *    photograph into a smaller raster photograph. The same rewrite handed to a vector,
 *    an animation or a document is not a smaller version of the same thing: Cloudinary
 *    passes an SVG through untouched only while *no* transformation is requested, so
 *    adding one rasterises it and a 6 kB logo comes back as a larger PNG that no longer
 *    scales on a HiDPI screen, no longer follows `currentColor`, and breaks every
 *    `mask-image` and sprite reference pointing at it. Each pattern therefore names the
 *    extensions it is willing to touch instead of accepting whatever sits at the path.
 *
 * The `expectedRatio` on each pack is the fraction of the original transfer the
 * rewritten one is expected to be. It is only used to *model* a saving until a real
 * baseline for that URL has been observed, and anything derived from it is reported
 * as modelled. For images it is roughly the ratio of pixel areas, which is a decent
 * proxy for compressed size at a fixed quality.
 */

import { t } from "../core/i18n";

export interface Pack {
  id: string;
  /** The site or service, for the UI. Already localised, from `corePack<Id>Label`. */
  label: string;
  /**
   * What it does, in one sentence, for the UI. Already localised, from
   * `corePack<Id>Description`.
   *
   * The sentence is a promise about the rule below it, and property 5 above is the
   * reason it has to stay one: `corePackCloudinaryDescription` names the media types
   * the pattern refuses to touch, and `corePackWikimediaDescription` names the cost on
   * a high-density screen. Neither is decoration.
   */
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
 * 800 covers a full-width image on a standard-density screen, and a pack whose results
 * people notice is a pack they switch off. It is *wrong* on a 2x display, and that is
 * not a rounding error: an 800-CSS-pixel slot picks a 1600px candidate there, so a
 * rewrite to 800 is the browser upscaling something the person can see, under
 * README.md:111's claim that packs remove bytes "without removing anything you would
 * see".
 *
 * The real fix is a ladder — 800 / 1200 / 1600, chosen once from `devicePixelRatio` and
 * the screen width. Neither exists in a service worker, so the value has to be measured
 * by an extension page and stored, and nothing writes it today. Until something does,
 * this stays fixed and the *floors* below carry the honesty instead: a pattern only
 * claims an image big enough that 800 is still a reduction on a 2x screen, and the
 * descriptions say so. Do not lower a floor back toward 1000 without shipping the
 * ladder first — that is the change that put a visibly softer image on the page.
 */
export const TARGET_WIDTH = 800;

export const PACKS: readonly Pack[] = [
  {
    id: "twimg",
    label: t("corePackTwimgLabel"),
    description: t("corePackTwimgDescription"),
    hosts: ["pbs.twimg.com"],
    // The whole URL is rebuilt from the media id and the format, because the only
    // other parameter twimg takes is the one being replaced.
    //
    // The format list is closed rather than `[a-z]+`: `name=small` asks for a resample,
    // and a resample is only the same picture when the picture is raster. An unknown
    // format arriving on this URL shape would be silently resampled as if it were one.
    regexFilter:
      "^https://pbs\\.twimg\\.com/media/([A-Za-z0-9_-]+)\\?(?:.*&)?format=(jpe?g|png|webp)(?:&.*)?name=(?:orig|large|medium|4096x4096|900x900)$",
    regexSubstitution: "https://pbs.twimg.com/media/\\1?format=\\2&name=small",
    resourceTypes: ["image"],
    // 680px vs 2048px on the long edge.
    expectedRatio: 0.18,
    defaultOn: true,
  },
  {
    id: "wikimedia",
    label: t("corePackWikimediaLabel"),
    description: t("corePackWikimediaDescription"),
    hosts: ["upload.wikimedia.org"],
    // The floor is 1300, and the two reasons behind that number are different.
    //
    // Above 800 so the rewritten URL cannot match this pattern and loop. Above 1200
    // because 1024 and 1200 are exactly the thumbnails a 2x display picks for a modest
    // slot, and the previous `\d{4,}` floor rewrote them to 800 — a picture the person
    // could see, made worse, in the name of saving bytes.
    //
    // Raster extensions only. MediaWiki refuses to re-render a large animated GIF, so a
    // rewritten `.gif` thumbnail comes back as the original or not at all.
    regexFilter:
      "^(https://upload\\.wikimedia\\.org/wikipedia/[^/]+/thumb/.+/)(?:1[3-9]\\d{2}|[2-9]\\d{3}|\\d{5,})px-(.+\\.(?:jpe?g|png|webp))$",
    regexSubstitution: `\\1${TARGET_WIDTH}px-\\2`,
    resourceTypes: ["image"],
    expectedRatio: 0.3,
    defaultOn: true,
  },
  {
    id: "photon",
    label: t("corePackPhotonLabel"),
    description: t("corePackPhotonDescription"),
    hosts: ["i0.wp.com", "i1.wp.com", "i2.wp.com"],
    /*
     * Only queries this pattern can read end to end, which is why every parameter it
     * tolerates is spelled out.
     *
     * Photon resolves `resize`, `fit` and `crop` before `w`, so on
     * `?resize=1600%2C900&w=1600` the old pattern rewrote a width that was already
     * inert: the response was still 1600px, but the URL had changed, so the request
     * became a redirect and a cache miss and `creditRewrite` booked roughly 1.86x the
     * transfer as saved. RE2 has no negative lookahead, so "and nothing that overrides
     * the width" can only be written as "and nothing but these". A parameter this list
     * does not know means no rewrite, which is the failure direction that costs bytes
     * rather than credibility.
     *
     * `fit` is rewritten rather than skipped — it is a bounding box, so a smaller width
     * can only produce a smaller or equal image. `resize` and `crop` frame exactly, and
     * moving one of their dimensions re-crops the picture instead of shrinking it.
     */
    regexFilter:
      "^(https://i[0-2]\\.wp\\.com/[^?]+\\.(?:jpe?g|png|webp)\\?(?:(?:ssl|quality|strip|zoom|h)=[^&]*&)*(?:w|fit)=)\\d{4,}((?:(?:%2C|,)\\d+)?(?:&(?:ssl|quality|strip|zoom|h)=[^&]*)*)$",
    regexSubstitution: `\\1${TARGET_WIDTH}\\2`,
    resourceTypes: ["image"],
    expectedRatio: 0.35,
    defaultOn: true,
  },
  {
    id: "shopify",
    label: t("corePackShopifyLabel"),
    description: t("corePackShopifyDescription"),
    hosts: ["cdn.shopify.com"],
    // Shopify writes the size into the filename and then decorates it: `_crop_center`
    // picks the framing, `@2x` asks for double the named size. The tail used to be
    // `\d*\.(ext)`, so both decorated forms — which is most of what a theme emits for a
    // product grid — were missed entirely and the pack looked like it was working
    // because the plain form still matched.
    regexFilter:
      "^(https://cdn\\.shopify\\.com/s/files/.+_)\\d{4,}x(\\d*(?:_crop_[a-z]+)?(?:@\\dx)?\\.(?:jpe?g|png|webp)(?:[?#].*)?)$",
    regexSubstitution: `\\1${TARGET_WIDTH}x\\2`,
    resourceTypes: ["image"],
    expectedRatio: 0.35,
    defaultOn: true,
  },
  {
    id: "shopifyWidth",
    label: t("corePackShopifyWidthLabel"),
    description: t("corePackShopifyWidthDescription"),
    hosts: ["cdn.shopify.com"],
    /*
     * A second pack rather than a branch in the one above, because the two forms need
     * different substitutions and an RE2 alternation would have to number its groups
     * across both — a pattern that quietly pairs one form's prefix with the other's tail
     * is precisely the "matches something else" failure the pack tests exist to catch.
     *
     * This is the form modern themes emit through Liquid's `image_url` filter
     * (`?v=…&width=1946`); the sized filename is the legacy one. A shop on a recent
     * theme was getting nothing from this pack at all.
     *
     * `crop` is deliberately absent from the tolerated parameters. With `crop` present,
     * `width` and `height` frame the picture exactly rather than bound it, so moving the
     * width alone re-crops it. Same RE2 constraint as Photon: "no crop" has to be
     * written as "only these".
     */
    regexFilter:
      "^(https://cdn\\.shopify\\.com/s/files/[^?]+\\.(?:jpe?g|png|webp)\\?(?:(?:v|height|format|quality|pad_color)=[^&]*&)*width=)\\d{4,}((?:&(?:v|height|format|quality|pad_color)=[^&]*)*)$",
    regexSubstitution: `\\1${TARGET_WIDTH}\\2`,
    resourceTypes: ["image"],
    expectedRatio: 0.35,
    defaultOn: true,
  },
  {
    id: "cloudinary",
    label: t("corePackCloudinaryLabel"),
    description: t("corePackCloudinaryDescription"),
    hosts: ["res.cloudinary.com"],
    // Requires a version segment straight after `upload/`, which is what a signed URL
    // does not have — and what the substitution displaces, so it cannot loop.
    //
    // The extension list is load-bearing, not decoration. `/image/upload/` also serves
    // SVG, GIF, ICO and PDF, and Cloudinary delivers those untouched only while no
    // transformation is asked for. `f_auto,q_auto:eco` is a transformation: it
    // rasterises the vector, re-encodes the animation, and turns a 6 kB logo into a
    // larger PNG that stops scaling on a HiDPI screen and breaks every `mask-image`,
    // `currentColor` and sprite reference pointing at it.
    regexFilter:
      "^(https://res\\.cloudinary\\.com/[^/]+/image/upload/)(v\\d+/[^?#]+\\.(?:jpe?g|png|webp)(?:[?#].*)?)$",
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
 * used above, which is why the packs stay inside it. They do *not* agree on case by
 * default — `RegExp` is case-sensitive, `declarativeNetRequest` is not — so
 * `optimize/rules.ts` sets `isUrlFilterCaseSensitive: true` on every pack rule. Without
 * it this function models a browser that rewrites URLs it never sees, and the ones it
 * misses are rewrites nothing can attribute or credit afterwards.
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

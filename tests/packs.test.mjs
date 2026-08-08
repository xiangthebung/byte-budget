/**
 * Tests for the site packs in `src/optimize/packs.ts`.
 *
 * A pack rewrites someone's image request. Five things have to hold for that to be a
 * good trade rather than a broken page, and each is tested here because none of them is
 * visible from reading the regex:
 *
 * 1. It matches what it claims.
 * 2. It matches nothing else.
 * 3. It does not match its own output. `declarativeNetRequest` re-evaluates a redirect,
 *    so a rule that matches what it produces is an infinite loop and the request fails
 *    outright — the one failure mode worse than not optimizing.
 * 4. It leaves signed URLs alone, because changing a signed parameter returns 403 and
 *    the image does not load at all.
 * 5. The transformation suits the media type. Resampling or re-encoding a vector, an
 *    animation or a document is not a smaller version of the same thing: a Cloudinary
 *    transformation rasterises an SVG, so the "saving" is a larger file that stops
 *    scaling and breaks every `mask-image` and sprite reference pointing at it.
 *
 * Everything here runs the patterns through `RegExp` with no flags, which is the same
 * semantics Chrome uses only because `optimize/rules.ts` sets
 * `isUrlFilterCaseSensitive: true` on every pack rule. That is asserted below rather
 * than assumed: without it Chrome matches case-insensitively, this file tests one engine
 * and ships another, and properties 2 and 3 are unproven for the thing that runs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPack,
  packForRedirect,
  packForUrl,
  PACKS,
  PACKS_BY_ID,
  TARGET_WIDTH,
} from "../src/optimize/packs.ts";
import { ANALYTICS_DOMAINS, optimizeRules } from "../src/optimize/rules.ts";
import { defaultOptimizeSettings } from "../src/optimize/features.ts";

const pack = (id) => {
  const found = PACKS_BY_ID.get(id);
  assert.ok(found, `no pack named ${id}`);
  return found;
};

const all = () => true;

const enabled = () => ({ ...defaultOptimizeSettings(), enabled: true });

/** One URL per pack that the pack is meant to claim. */
const SAMPLES = {
  twimg: "https://pbs.twimg.com/media/Gk3xQb2X0AA1abc?format=jpg&name=large",
  wikimedia:
    "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Example.jpg/1920px-Example.jpg",
  photon: "https://i0.wp.com/example.com/photo.jpg?w=1600&ssl=1",
  shopify: "https://cdn.shopify.com/s/files/1/0000/0001/products/shoe_1600x.jpg?v=1",
  shopifyWidth: "https://cdn.shopify.com/s/files/1/0000/0001/files/shoe.jpg?v=1&width=1946",
  cloudinary: "https://res.cloudinary.com/demo/image/upload/v1234567/sample.jpg",
};

test("every pack is well formed", () => {
  const ids = new Set();
  for (const entry of PACKS) {
    assert.ok(entry.id && !ids.has(entry.id), `duplicate or missing id: ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.label, `${entry.id} has no label`);
    assert.ok(entry.description, `${entry.id} has no description`);
    assert.ok(entry.hosts.length > 0, `${entry.id} names no hosts`);
    assert.ok(entry.resourceTypes.length > 0, `${entry.id} has no resource types`);
    assert.ok(
      entry.expectedRatio > 0 && entry.expectedRatio < 1,
      `${entry.id} has an implausible ratio: ${entry.expectedRatio}`,
    );
    // The regex has to compile. Chrome uses RE2 and rejects an invalid pattern by
    // refusing the whole rule set, so a broken one here disables every other rule too.
    assert.doesNotThrow(() => new RegExp(entry.regexFilter), `${entry.id} regex is invalid`);
  }
});

test("no pack matches its own output, so a redirect cannot loop", () => {
  for (const entry of PACKS) {
    const input = SAMPLES[entry.id];
    assert.ok(input, `no sample URL for pack ${entry.id}`);
    const once = applyPack(entry, input);
    assert.ok(once, `${entry.id} did not match its own sample`);
    assert.notEqual(once, input, `${entry.id} rewrote to the same URL`);
    assert.equal(
      applyPack(entry, once),
      null,
      `${entry.id} matches its own output: ${once} — this is an infinite redirect`,
    );
  }
});

test("a chain across packs settles too, not just each pack on its own", () => {
  /*
   * Property 3 held one pack at a time is not enough once two packs can claim one URL —
   * a Shopify asset can carry both a sized filename and a `width=` parameter, and
   * `declarativeNetRequest` re-evaluates the whole rule set after every rewrite. The
   * loop that fails a request outright can just as easily run between two rules as
   * inside one.
   */
  const starts = [
    ...Object.values(SAMPLES),
    "https://cdn.shopify.com/s/files/1/0/1/products/shoe_2048x2048.jpg?v=1&width=1946",
  ];
  for (const start of starts) {
    let url = start;
    let hops = 0;
    while (hops < 10) {
      const claimed = packForUrl(url, all);
      if (!claimed) break;
      const next = applyPack(claimed, url);
      assert.ok(next, `${claimed.id} claimed ${url} and then did not rewrite it`);
      assert.notEqual(next, url, `${claimed.id} rewrote ${url} to itself`);
      url = next;
      hops += 1;
    }
    assert.ok(hops < 10, `rewriting ${start} never settled — last URL was ${url}`);
  }
});

test("X image URLs are asked for at the small variant", () => {
  const twimg = pack("twimg");
  assert.equal(
    applyPack(twimg, "https://pbs.twimg.com/media/Gk3xQb2X0AA1abc?format=jpg&name=large"),
    "https://pbs.twimg.com/media/Gk3xQb2X0AA1abc?format=jpg&name=small",
  );
  assert.equal(
    applyPack(twimg, "https://pbs.twimg.com/media/Abc-1_x?format=png&name=4096x4096"),
    "https://pbs.twimg.com/media/Abc-1_x?format=png&name=small",
  );

  // Already small, a profile image, another host: none of ours.
  assert.equal(applyPack(twimg, "https://pbs.twimg.com/media/Abc?format=jpg&name=small"), null);
  assert.equal(
    applyPack(twimg, "https://pbs.twimg.com/profile_images/1/abc_400x400.jpg"),
    null,
  );
  assert.equal(applyPack(twimg, "https://example.com/media/Abc?format=jpg&name=large"), null);
});

test("Wikimedia thumbnails are capped, and only the ones a 2x screen does not need", () => {
  const wikimedia = pack("wikimedia");
  const thumb = (name) =>
    `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Example.jpg/${name}`;

  assert.equal(
    applyPack(wikimedia, thumb("1920px-Example.jpg")),
    thumb(`${TARGET_WIDTH}px-Example.jpg`),
  );
  assert.equal(
    applyPack(wikimedia, thumb("2560px-Example.png")),
    thumb(`${TARGET_WIDTH}px-Example.png`),
  );

  // Already smaller than the target: three digits, left alone. Rewriting a 220px
  // thumbnail *up* to 800px would cost bytes rather than save them.
  assert.equal(applyPack(wikimedia, thumb("220px-Example.jpg")), null);

  /*
   * And 1024 and 1200 are left alone too, which the old `\d{4,}` floor did not do.
   * Those are the candidates a 2x display picks for a 512 or 600 CSS-pixel slot, so
   * rewriting them to 800 makes the browser upscale a picture the person is looking at
   * — a visible loss, booked as a saving. See TARGET_WIDTH for why the fix lives in the
   * floor rather than in the target width.
   */
  assert.equal(applyPack(wikimedia, thumb("1024px-Example.jpg")), null);
  assert.equal(applyPack(wikimedia, thumb("1200px-Example.jpg")), null);
  assert.equal(applyPack(wikimedia, thumb("1250px-Example.jpg")), null);
  // The first width above the floor still matches, and so does the smoke test's 1600.
  assert.ok(applyPack(wikimedia, thumb("1300px-Example.jpg")));
  assert.ok(applyPack(wikimedia, thumb("1600px-Example.png")));

  // A full-size original is not a generated thumbnail; there is no smaller variant.
  assert.equal(
    applyPack(wikimedia, "https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.jpg"),
    null,
  );
});

test("Photon rewrites the width that actually decides the size, and nothing else", () => {
  const photon = pack("photon");
  const rewritten = applyPack(photon, "https://i0.wp.com/example.com/photo.jpg?w=1600&ssl=1");
  assert.equal(rewritten, `https://i0.wp.com/example.com/photo.jpg?w=${TARGET_WIDTH}&ssl=1`);
  // `ssl=1` is what makes Photon fetch the source over https. Dropping it would break
  // images on any site that only serves https, which is all of them.
  assert.match(rewritten, /ssl=1/);

  assert.equal(
    applyPack(photon, "https://i2.wp.com/example.com/a.png?w=2000"),
    `https://i2.wp.com/example.com/a.png?w=${TARGET_WIDTH}`,
  );
  assert.equal(
    applyPack(photon, "https://i0.wp.com/example.com/a.png?quality=80&w=1600&ssl=1"),
    `https://i0.wp.com/example.com/a.png?quality=80&w=${TARGET_WIDTH}&ssl=1`,
  );
  assert.equal(applyPack(photon, "https://i0.wp.com/example.com/a.png?w=600"), null);
  assert.equal(applyPack(photon, "https://i0.wp.com/example.com/a.png"), null);

  /*
   * Photon resolves `resize` and `crop` before `w`, so rewriting `w` on these URLs
   * changed the URL without changing one byte of the response: a redirect, a cache
   * miss, and `creditRewrite` booking roughly 1.86x the transfer as saved. The rewrite
   * has to not happen at all, not merely be attributed differently.
   */
  assert.equal(
    applyPack(photon, "https://i0.wp.com/example.com/a.jpg?resize=1600%2C900&w=1600&ssl=1"),
    null,
  );
  assert.equal(applyPack(photon, "https://i0.wp.com/example.com/a.jpg?w=1600&resize=1600,900"), null);
  assert.equal(
    applyPack(photon, "https://i0.wp.com/example.com/a.jpg?crop=0px%2C0px%2C100px%2C100px&w=1600"),
    null,
  );

  // `fit` is a bounding box, so shrinking its width can only shrink the result — and it
  // used to be missed entirely when it appeared without `w`.
  assert.equal(
    applyPack(photon, "https://i0.wp.com/example.com/a.jpg?fit=1600%2C900&ssl=1"),
    `https://i0.wp.com/example.com/a.jpg?fit=${TARGET_WIDTH}%2C900&ssl=1`,
  );
  assert.equal(
    applyPack(photon, "https://i0.wp.com/example.com/a.jpg?ssl=1&fit=1600,900"),
    `https://i0.wp.com/example.com/a.jpg?ssl=1&fit=${TARGET_WIDTH},900`,
  );

  // A parameter the pattern cannot name might be another one that overrides the width,
  // and RE2 has no way to ask "is it one of those". Not rewriting is the safe answer.
  assert.equal(applyPack(photon, "https://i0.wp.com/example.com/a.jpg?w=1600&unknown=1"), null);
});

test("Shopify sized filenames are capped, including the decorated forms", () => {
  const shopify = pack("shopify");
  assert.equal(
    applyPack(shopify, "https://cdn.shopify.com/s/files/1/0000/0001/products/shoe_1600x.jpg?v=1"),
    `https://cdn.shopify.com/s/files/1/0000/0001/products/shoe_${TARGET_WIDTH}x.jpg?v=1`,
  );
  assert.equal(
    applyPack(shopify, "https://cdn.shopify.com/s/files/1/0/1/products/shoe_1024x1024.png"),
    `https://cdn.shopify.com/s/files/1/0/1/products/shoe_${TARGET_WIDTH}x1024.png`,
  );
  // The two forms a modern theme decorates the size with, both missed by the old tail.
  assert.equal(
    applyPack(shopify, "https://cdn.shopify.com/s/files/1/0/1/products/shoe_2048x2048_crop_center.jpg"),
    `https://cdn.shopify.com/s/files/1/0/1/products/shoe_${TARGET_WIDTH}x2048_crop_center.jpg`,
  );
  assert.equal(
    applyPack(shopify, "https://cdn.shopify.com/s/files/1/0/1/products/shoe_1024x1024@2x.jpg"),
    `https://cdn.shopify.com/s/files/1/0/1/products/shoe_${TARGET_WIDTH}x1024@2x.jpg`,
  );

  assert.equal(
    applyPack(shopify, "https://cdn.shopify.com/s/files/1/0/1/products/shoe_400x.jpg"),
    null,
  );
  // Each new form's own output, which is the loop this pack's floor exists to prevent.
  for (const output of [
    `shoe_${TARGET_WIDTH}x2048_crop_center.jpg`,
    `shoe_${TARGET_WIDTH}x1024@2x.jpg`,
    `shoe_${TARGET_WIDTH}x.jpg?v=1`,
  ]) {
    assert.equal(
      applyPack(shopify, `https://cdn.shopify.com/s/files/1/0/1/products/${output}`),
      null,
      `shopify matches its own output: ${output}`,
    );
  }
});

test("Shopify theme images are capped through the width parameter", () => {
  const width = pack("shopifyWidth");
  const file = "https://cdn.shopify.com/s/files/1/0000/0001/files/shoe.jpg";

  // What Liquid's `image_url` filter emits, in both parameter orders.
  assert.equal(applyPack(width, `${file}?v=1&width=1946`), `${file}?v=1&width=${TARGET_WIDTH}`);
  assert.equal(applyPack(width, `${file}?width=1946&v=1`), `${file}?width=${TARGET_WIDTH}&v=1`);
  assert.equal(
    applyPack(width, `${file}?v=1&width=1946&height=1200`),
    `${file}?v=1&width=${TARGET_WIDTH}&height=1200`,
  );

  // Its own output, and a width already at or below the target.
  assert.equal(applyPack(width, `${file}?v=1&width=${TARGET_WIDTH}`), null);
  assert.equal(applyPack(width, `${file}?v=1&width=600`), null);

  // With `crop`, width and height frame the picture exactly instead of bounding it, so
  // moving the width alone re-crops it rather than shrinking it.
  assert.equal(applyPack(width, `${file}?v=1&width=1946&height=1200&crop=center`), null);
  assert.equal(applyPack(width, `${file}?crop=center&width=1946`), null);
});

test("Cloudinary transforms are added, and signed URLs are left alone", () => {
  const cloudinary = pack("cloudinary");
  assert.equal(
    applyPack(cloudinary, "https://res.cloudinary.com/demo/image/upload/v1234567/sample.jpg"),
    "https://res.cloudinary.com/demo/image/upload/f_auto,q_auto:eco/v1234567/sample.jpg",
  );

  // A signature sits where the version would be, and changing anything under it returns
  // an error rather than a smaller image.
  assert.equal(
    applyPack(
      cloudinary,
      "https://res.cloudinary.com/demo/image/upload/s--abc123--/v1234567/sample.jpg",
    ),
    null,
  );
  // An already-transformed URL is left alone rather than double-transformed.
  assert.equal(
    applyPack(cloudinary, "https://res.cloudinary.com/demo/image/upload/w_400/v1/sample.jpg"),
    null,
  );
});

test("a pack only rewrites what its transformation is a smaller version of", () => {
  /*
   * Property 5. Every one of these URLs is the exact shape the pack claims, differing
   * only in what is at the end of it — which is the whole point: the pattern cannot lean
   * on the path to tell it what the bytes are.
   *
   * Cloudinary is the one that made this a property rather than a footnote. It serves
   * SVG, GIF, ICO and PDF from `/image/upload/`, and passes them through untouched only
   * while no transformation is requested. Adding `f_auto,q_auto:eco` rasterises the
   * vector, so a 6 kB logo comes back as a larger PNG that no longer scales on a HiDPI
   * screen, no longer follows `currentColor`, and breaks every sprite reference to it —
   * a rewrite that costs bytes *and* breaks the page, credited as a saving.
   */
  const cases = {
    twimg: [
      "https://pbs.twimg.com/media/Abc?format=svg&name=large",
      "https://pbs.twimg.com/media/Abc?format=gif&name=large",
    ],
    wikimedia: [
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/E.gif/1920px-E.gif",
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/E.svg/1920px-E.svg",
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/E.ico/1920px-E.ico",
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/E.pdf/1920px-E.pdf",
    ],
    photon: [
      "https://i0.wp.com/example.com/logo.svg?w=1600&ssl=1",
      "https://i0.wp.com/example.com/loop.gif?w=1600&ssl=1",
      "https://i0.wp.com/example.com/icon.ico?w=1600&ssl=1",
      "https://i0.wp.com/example.com/manual.pdf?w=1600&ssl=1",
    ],
    shopify: [
      "https://cdn.shopify.com/s/files/1/0/1/products/logo_2048x2048.svg",
      "https://cdn.shopify.com/s/files/1/0/1/products/loop_2048x2048.gif",
      "https://cdn.shopify.com/s/files/1/0/1/products/icon_2048x2048.ico",
      "https://cdn.shopify.com/s/files/1/0/1/products/sizing_2048x2048.pdf",
    ],
    shopifyWidth: [
      "https://cdn.shopify.com/s/files/1/0/1/files/logo.svg?v=1&width=1946",
      "https://cdn.shopify.com/s/files/1/0/1/files/loop.gif?v=1&width=1946",
      "https://cdn.shopify.com/s/files/1/0/1/files/icon.ico?v=1&width=1946",
      "https://cdn.shopify.com/s/files/1/0/1/files/sizing.pdf?v=1&width=1946",
    ],
    cloudinary: [
      "https://res.cloudinary.com/demo/image/upload/v1234567/logo.svg",
      "https://res.cloudinary.com/demo/image/upload/v1234567/loop.gif",
      "https://res.cloudinary.com/demo/image/upload/v1234567/icon.ico",
      "https://res.cloudinary.com/demo/image/upload/v1234567/brochure.pdf",
    ],
  };

  for (const entry of PACKS) {
    const urls = cases[entry.id];
    assert.ok(urls, `${entry.id} has no media-type cases — property 5 is untested for it`);
    for (const url of urls) {
      assert.equal(applyPack(entry, url), null, `${entry.id} would transform ${url}`);
      // And no other pack picks it up on the way past.
      assert.equal(packForUrl(url, all), null, `some pack claims ${url}`);
    }
  }
});

test("a description promises only what the substitution actually asks for", () => {
  /*
   * The Photon description read "and asks for slightly stronger compression" against a
   * substitution that only replaced a width. Nothing in the rule ever said `quality` to
   * the CDN — the claim existed solely in the one sentence a person reads before
   * deciding whether to trust the pack.
   *
   * The other pack tests keep the pattern honest about the URL. This one keeps the
   * sentence honest about the pattern, which is the same class of drift and the only
   * one a user can actually see.
   */
  const claims = [
    { about: "compression or quality", claim: /compress|quality/i, asks: /q_auto|quality=/ },
    { about: "format selection", claim: /\bformats?\b/i, asks: /f_auto|format=/ },
    { about: "cropping", claim: /\bcrops?\b/i, asks: /crop/ },
  ];

  for (const entry of PACKS) {
    for (const { about, claim, asks } of claims) {
      if (!claim.test(entry.description)) continue;
      assert.match(
        entry.regexSubstitution,
        asks,
        `${entry.id} promises ${about} in its description but its substitution never asks for it: ${entry.regexSubstitution}`,
      );
    }
  }
});

test("pack rules match case-sensitively, because the JavaScript copies do", () => {
  const rules = optimizeRules({ settings: enabled(), holdoutTabIds: [] });
  const redirects = rules.filter((rule) => rule.action.type === "redirect");
  assert.equal(redirects.length, PACKS.length, "one redirect rule per pack");
  for (const rule of redirects) {
    assert.equal(
      rule.condition.isUrlFilterCaseSensitive,
      true,
      `a pack rule left case sensitivity to Chrome's default, which is false: ${rule.condition.regexFilter}`,
    );
  }

  /*
   * The concrete failure the flag prevents. With Chrome case-insensitive and `RegExp`
   * case-sensitive, this URL was rewritten by the browser and then claimed by no pack,
   * so `packForRedirect` returned null, `observeBaseline` never ran, and a real saving
   * was made and never counted. Both engines now say no.
   */
  const shouty =
    "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Example.jpg/1920PX-Example.JPG";
  assert.equal(applyPack(pack("wikimedia"), shouty), null);
  assert.equal(packForUrl(shouty, all), null);
  assert.equal(applyPack(pack("photon"), "https://i0.wp.com/example.com/photo.JPG?w=1600"), null);
});

test("packs only claim URLs when they are switched on", () => {
  const url = "https://pbs.twimg.com/media/Abc?format=jpg&name=large";
  assert.equal(packForUrl(url, all)?.id, "twimg");
  assert.equal(packForUrl(url, () => false), null);
  assert.equal(packForUrl("https://example.com/a.jpg", all), null);
});

test("a redirect is attributed only when a pack claims the original", () => {
  const original = "https://pbs.twimg.com/media/Abc?format=jpg&name=large";
  const rewritten = "https://pbs.twimg.com/media/Abc?format=jpg&name=small";

  assert.equal(packForRedirect(original, rewritten, all)?.id, "twimg");
  // A redirect that went nowhere is not a rewrite.
  assert.equal(packForRedirect(original, original, all), null);
  assert.equal(packForRedirect(original, "", all), null);
  // The server's own redirect on a URL no pack claims must not be credited to us.
  assert.equal(packForRedirect("https://example.com/a", "https://example.com/b", all), null);
});

/* ------------------------------------------------------------------ *
 * The beacon block, which is a destination list and so is tested like one
 * ------------------------------------------------------------------ */

const coveredByBlock = (host) =>
  ANALYTICS_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));

test("the beacon block is scoped to analytics destinations", () => {
  const blocks = optimizeRules({ settings: enabled(), holdoutTabIds: [] }).filter(
    (rule) => rule.action.type === "block",
  );
  assert.equal(blocks.length, 1, "beacons are blocked by default, fonts are not");
  assert.deepEqual(blocks[0].condition.resourceTypes, ["ping"]);
  assert.deepEqual(
    blocks[0].condition.requestDomains,
    [...ANALYTICS_DOMAINS],
    "an unscoped ping block takes every sendBeacon with it, not just the tracking ones",
  );

  const seen = new Set();
  for (const domain of ANALYTICS_DOMAINS) {
    // `requestDomains` takes a bare registrable domain and covers subdomains implicitly.
    // A scheme, a path or a leading dot in here is silently a domain that matches
    // nothing, so the feature would look scoped and block nothing at all.
    assert.match(domain, /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/, `not a bare domain: ${domain}`);
    assert.ok(!seen.has(domain), `duplicate domain: ${domain}`);
    seen.add(domain);
  }

  const off = {
    ...enabled(),
    features: { ...defaultOptimizeSettings().features, blockBeacons: false },
  };
  assert.equal(
    optimizeRules({ settings: off, holdoutTabIds: [] }).filter(
      (rule) => rule.action.type === "block",
    ).length,
    0,
  );
});

test("the beacon block matches what it claims, and nothing else", () => {
  for (const host of [
    "google-analytics.com",
    "www.google-analytics.com",
    "region1.google-analytics.com",
    "www.googletagmanager.com",
    "stats.g.doubleclick.net",
    "api.segment.io",
    "in.hotjar.com",
    "api2.amplitude.com",
  ]) {
    assert.ok(coveredByBlock(host), `${host} is a tracking destination and is not covered`);
  }

  /*
   * The other half, and the reason the rule needed scoping at all. `sendBeacon` is how a
   * page flushes unsaved editor state on `pagehide`, posts a CSP violation, and reports
   * a JavaScript error — all to the site's own origin or to a crash reporter. Blocking
   * those is not an invisible saving, it is losing something the person typed.
   */
  for (const host of [
    "example.com",
    "docs.google.com",
    "mail.google.com",
    "github.com",
    "www.wikipedia.org",
    "o12345.ingest.sentry.io",
    "notify.bugsnag.com",
    "api.myshop.example",
  ]) {
    assert.equal(coveredByBlock(host), false, `${host} would lose its beacons`);
  }
});

test("the font block stays global, so scoping one feature did not scope the other", () => {
  const withFonts = {
    ...enabled(),
    features: { ...defaultOptimizeSettings().features, systemFonts: true },
  };
  const fonts = optimizeRules({ settings: withFonts, holdoutTabIds: [] }).find(
    (rule) => rule.action.type === "block" && rule.condition.resourceTypes.includes("font"),
  );
  assert.ok(fonts, "systemFonts installs a block rule");
  assert.equal(
    fonts.condition.requestDomains,
    undefined,
    "downloadable fonts come from everywhere; a destination list would silently disable this",
  );
});

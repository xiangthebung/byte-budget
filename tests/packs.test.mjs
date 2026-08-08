/**
 * Tests for the site packs in `src/optimize/packs.ts`.
 *
 * A pack rewrites someone's image request. Four things have to hold for that to be a
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

const pack = (id) => {
  const found = PACKS_BY_ID.get(id);
  assert.ok(found, `no pack named ${id}`);
  return found;
};

const all = () => true;

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
  const samples = {
    twimg: "https://pbs.twimg.com/media/Gk3xQb2X0AA1abc?format=jpg&name=large",
    wikimedia:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Example.jpg/1920px-Example.jpg",
    photon: "https://i0.wp.com/example.com/photo.jpg?w=1600&ssl=1",
    shopify: "https://cdn.shopify.com/s/files/1/0000/0001/products/shoe_1600x.jpg?v=1",
    cloudinary: "https://res.cloudinary.com/demo/image/upload/v1234567/sample.jpg",
  };

  for (const entry of PACKS) {
    const input = samples[entry.id];
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

test("Wikimedia thumbnails are capped, and only the large ones", () => {
  const wikimedia = pack("wikimedia");
  assert.equal(
    applyPack(
      wikimedia,
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Example.jpg/1920px-Example.jpg",
    ),
    `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Example.jpg/${TARGET_WIDTH}px-Example.jpg`,
  );

  // Already smaller than the target: three digits, left alone. Rewriting a 220px
  // thumbnail *up* to 800px would cost bytes rather than save them.
  assert.equal(
    applyPack(
      wikimedia,
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Example.jpg/220px-Example.jpg",
    ),
    null,
  );
  // A full-size original is not a generated thumbnail; there is no smaller variant.
  assert.equal(
    applyPack(wikimedia, "https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.jpg"),
    null,
  );
});

test("Photon URLs keep their other parameters", () => {
  const photon = pack("photon");
  const rewritten = applyPack(photon, "https://i0.wp.com/example.com/photo.jpg?w=1600&ssl=1");
  assert.equal(rewritten, `https://i0.wp.com/example.com/photo.jpg?w=${TARGET_WIDTH}&ssl=1`);
  // `ssl=1` is what makes Photon fetch the source over https. Dropping it would break
  // images on any site that only serves https, which is all of them.
  assert.match(rewritten, /ssl=1/);

  assert.equal(applyPack(photon, "https://i2.wp.com/example.com/a.png?w=2000"), `https://i2.wp.com/example.com/a.png?w=${TARGET_WIDTH}`);
  assert.equal(applyPack(photon, "https://i0.wp.com/example.com/a.png?w=600"), null);
  assert.equal(applyPack(photon, "https://i0.wp.com/example.com/a.png"), null);
});

test("Shopify images are capped without disturbing the version query", () => {
  const shopify = pack("shopify");
  assert.equal(
    applyPack(shopify, "https://cdn.shopify.com/s/files/1/0000/0001/products/shoe_1600x.jpg?v=1"),
    `https://cdn.shopify.com/s/files/1/0000/0001/products/shoe_${TARGET_WIDTH}x.jpg?v=1`,
  );
  assert.equal(
    applyPack(shopify, "https://cdn.shopify.com/s/files/1/0/1/products/shoe_1024x1024.png"),
    `https://cdn.shopify.com/s/files/1/0/1/products/shoe_${TARGET_WIDTH}x1024.png`,
  );
  assert.equal(
    applyPack(shopify, "https://cdn.shopify.com/s/files/1/0/1/products/shoe_400x.jpg"),
    null,
  );
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

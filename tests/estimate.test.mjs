/**
 * Tests for the size model in `src/track/estimate.ts`.
 *
 * Only the in-memory behaviour: `load`, `flush` and `prune` talk to IndexedDB,
 * which does not exist in Node, and the interesting logic is not in them. What is
 * interesting is that the mean tracks a host that changes what it serves without
 * being yanked around by one outlier — because this number is what a blocked
 * request will later be credited as having saved, and an outlier-driven mean would
 * turn one 40 MB video segment into a fictional saving on every blocked thumbnail.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SIZES, SizeModel, modelKey } from "../src/track/estimate.ts";

test("an unseen host and type falls back to the per-type default", () => {
  const model = new SizeModel();
  assert.equal(model.estimate("example.com", "image"), DEFAULT_SIZES.image);
  assert.equal(model.estimate("example.com", "script"), DEFAULT_SIZES.script);
  assert.equal(model.confidence("example.com", "image"), 0);
});

test("websockets are estimated at zero rather than invented", () => {
  // Frames after the handshake are not observable, so any non-zero default would
  // be traffic the extension made up.
  assert.equal(DEFAULT_SIZES.websocket, 0);
});

test("one observation is taken at face value", () => {
  const model = new SizeModel();
  model.observe("example.com", "image", 12_345);
  assert.equal(model.estimate("example.com", "image"), 12_345);
  assert.ok(model.confidence("example.com", "image") > 0);
});

test("the mean settles towards what a host actually serves", () => {
  const model = new SizeModel();
  for (let index = 0; index < 30; index++) model.observe("cdn.example.com", "image", 20_000);
  assert.equal(model.estimate("cdn.example.com", "image"), 20_000);

  // A host that switches to larger images should follow within a few dozen
  // samples rather than averaging both sizes forever.
  for (let index = 0; index < 120; index++) model.observe("cdn.example.com", "image", 200_000);
  const after = model.estimate("cdn.example.com", "image");
  assert.ok(after > 190_000, `expected the mean to reach the new size, got ${after}`);
});

test("a single outlier does not redefine a host", () => {
  const model = new SizeModel();
  for (let index = 0; index < 40; index++) model.observe("api.example.com", "xmlhttprequest", 8_000);
  const before = model.estimate("api.example.com", "xmlhttprequest");

  model.observe("api.example.com", "xmlhttprequest", 40_000_000);
  const after = model.estimate("api.example.com", "xmlhttprequest");

  assert.ok(after > before, "the outlier is still recorded");
  assert.ok(
    after < before * 1.5,
    `one 40 MB response moved the mean from ${before} to ${after}; it should barely budge`,
  );

  // And the same in the other direction: one empty response must not collapse a
  // host that serves megabytes, or every blocked request there would be credited
  // as saving nothing.
  const media = new SizeModel();
  for (let index = 0; index < 40; index++) media.observe("cdn.example.com", "media", 4_000_000);
  media.observe("cdn.example.com", "media", 0);
  assert.ok(media.estimate("cdn.example.com", "media") > 3_000_000);
});

test("types are kept apart within a host", () => {
  const model = new SizeModel();
  model.observe("example.com", "image", 500_000);
  model.observe("example.com", "script", 9_000);
  assert.equal(model.estimate("example.com", "image"), 500_000);
  assert.equal(model.estimate("example.com", "script"), 9_000);
  assert.equal(modelKey("example.com", "image"), "example.com|image");
});

test("junk observations are ignored rather than stored", () => {
  const model = new SizeModel();
  model.observe("", "image", 1000);
  model.observe("example.com", "image", Number.NaN);
  model.observe("example.com", "image", -1);
  assert.equal(model.estimate("example.com", "image"), DEFAULT_SIZES.image);
  assert.equal(model.size, 0);
});

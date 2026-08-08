/**
 * Tests for the size model in `src/track/estimate.ts`.
 *
 * Only the in-memory behaviour: `load`, `flush` and `prune` talk to IndexedDB,
 * which does not exist in Node, and the interesting logic is not in them. What is
 * interesting is that the mean tracks a host that changes what it serves without
 * being yanked around by one outlier — because this number is what a blocked
 * request will later be credited as having saved, and an outlier-driven mean would
 * turn one 40 MB video segment into a fictional saving on every blocked thumbnail.
 *
 * That applies to the first sample as much as the fortieth: a cold key used to take
 * whatever arrived at face value, so a HEAD probe or an error page defined the key
 * outright. The clamp tests below pin that, and pin the other half of it — that an
 * ordinary first sample is still adopted exactly, or the model would just be the
 * defaults with extra steps.
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

test("an ordinary first sample is adopted exactly, across types", () => {
  // The band around the default has to be wide enough that every size a real host
  // actually serves passes through untouched. If any of these moved, the clamp is
  // too tight and the model has been replaced by its own fallbacks.
  const model = new SizeModel();
  model.observe("example.com", "image", 4_000);
  model.observe("example.com", "script", 310_000);
  model.observe("cdn.example.com", "media", 6_500_000);
  model.observe("api.example.com", "xmlhttprequest", 500);
  assert.equal(model.estimate("example.com", "image"), 4_000);
  assert.equal(model.estimate("example.com", "script"), 310_000);
  assert.equal(model.estimate("cdn.example.com", "media"), 6_500_000);
  assert.equal(model.estimate("api.example.com", "xmlhttprequest"), 500);
});

test("one unrepresentative first sample cannot define a cold key", () => {
  // A HEAD probe against a large file books its declared Content-Length and is
  // trained on. Before the clamp this set the mean outright, and that mean then
  // priced every blocked request and every cache hit on the host — which is the
  // estimated half of the savings figure and all of the cache-avoided column.
  //
  // The bounds are deliberately loose: what must hold is that the first sample is
  // held to the neighbourhood of the per-type prior, not any particular ratio.
  const probed = new SizeModel();
  probed.observe("files.example.com", "other", 60_000_000);
  const other = probed.estimate("files.example.com", "other");
  assert.ok(other > DEFAULT_SIZES.other, "the sample is still allowed to move the key");
  assert.ok(
    other < DEFAULT_SIZES.other * 100,
    `one 60 MB probe defined a cold key at ${other} bytes`,
  );

  // And downwards: a 302 or an error page must not price every blocked segment on
  // a video host at a few hundred bytes.
  const errored = new SizeModel();
  errored.observe("cdn.example.com", "media", 512);
  const media = errored.estimate("cdn.example.com", "media");
  assert.ok(media < DEFAULT_SIZES.media, "the sample is still allowed to move the key");
  assert.ok(media > DEFAULT_SIZES.media / 100, `one error page defined a cold key at ${media}`);
});

test("the clamp delays a genuinely heavy host, it does not cap it", () => {
  // The prior is an order of magnitude, not a verdict. A host that really does
  // serve 40 MB segments has to arrive there, or the clamp would understate every
  // saving on the heaviest sites — the ones a metered user most needs counted.
  const model = new SizeModel();
  for (let index = 0; index < 12; index++) model.observe("video.example.com", "media", 40_000_000);
  const after = model.estimate("video.example.com", "media");
  assert.ok(after > 30_000_000, `expected the mean to reach the real size, got ${after}`);
});

test("a zero prior leaves the first sample alone", () => {
  // `websocket` is 0 on purpose, so there is no order of magnitude to clamp
  // against; a zero-width band would pin the key at zero for ever.
  const model = new SizeModel();
  model.observe("ws.example.com", "websocket", 1_200);
  assert.equal(model.estimate("ws.example.com", "websocket"), 1_200);
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

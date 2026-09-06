/**
 * Tests for `src/track/live.ts`, the "right now" ring.
 *
 * Every other figure in the extension is a total over a window that ends now; this is
 * the one that answers what is happening at this moment, and its whole correctness is
 * three properties: the window is sixty seconds and not a byte more, a host is
 * attributed to the page that asked for it rather than to itself, and the rate a
 * surface prints is the bytes divided by the window they actually cover.
 *
 * The clock is a parameter throughout, so none of this waits.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_WINDOW_MS, liveUsage, noteLiveUsage, resetLiveUsage } from "../src/track/live.ts";

const NOW = 1_800_000_000_000;

test("the last minute is aggregated per host and per site, heaviest first", () => {
  resetLiveUsage();
  noteLiveUsage("watch.example", "edge.watch.example", 2_000_000, NOW - 30_000);
  noteLiveUsage("watch.example", "edge.watch.example", 1_000_000, NOW - 20_000);
  noteLiveUsage("watch.example", "watch.example", 100_000, NOW - 10_000);
  noteLiveUsage("mail.example", "mail.example", 400_000, NOW - 5_000);

  const live = liveUsage(NOW);

  assert.equal(live.windowMs, LIVE_WINDOW_MS);
  assert.equal(live.total, 3_500_000);
  assert.deepEqual(
    live.hosts.map((host) => [host.host, host.site, host.bytes, host.requests]),
    [
      ["edge.watch.example", "watch.example", 3_000_000, 2],
      ["mail.example", "mail.example", 400_000, 1],
      ["watch.example", "watch.example", 100_000, 1],
    ],
  );
  assert.deepEqual(
    live.sites.map((site) => [site.site, site.bytes, site.requests]),
    [
      ["watch.example", 3_100_000, 3],
      ["mail.example", 400_000, 1],
    ],
  );
});

test("a sample older than the window is gone, and one exactly at it is kept", () => {
  resetLiveUsage();
  noteLiveUsage("a.example", "a.example", 100, NOW - LIVE_WINDOW_MS - 1);
  noteLiveUsage("a.example", "a.example", 200, NOW - LIVE_WINDOW_MS);
  noteLiveUsage("a.example", "a.example", 300, NOW);

  const live = liveUsage(NOW);
  assert.equal(live.total, 500);
  assert.equal(live.hosts[0].requests, 2);

  // And the reading a minute later is empty: a fresh worker answering "nothing" after
  // an idle gap is telling the truth, and so is a long-lived one.
  assert.equal(liveUsage(NOW + LIVE_WINDOW_MS + 1).total, 0);
  assert.deepEqual(liveUsage(NOW + LIVE_WINDOW_MS + 1).hosts, []);
});

test("the same host under two sites is two rows, because a hold acts on the site", () => {
  resetLiveUsage();
  noteLiveUsage("a.example", "cdn.example", 100, NOW);
  noteLiveUsage("b.example", "cdn.example", 200, NOW);
  const live = liveUsage(NOW);
  assert.equal(live.hosts.length, 2);
  assert.deepEqual(
    live.hosts.map((host) => [host.site, host.bytes]),
    [
      ["b.example", 200],
      ["a.example", 100],
    ],
  );
});

test("a request with no host is filed under its site, and nothing is filed for nothing", () => {
  resetLiveUsage();
  noteLiveUsage("#background", "", 1000, NOW);
  noteLiveUsage("a.example", "a.example", 0, NOW);
  noteLiveUsage("a.example", "a.example", -5, NOW);
  const live = liveUsage(NOW);
  assert.deepEqual(
    live.hosts.map((host) => [host.host, host.site, host.bytes]),
    [["#background", "#background", 1000]],
  );
});

test("under the cap the window shrinks to what survives, so a rate stays a rate", () => {
  resetLiveUsage();
  // More than the ring holds, spread across the minute. The oldest go, and the window
  // reported is the span the survivors cover rather than a full minute the total no
  // longer represents.
  for (let index = 0; index < 4500; index++) {
    noteLiveUsage("a.example", "a.example", 1, NOW - 60_000 + Math.floor(index / 75) * 1000);
  }
  const live = liveUsage(NOW);
  assert.equal(live.total, 4000, "the oldest five hundred were dropped");
  assert.ok(live.windowMs < LIVE_WINDOW_MS, `window ${live.windowMs} did not shrink`);
  assert.ok(live.windowMs >= 1000);
  resetLiveUsage();
});

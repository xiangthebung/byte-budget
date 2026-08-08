/**
 * Tests for `src/track/wire.ts` — the byte arithmetic and the attribution rule.
 *
 * The arithmetic exists because Chrome does not report a response size, so this is
 * where a wrong number would come from. Two properties matter more than the exact
 * figures: an absent `Content-Length` must be distinguishable from a zero-length
 * body, and attribution must never invent a website nobody visited.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  attributeSite,
  bodyImpossible,
  contentLength,
  HEADER_WIRE_FACTOR,
  headerBytes,
  headerValue,
  requestLineLength,
  requestUpBytes,
  responseHeaderBytes,
} from "../src/track/wire.ts";

const RESPONSE = [
  { name: "Content-Type", value: "image/webp" },
  { name: "Content-Length", value: "42817" },
  { name: "Cache-Control", value: "max-age=31536000" },
];

test("absent Content-Length is not the same as zero", () => {
  assert.equal(contentLength(RESPONSE), 42817);
  assert.equal(contentLength([{ name: "Content-Length", value: "0" }]), 0);
  assert.equal(contentLength([{ name: "Content-Type", value: "text/html" }]), null);
  assert.equal(contentLength(undefined), null);
  assert.equal(contentLength([]), null);

  // A header that is present but unusable is as good as absent; it must not become
  // NaN and poison a running total.
  assert.equal(contentLength([{ name: "Content-Length", value: "banana" }]), null);
  assert.equal(contentLength([{ name: "Content-Length", value: "-5" }]), null);
  assert.equal(contentLength([{ name: "Content-Length" }]), null);
});

test("header lookup ignores case, as HTTP does", () => {
  assert.equal(headerValue(RESPONSE, "content-length"), "42817");
  assert.equal(headerValue(RESPONSE, "CONTENT-LENGTH"), "42817");
  assert.equal(headerValue(RESPONSE, "content-encoding"), undefined);
});

test("header bytes count names, values and the framing, then halve", () => {
  const headers = [{ name: "A", value: "b" }];
  // "HTTP/1.1 200 OK" is 15 characters. One header is 1 + 2 + 1 + 2 = 6. Plus the
  // prelude CRLF and the blank line, 4.
  const raw = 15 + 4 + 6;
  assert.equal(headerBytes(headers, 15), Math.round(raw * HEADER_WIRE_FACTOR));

  // More headers must cost more, and an empty block must still cost the framing.
  assert.ok(headerBytes(RESPONSE, 15) > headerBytes(headers, 15));
  assert.ok(headerBytes([], 15) > 0);
  assert.ok(headerBytes(undefined, 15) > 0);
});

test("the request line is measured from the path, not the whole URL", () => {
  // "GET /a?b=c HTTP/1.1" — the origin is in the Host header, not the request line.
  assert.equal(requestLineLength("https://example.com/a?b=c", "GET"), "GET /a?b=c HTTP/1.1".length);
  assert.equal(requestLineLength("https://example.com", "GET"), "GET / HTTP/1.1".length);
  // A URL that will not parse must not throw inside a request listener.
  assert.equal(requestLineLength("::::", "POST"), "POST / HTTP/1.1".length);
});

test("upload bytes include a declared request body", () => {
  const withoutBody = requestUpBytes("https://example.com/api", "POST", [
    { name: "Content-Type", value: "application/json" },
  ]);
  const withBody = requestUpBytes("https://example.com/api", "POST", [
    { name: "Content-Type", value: "application/json" },
    { name: "Content-Length", value: "2048" },
  ]);
  assert.equal(withBody - withoutBody > 2000, true, "the 2048-byte body must be counted");
  assert.ok(withoutBody > 0);
});

test("response header bytes fall back to a plausible status line", () => {
  const named = responseHeaderBytes("HTTP/1.1 404 Not Found", RESPONSE);
  const anonymous = responseHeaderBytes(undefined, RESPONSE);
  assert.ok(named > 0 && anonymous > 0);
  assert.ok(named > anonymous, "a longer status line costs more");
});

test("statuses and methods that cannot carry a body are not parked", () => {
  assert.equal(bodyImpossible(204, "GET"), true);
  assert.equal(bodyImpossible(205, "GET"), true);
  assert.equal(bodyImpossible(304, "GET"), true);
  assert.equal(bodyImpossible(103, "GET"), true, "early hints");
  assert.equal(bodyImpossible(200, "HEAD"), true);
  assert.equal(bodyImpossible(200, "head"), true);
  assert.equal(bodyImpossible(200, "GET"), false);
  assert.equal(bodyImpossible(206, "GET"), false, "a range response has a body");
});

test("a top-level document is attributed from its own URL", () => {
  // Deliberately not from the tab: at the moment onCompleted fires, the tab may
  // still be showing the previous page.
  const site = attributeSite(
    { tabId: 7, type: "main_frame", url: "https://www.example.co.uk/page" },
    () => "previous.com",
  );
  assert.equal(site, "example.co.uk");
});

test("a subresource is attributed to the tab's site", () => {
  const site = attributeSite(
    { tabId: 7, type: "image", url: "https://cdn.someone-else.net/a.png" },
    (tabId) => (tabId === 7 ? "youtube.com" : undefined),
  );
  assert.equal(site, "youtube.com");
});

test("attribution never invents a site nobody visited", () => {
  // Unknown tab: the request's own host would be a plausible-looking lie.
  assert.equal(
    attributeSite({ tabId: 9, type: "font", url: "https://fonts.gstatic.com/f.woff2" }, () => undefined),
    "#background",
  );
  // No tab at all: a service worker, a prefetch, or the browser itself.
  assert.equal(
    attributeSite({ tabId: -1, type: "xmlhttprequest", url: "https://api.example.com/x" }, () => "a.com"),
    "#background",
  );
  // Another extension's traffic is its own bucket, not the page's.
  assert.equal(
    attributeSite(
      {
        tabId: 7,
        type: "xmlhttprequest",
        url: "https://api.example.com/x",
        initiator: "chrome-extension://abcdef",
      },
      () => "youtube.com",
    ),
    "#extensions",
  );
  // A main_frame whose URL is not http(s) has no site to name.
  assert.equal(
    attributeSite({ tabId: 7, type: "main_frame", url: "about:blank" }, () => "a.com"),
    "#background",
  );
});

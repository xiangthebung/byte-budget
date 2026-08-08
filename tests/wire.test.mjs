/**
 * Tests for `src/track/wire.ts` — the byte arithmetic and the attribution rule.
 *
 * The arithmetic exists because Chrome does not report a response size, so this is
 * where a wrong number would come from. Two properties matter more than the exact
 * figures: an absent `Content-Length` must be distinguishable from a zero-length
 * body, and attribution must name the site that *asked* for a request — never the
 * host that served it, which would be a website nobody visited.
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
  // `priceCompleted` consults this *before* `Content-Length`. It used to be the
  // other way round, and a HEAD declares the size of the body it is deliberately
  // not sending — so one HEAD against a 60 MB file booked 60 MB of traffic and, on
  // a cold key, became the mean pricing every blocked request on that host.
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

test("a tabless request is attributed to the origin that asked for it", () => {
  // A site's service worker re-issuing its page's fetches: `tabId` is -1, and the
  // initiator is the page origin. These used to land in `#background`, where they
  // missed the site row, missed `addTabBytes`, and reached the governor under a key
  // no per-site budget can match — so a site could sit over its cap indefinitely by
  // routing through its worker.
  assert.equal(
    attributeSite(
      {
        tabId: -1,
        type: "xmlhttprequest",
        url: "https://api.someone-else.net/x",
        initiator: "https://www.shop.example.co.uk",
      },
      () => "a.com",
    ),
    "example.co.uk",
  );

  // The same fallback for a tab nobody has seen commit anything yet.
  assert.equal(
    attributeSite(
      { tabId: 9, type: "image", url: "https://cdn.someone-else.net/a.png", initiator: "https://news.bbc.co.uk" },
      () => undefined,
    ),
    "bbc.co.uk",
  );
});

test("a known tab outranks the initiator", () => {
  // The tab record is the committed top-level page; an initiator can be a
  // subframe's origin, and a subframe's bytes are part of what the page costs.
  assert.equal(
    attributeSite(
      {
        tabId: 7,
        type: "script",
        url: "https://cdn.someone-else.net/a.js",
        initiator: "https://ads.example.org",
      },
      () => "youtube.com",
    ),
    "youtube.com",
  );
});

test("attribution never invents a site nobody visited", () => {
  // Unknown tab and nothing that asked: the request's own host would be a
  // plausible-looking lie.
  assert.equal(
    attributeSite({ tabId: 9, type: "font", url: "https://fonts.gstatic.com/f.woff2" }, () => undefined),
    "#background",
  );
  // No tab and no initiator: the browser itself, or a prefetch it decided on. This
  // is the case the fallback above must not swallow.
  assert.equal(
    attributeSite({ tabId: -1, type: "xmlhttprequest", url: "https://api.example.com/x" }, () => "a.com"),
    "#background",
  );
  // An opaque origin — a sandboxed frame, a `data:` document — stringifies to the
  // literal "null", which names no site.
  assert.equal(
    attributeSite(
      { tabId: -1, type: "image", url: "https://cdn.example.com/a.png", initiator: "null" },
      () => "a.com",
    ),
    "#background",
  );
  // Neither does a non-http(s) initiator.
  assert.equal(
    attributeSite(
      { tabId: -1, type: "other", url: "https://example.com/x", initiator: "chrome://newtab" },
      () => "a.com",
    ),
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

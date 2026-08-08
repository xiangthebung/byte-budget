/**
 * Tests for `src/core/sites.ts`.
 *
 * This is the module that decides which row a byte count lands in, so getting it
 * wrong is not cosmetic: too little grouping scatters one website across a dozen
 * rows, and too much merges two websites into one. The public suffix table is a
 * compact approximation of the real list, and these are the cases it has to get
 * right for the result to be usable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  hostFromUrl,
  isThirdParty,
  normalizeHost,
  originFromUrl,
  prettyHost,
  siteKeyFromHost,
  siteKeyFromUrl,
} from "../src/core/sites.ts";

test("subdomains collapse onto the registrable domain", () => {
  assert.equal(siteKeyFromHost("www.youtube.com"), "youtube.com");
  assert.equal(siteKeyFromHost("m.youtube.com"), "youtube.com");
  assert.equal(siteKeyFromHost("rr3---sn-8xgp1vo.googlevideo.com"), "googlevideo.com");
  assert.equal(siteKeyFromHost("youtube.com"), "youtube.com");
});

test("multi-label public suffixes are not mistaken for a domain", () => {
  assert.equal(siteKeyFromHost("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(siteKeyFromHost("news.com.au"), "news.com.au");
  assert.equal(siteKeyFromHost("shop.example.co.jp"), "example.co.jp");
  assert.equal(siteKeyFromHost("www.gov.uk"), "www.gov.uk", "gov.uk is itself a suffix");
  assert.equal(siteKeyFromHost("service.nhs.uk"), "service.nhs.uk");
  assert.equal(siteKeyFromHost("mail.uni.ac.za"), "uni.ac.za");
});

test("labels that look like a suffix but are not stay part of the domain", () => {
  // The reason `in` is absent from the generic second-level set: in.gr is a real
  // Greek news site, and treating `in.gr` as a suffix would file every one of its
  // pages under `www.in.gr` instead.
  assert.equal(siteKeyFromHost("www.in.gr"), "in.gr");
  assert.equal(siteKeyFromHost("art.com"), "art.com");
});

test("the approximation errs towards grouping too much, never too little", () => {
  // `pro.br` is a real public suffix that the compact table does not carry, so
  // two Brazilian professional domains land in one row instead of two. That is the
  // documented direction of the error: one row too few is a merge someone can see
  // and reason about, one row too many is a site scattered across a dozen entries.
  assert.equal(siteKeyFromHost("someone.pro.br"), "pro.br");
  assert.equal(siteKeyFromHost("other.pro.br"), "pro.br");
  // The reverse must not happen for anything common: a suffix the table does know
  // keeps its sites apart.
  assert.notEqual(siteKeyFromHost("a.co.uk"), siteKeyFromHost("b.co.uk"));
});

test("hosting domains give each subdomain its own row", () => {
  assert.equal(siteKeyFromHost("someone.github.io"), "someone.github.io");
  assert.equal(siteKeyFromHost("deep.someone.github.io"), "someone.github.io");
  assert.equal(siteKeyFromHost("my-app.vercel.app"), "my-app.vercel.app");
  assert.equal(siteKeyFromHost("thing.pages.dev"), "thing.pages.dev");
});

test("things that are not domain names come back untouched", () => {
  assert.equal(siteKeyFromHost("localhost"), "localhost");
  assert.equal(siteKeyFromHost("127.0.0.1"), "127.0.0.1");
  assert.equal(siteKeyFromHost("192.168.1.14"), "192.168.1.14");
  assert.equal(siteKeyFromHost("[::1]"), "::1");
  assert.equal(siteKeyFromHost("intranet"), "intranet");
});

test("hosts are normalised before anything else looks at them", () => {
  assert.equal(normalizeHost("WWW.Example.COM."), "www.example.com");
  assert.equal(normalizeHost("  example.com  "), "example.com");
  assert.equal(siteKeyFromHost("WWW.EXAMPLE.CO.UK"), "example.co.uk");
});

test("only http and https are trackable", () => {
  assert.equal(siteKeyFromUrl("https://www.example.com/a?b=c#d"), "example.com");
  assert.equal(siteKeyFromUrl("http://example.com:8080/"), "example.com");
  assert.equal(siteKeyFromUrl("chrome://settings"), null);
  assert.equal(siteKeyFromUrl("file:///C:/tmp/x.html"), null);
  assert.equal(siteKeyFromUrl("chrome-extension://abc/popup.html"), null);
  assert.equal(siteKeyFromUrl("not a url"), null);
  assert.equal(hostFromUrl("data:text/plain,hi"), null);
});

test("an origin carries no path and no query", () => {
  assert.equal(originFromUrl("https://www.example.com/deep/path?q=1#f"), "https://www.example.com");
  // Port is part of the origin; a dev server on :3000 is not the same as :3001.
  assert.equal(originFromUrl("http://localhost:3000/x"), "http://localhost:3000");
  assert.equal(originFromUrl("chrome://settings"), null);
});

test("third party is judged against the site, not the exact host", () => {
  assert.equal(isThirdParty("youtube.com", "www.youtube.com"), false);
  assert.equal(isThirdParty("youtube.com", "googlevideo.com"), true);
  // Everything is third party to a reserved bucket: there is no first party there.
  assert.equal(isThirdParty("#background", "www.youtube.com"), true);
});

test("prettyHost drops only a leading www", () => {
  assert.equal(prettyHost("www.example.com"), "example.com");
  assert.equal(prettyHost("wwwx.example.com"), "wwwx.example.com");
  assert.equal(prettyHost("cdn.www.example.com"), "cdn.www.example.com");
});

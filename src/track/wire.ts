/**
 * Wire-size arithmetic, kept pure so it can be argued with in a test rather than
 * only in Chrome.
 *
 * Nothing here touches a browser API. `requests.ts` supplies the header arrays
 * that `chrome.webRequest` handed it and this decides what they weighed.
 */

import { BACKGROUND_SITE, EXTENSION_SITE } from "../core/types";
import { hostFromUrl, siteKeyFromHost } from "../core/sites";

/** The shape of a header, narrowed from `chrome.webRequest.HttpHeader`. */
export interface WireHeader {
  name: string;
  value?: string;
}

/**
 * Header bytes are counted raw and then scaled by this.
 *
 * HTTP/2 and /3 send headers through HPACK/QPACK. For the second and later
 * requests to a host that is closer to a tenth of the raw size than to half; for
 * the first it is closer to raw. `webRequest` does not report the protocol, so
 * there is nothing to branch on. Half sits between the two, and it is deliberately
 * the pessimistic side of typical: over-reporting our own accounting overhead is a
 * better failure than under-reporting someone's traffic.
 *
 * This is *not* counted in `estimatedDown`. That field answers "did we measure the
 * body", an uncertainty that ranges over three orders of magnitude. Folding in a
 * bounded few hundred bytes per request would make a page of perfectly measured
 * bodies read as 60% estimated and destroy the only signal the field carries. The
 * dashboard discloses the header approximation on its own.
 */
export const HEADER_WIRE_FACTOR = 0.5;

export function headerValue(
  headers: readonly WireHeader[] | undefined,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const header of headers ?? []) {
    if (header.name.toLowerCase() === lower) return header.value;
  }
  return undefined;
}

/**
 * `Content-Length`, or `null` when the response did not declare one.
 *
 * `null` and `0` mean different things and must not collapse: zero is a measured
 * empty body, absent is "this was chunked and you will have to find out another
 * way".
 */
export function contentLength(headers: readonly WireHeader[] | undefined): number | null {
  const raw = headerValue(headers, "content-length");
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Bytes of a header block: `name: value\r\n` each, a prelude, and a blank line. */
export function headerBytes(
  headers: readonly WireHeader[] | undefined,
  preludeLength: number,
): number {
  let total = preludeLength + 2 + 2;
  for (const header of headers ?? []) {
    total += header.name.length + 2 + (header.value?.length ?? 0) + 2;
  }
  return Math.round(total * HEADER_WIRE_FACTOR);
}

/** `GET /path?query HTTP/1.1`, without the trailing newline. */
export function requestLineLength(url: string, method: string): number {
  let path = "/";
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    path = "/";
  }
  return method.length + 1 + path.length + 1 + "HTTP/1.1".length;
}

/** Everything sent: request line, headers, and the body if one was declared. */
export function requestUpBytes(
  url: string,
  method: string,
  headers: readonly WireHeader[] | undefined,
): number {
  return headerBytes(headers, requestLineLength(url, method)) + (contentLength(headers) ?? 0);
}

export function responseHeaderBytes(
  statusLine: string | undefined,
  headers: readonly WireHeader[] | undefined,
): number {
  return headerBytes(headers, statusLine?.length ?? "HTTP/1.1 200 OK".length);
}

/** Statuses and methods that cannot carry a body, so there is nothing to wait for. */
export function bodyImpossible(statusCode: number, method: string): boolean {
  return (
    method.toUpperCase() === "HEAD" ||
    statusCode === 204 ||
    statusCode === 205 ||
    statusCode === 304 ||
    (statusCode >= 100 && statusCode < 200)
  );
}

export interface AttributionDetails {
  tabId: number;
  type: string;
  url: string
  initiator?: string;
}

/**
 * Which site a request's bytes belong to.
 *
 * A top-level document is resolved from its own URL rather than from the tab,
 * because at the moment `onCompleted` fires the tab may or may not have committed
 * yet — `webNavigation.onCommitted` and `webRequest.onCompleted` are not ordered
 * against each other. Reading the URL removes the race instead of losing to it
 * half the time.
 *
 * A subresource on a tab nobody has seen commit anything goes to `#background`
 * rather than to its own host. Charging `fonts.gstatic.com` as a website someone
 * visited would be a plausible-looking invention, and the reserved bucket is
 * visible in the UI rather than silent.
 */
export function attributeSite(
  details: AttributionDetails,
  lookupTabSite: (tabId: number) => string | undefined,
): string {
  if (details.initiator?.startsWith("chrome-extension://")) return EXTENSION_SITE;
  if (details.type === "main_frame") {
    const host = hostFromUrl(details.url);
    return host ? siteKeyFromHost(host) : BACKGROUND_SITE;
  }
  if (details.tabId >= 0) {
    return lookupTabSite(details.tabId) ?? BACKGROUND_SITE;
  }
  return BACKGROUND_SITE;
}

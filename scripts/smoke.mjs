/**
 * End-to-end check that the extension actually measures traffic.
 *
 *   npm run build && node scripts/smoke.mjs
 *
 * `npm run verify` proves the code compiles and that the pure modules behave. It
 * cannot prove the part that matters: that `chrome.webRequest` fires, that the
 * content script's resource timings reach the worker, that IndexedDB rows are
 * written, and that the dashboard reads them back. Those only happen in a browser.
 *
 * So this loads `dist/` into a real Chromium, serves a page from a local HTTP
 * server whose exact byte sizes are known, and then reads the extension's own
 * dashboard to check the number it arrived at.
 *
 * The page is served from 127.0.0.1 rather than a spoofed real hostname on purpose:
 * every host worth imitating is in Chromium's HSTS preload list, so `http://` would
 * be upgraded before the resolver saw it and a plain local server would die with
 * ERR_SSL_PROTOCOL_ERROR.
 *
 * Three rules this file holds itself to, because it is the only evidence in the repo
 * that the extension works at all:
 *
 * 1. Every claim is checked against something the extension does not control — what
 *    the local server was asked for, what Playwright's route handler was handed, or
 *    what `chrome.declarativeNetRequest` says it is holding. A figure the extension
 *    reports about itself is logged, not asserted.
 * 2. A failure prints one named FAIL and the run continues. The README quotes the
 *    summary verbatim, so a thrown exception does not just lose one line — it deletes
 *    every check after it from the evidence.
 * 3. Waits are on conditions, not on clocks. Three clocks are left, and each says in
 *    a comment what it is waiting for and why there is nothing to poll.
 *
 * Playwright and its browser are pinned development dependencies. The release archive
 * is built by walking `dist/` only, so neither can enter the Chrome Web Store package.
 */
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { crc32 } from './crc32.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

/**
 * Fixture sizes, chosen so the expected total is arithmetic rather than a guess.
 * The script and the image are served with a `Content-Length`, so the extension
 * should measure them exactly. The document itself is sent chunked with no declared
 * length, which is the case that has to be settled from the page's own resource
 * timing.
 */
const SCRIPT_BYTES = 400_000;
const STREAMED_BYTES = 120_000;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>smoke</title></head>
<body>
<h1>smoke</h1>
<img src="/fixture.png" alt="">
<script src="/fixture.js"></script>
</body></html>`;

/**
 * A page built to exercise the optimizers, each in a way the server can confirm.
 *
 * - A Wikimedia-shaped thumbnail URL, so a real pack pattern is tested against a real
 *   host. Playwright fulfils it, and what it is *asked for* is the observable.
 * - Two beacons. One first-party, which the server either receives or does not; one to a
 *   known analytics host, which Playwright intercepts. `blockBeacons` is scoped by
 *   destination, so the pair is the assertion: the analytics beacon must be refused and
 *   the first-party one must survive. A test that only checked the first would pass just
 *   as well against a rule that blocked every beacon on the web, which is what this used
 *   to do — and `sendBeacon` is how a page flushes unsaved editor state on `pagehide`.
 * - An image far below the fold, which should not be fetched during the initial load.
 * - A `link rel=prefetch`, likewise.
 */
const WIKI_LARGE =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Example.png/1600px-Example.png";

const OPTIMIZE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>optimize</title>
<link rel="prefetch" href="/prefetched">
</head>
<body>
<h1>optimize</h1>
<img id="wiki" src="${WIKI_LARGE}" alt="" width="200">
<div style="height:6000px"></div>
<img id="below" src="/fixture.png" alt="" width="200">
<script>
navigator.sendBeacon('/beacon', 'x');
navigator.sendBeacon('https://www.google-analytics.com/collect', 'x');
</script>
</body></html>`;

/**
 * A page with nothing on it, served with a declared length.
 *
 * For the visit-attribution check. A page load on this weighs a few hundred bytes and
 * nothing about it is estimated, so a visit row that comes back heavy can only have
 * got that way from somewhere else — which is the whole assertion.
 */
const PLAIN_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>plain</title></head><body>plain</body></html>';

/**
 * A page carrying one asset of every kind the tier ladder sheds.
 *
 * `lean` was the only tier ever exercised in a browser, and it is the least
 * interesting of the three. `trim` refuses exactly one resource type, so a bug that
 * widens it changes nothing any total would show. `strict` is the only tier that ever
 * sends `sub_frame`, `script`, `stylesheet` and `websocket` to Chrome — and Chrome
 * applies a rule update atomically, so one type it will not accept means the whole set
 * is rejected, nothing is installed, and every limit in the browser stops working while
 * every surface carries on saying it is enforcing.
 *
 * Each element is here to make one resource type observable at the server, which is the
 * only witness that can tell "refused" from "never wanted".
 */
const TIERS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>tiers</title>
<link rel="stylesheet" href="/fixture.css">
</head>
<body>
<h1>tiers</h1>
<audio id="sound" src="/fixture.wav" preload="auto" muted></audio>
<script>
// The preload attribute is a hint Chrome is free to decline, and a media request that
// is never made is indistinguishable at the server from one that was refused - which
// would make the trim assertion pass for the wrong reason. Inline on purpose, so it
// runs at every tier: DNR refuses network requests and an inline script is not one,
// which is what lets this one page be both the control and the experiment.
document.getElementById('sound').load();
</script>
<img src="/fixture.png" alt="" width="120">
<iframe src="/frame" title="frame" width="120" height="60"></iframe>
<script src="/fixture.js"></script>
</body></html>`;

/** The paths `TIERS_PAGE` asks for, in shed order: media, image, then the rest. */
const TIER_ASSETS = ['/fixture.wav', '/fixture.png', '/fixture.css', '/frame', '/fixture.js'];

const FRAME_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>frame</title></head><body>frame</body></html>';

const CSS_FIXTURE = `/* ${'-'.repeat(2000)} */\nh1 { color: #333; }\n`;

function fixture(size, byte = 0x41) {
  return Buffer.alloc(size, byte);
}

/**
 * A *valid* 8-bit mono WAV, for the same reason the PNG below is a valid PNG.
 *
 * Chrome hands the first bytes of a media response to a decoder while the rest is still
 * arriving, and abandons the request when they are not decodable — `onCompleted` never
 * fires and the element gives up. A silently abandoned media request and a media request
 * the extension refused look identical from the server's side, which would make the
 * `trim` assertion pass for the wrong reason. WAV rather than MP4 because its header is
 * a dozen lines of arithmetic and needs no encoder.
 */
function buildWav(sampleRate = 8000, seconds = 8) {
  const samples = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + samples);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM header length
  buffer.writeUInt16LE(1, 20); // format: uncompressed PCM
  buffer.writeUInt16LE(1, 22); // channels
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate, 28); // byte rate: one channel, one byte per sample
  buffer.writeUInt16LE(1, 32); // block align
  buffer.writeUInt16LE(8, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples, 40);
  // A quiet sawtooth rather than silence: a decoder that discards all-zero audio would
  // otherwise be free to skip the fetch this whole fixture exists to produce.
  for (let index = 0; index < samples; index++) buffer[44 + index] = 128 + (index % 32);
  return buffer;
}

/**
 * A *valid* PNG of roughly 250 kB.
 *
 * The first version of this fixture was 250,000 bytes of one repeated character
 * served as `image/png`, and it made the smoke test flaky in a way worth recording:
 * Chrome hands the first bytes to the image decoder while the rest is still
 * arriving, and when they are not a PNG it aborts the request. `onCompleted` never
 * fires, `onErrorOccurred` does, and a quarter of a megabyte goes missing from the
 * total — a genuine measurement, of the wrong thing.
 *
 * Pixels are noise and the zlib stream is stored rather than compressed, so the
 * encoded size is predictable instead of collapsing to a few hundred bytes.
 */
function pngFixture(width = 250, height = 250) {
  return buildPng(width, height);
}

function buildPng(width, height) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width * 4; x++) {
      raw[y * stride + 1 + x] = (x * 7 + y * 13 + ((x * y) % 251)) & 0xff;
    }
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, checksum]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const IMAGE = pngFixture();
const IMAGE_BYTES = IMAGE.length;
const AUDIO = buildWav();

/**
 * What the size model assumes an image weighs when it has never seen one, read out of
 * the source rather than copied.
 *
 * A copy would drift, and the assertion it feeds is exact on purpose: a refused
 * request has no size, so a saving credited for one has to come from this number and
 * nothing else once usage has been deleted.
 */
const DEFAULT_IMAGE_ESTIMATE = await readDefaultImageEstimate();

async function readDefaultImageEstimate() {
  const source = await readFile(path.join(root, 'src', 'track', 'estimate.ts'), 'utf8');
  const match = /^\s*image:\s*([\d_]+),/m.exec(source);
  if (!match) throw new Error('smoke: could not read DEFAULT_SIZES.image from estimate.ts');
  return Number(match[1].replace(/_/g, ''));
}

/**
 * The pack patterns, read out of the built bundle rather than duplicated here.
 *
 * A copy would drift, and the check it feeds — "Chrome's RE2 accepts this" — is only
 * meaningful about the pattern that actually ships.
 */
/**
 * The settings sections, read out of the source rather than counted here.
 *
 * This check used to assert `panes.length === 6`, and a seventh section made it fail —
 * a test failing because the product grew, which is the shape this file warns about
 * two checks further down ("pinning either would make this fail the next time a feature
 * is added"). What it is actually for is that no `settings.html#…` string anywhere in
 * the build names a section that does not exist. So the count comes from the one place
 * that decides it, and the assertion is equality with that.
 */
const SETTINGS_SECTIONS = await readSettingsSections();

async function readSettingsSections() {
  const source = await readFile(path.join(root, 'src', 'core', 'types.ts'), 'utf8');
  const match = /export const SETTINGS_SECTIONS = \[([\s\S]*?)\] as const;/.exec(source);
  if (!match) throw new Error('smoke: could not read SETTINGS_SECTIONS from types.ts');
  // Block comments first: the entries carry explanatory ones between them, and a
  // section name quoted inside a comment would be counted as an entry.
  const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const names = [...body.matchAll(/"([A-Za-z0-9_-]+)"/g)].map((entry) => entry[1]);
  if (names.length === 0) throw new Error('smoke: SETTINGS_SECTIONS parsed to nothing');
  return names;
}

const PACK_PATTERNS = await readPackPatterns();

async function readPackPatterns() {
  const source = await readFile(path.join(root, 'src', 'optimize', 'packs.ts'), 'utf8');
  const entries = [];
  const blocks = source.split(/\n\s*\{\s*\n\s*id:\s*"/).slice(1);
  for (const block of blocks) {
    const id = block.slice(0, block.indexOf('"'));
    const match = /regexFilter:\s*\n?\s*"((?:[^"\\]|\\.)*)"/.exec(block);
    if (!id || !match) continue;
    // The source is a TypeScript string literal, so its escapes have to be undone to
    // get the pattern Chrome will be handed.
    entries.push([id, JSON.parse(`"${match[1]}"`)]);
  }
  if (entries.length === 0) throw new Error('smoke: could not read any pack patterns');
  return entries;
}

/**
 * Every path the server was actually asked for, since the last reset.
 *
 * This is the half of the blocking experiment that the extension cannot fake. The
 * extension can report that it refused a request; only the server can confirm the
 * request never arrived.
 */
let hits = [];
const resetHits = () => {
  hits = [];
  saveDataByPath = new Map();
};

/** `Save-Data` header values the server was sent, by path. */
let saveDataByPath = new Map();

function startServer() {
  const server = createServer((request, response) => {
    hits.push(request.url);
    saveDataByPath.set(request.url, request.headers['save-data'] ?? null);

    if (request.url === '/optimized') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end(OPTIMIZE_PAGE);
      return;
    }
    if (request.url === '/plain') {
      const body = Buffer.from(PLAIN_PAGE, 'utf8');
      response.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
      });
      response.end(body);
      return;
    }
    if (request.url === '/beacon' || request.url === '/prefetched') {
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    // The tier page and its four non-image assets. Every one is served with a declared
    // length so that "the bytes did not arrive" is never the reason a check fails.
    if (request.url.startsWith('/tiers')) {
      const body = Buffer.from(TIERS_PAGE, 'utf8');
      response.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
      });
      response.end(body);
      return;
    }
    if (request.url === '/frame') {
      const body = Buffer.from(FRAME_PAGE, 'utf8');
      response.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
      });
      response.end(body);
      return;
    }
    if (request.url === '/fixture.css') {
      const body = Buffer.from(CSS_FIXTURE, 'utf8');
      response.writeHead(200, {
        'Content-Type': 'text/css',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
        'Timing-Allow-Origin': '*',
      });
      response.end(body);
      return;
    }
    if (request.url === '/fixture.wav') {
      // `Accept-Ranges` is deliberately absent. Chrome range-requests media when the
      // server offers to, which turns one observable request into several and makes the
      // hit log harder to read for no gain — what is being asserted is whether the
      // request happens at all.
      response.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': String(AUDIO.length),
        'Cache-Control': 'no-store',
        'Timing-Allow-Origin': '*',
      });
      response.end(AUDIO);
      return;
    }
    if (request.url === '/fixture.js') {
      const body = fixture(SCRIPT_BYTES, 0x20);
      response.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
        // So the page can read its own transfer sizes for these too.
        'Timing-Allow-Origin': '*',
      });
      response.end(body);
      return;
    }
    if (request.url === '/fixture.png') {
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(IMAGE.length),
        'Cache-Control': 'no-store',
        'Timing-Allow-Origin': '*',
      });
      response.end(IMAGE);
      return;
    }
    if (request.url === '/streamed') {
      // Chunked, no Content-Length: the case webRequest cannot size on its own.
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      const chunk = fixture(STREAMED_BYTES / 4, 0x2e);
      for (let index = 0; index < 4; index++) response.write(chunk);
      response.end();
      return;
    }
    // The document, also chunked and also unsized.
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end(PAGE);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------------------ *
 * Waiting on conditions instead of on the clock
 * ------------------------------------------------------------------ */

/**
 * Polls `read` until `accept` is satisfied, then answers with the last value read.
 *
 * This replaces most of what used to be `waitForTimeout`, and the gain is not only
 * speed. A fixed sleep is wrong in both directions: too long on the machine it was
 * tuned on — twenty of them totalled 64 seconds, and a two-minute gate is the gate
 * people skip, which is the exact failure the stale-build guard below exists to
 * prevent — and too short on a loaded CI runner, where it fails for a reason that is
 * not a defect.
 *
 * It resolves rather than throwing when the deadline passes, on purpose: the caller's
 * `check` then prints the number actually seen instead of a timeout, and one named FAIL
 * beats an exception that aborts the remaining checks.
 */
async function until(read, accept, { timeout = 20_000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    value = await read();
  }
  return value;
}

/**
 * Turns a Playwright wait into a named check.
 *
 * `waitForSelector` and `waitForFunction` reject on timeout, and a rejection anywhere
 * in `main()` ends the run — so the summary the README quotes as evidence loses every
 * check after the failure and gains nothing naming the one that failed. Two assertions
 * were written `check(true, …)` immediately after a bare wait, which prints a passing
 * line that no condition was ever evaluated for: the wait was the real assertion and
 * its failure mode was a stack trace. This makes the wait itself the assertion.
 */
async function checkWait(check, message, run) {
  try {
    await run();
    check(true, message);
    return true;
  } catch (error) {
    const reason = String(error?.message ?? error).split('\n')[0];
    check(false, `${message} — ${reason}`);
    return false;
  }
}

/**
 * Waits for a surface to be done laying out, rather than for a number of milliseconds.
 *
 * Fonts first, because they change metrics and a measurement taken before they land
 * describes a layout nobody sees; then a layout property is read, which flushes pending
 * style and layout synchronously. Deliberately not `requestAnimationFrame`: only one of
 * this script's four pages is the foreground tab, and Chromium does not run animation
 * frames in the others — a rAF-based settle would hang on `settings` and `dashboard`.
 */
function settle(target) {
  return target.evaluate(async () => {
    // Bounded, because `evaluate` has no timeout of its own and `document.fonts.ready`
    // is the one promise here that a font which neither loads nor fails can leave
    // pending. Trading a hung run for a slightly early measurement is the right way
    // round: the measurement then fails as a named check.
    await Promise.race([
      document.fonts?.ready ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    return document.documentElement.scrollWidth;
  });
}

/* ------------------------------------------------------------------ *
 * Reading Chrome's rules rather than the extension's opinion of them
 * ------------------------------------------------------------------ */

/** One line per installed rule, for a failure message that can be acted on. */
function describeRules(rules) {
  if (rules.length === 0) return 'none';
  return rules
    .map((rule) => {
      const condition = rule.condition ?? {};
      const scope = [
        (condition.initiatorDomains ?? []).length > 0
          ? `from:${condition.initiatorDomains.join(',')}`
          : '',
        (condition.tabIds ?? []).length > 0 ? `tabs:${condition.tabIds.join(',')}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `#${rule.id} p${rule.priority} ${rule.action?.type} [${(
        condition.resourceTypes ?? []
      ).join(',')}]${scope ? ` ${scope}` : ''}`;
    })
    .join(' | ');
}

/**
 * Whether Chrome holds exactly `count` rules, numbered 1..count.
 *
 * Contiguity from 1 is not incidental. `rules/session.ts` is the single owner of the
 * session set precisely because `updateSessionRules` replaces by id: it composes the
 * limit rules and the optimizer's rules together and renumbers the whole set on every
 * install, which is what lets two publishers share one id space without deleting each
 * other's work. A gap means a rule the extension composed is not one Chrome kept.
 */
/**
 * The permanent `allow` rule that keeps a limit from refusing the subscription check.
 *
 * It is published once at worker start and never changes, so it is present in every
 * reading of Chrome's session rules — including the ones taken when the extension has
 * composed nothing at all. Every assertion in this file about what a *limit* or the
 * *optimizer* installed therefore has to exclude it, or it reports the exemption as a
 * stray block rule and the tier checks fail for a reason that is not a defect.
 */
const GUARD_RULE_COUNT = 1;

function isGuardRule(rule) {
  return (
    rule.action?.type === 'allow' &&
    (rule.condition?.requestDomains ?? []).includes('extensionpay.com')
  );
}

/**
 * Whether `rules` occupies a contiguous block of ids immediately after the guard.
 *
 * `rules/session.ts` renumbers the whole set from 1 on every install, with the guard
 * source first — so the limit and optimizer rules start at `offset + 1`. The claim is
 * unchanged from when there was no guard: the set Chrome holds is exactly the set the
 * extension composed, with no gaps, which is what proves nothing was silently dropped.
 */
function ruleIdsAreContiguous(rules, count, offset = GUARD_RULE_COUNT) {
  const ids = rules.map((rule) => rule.id).sort((a, b) => a - b);
  return ids.length === count && ids.every((id, index) => id === index + 1 + offset);
}

/**
 * Refuses to run against a `dist/` older than `src/`.
 *
 * This cost a real debugging cycle: a threshold was tuned, the unit tests were run
 * (which do not build), and the browser test was then read as evidence about the new
 * code while it was still exercising the old. Every conclusion drawn from it was
 * wrong, and nothing about the output said so. `npm run smoke` builds first; this is
 * for when it is invoked directly.
 */
async function assertFresh() {
  const newest = async (dir) => {
    let latest = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) latest = Math.max(latest, await newest(full));
      else latest = Math.max(latest, (await stat(full)).mtimeMs);
    }
    return latest;
  };

  let built;
  try {
    built = (await stat(path.join(dist, 'background.js'))).mtimeMs;
  } catch {
    throw new Error('dist/ has not been built. Run `npm run build` first.');
  }
  const sources = Math.max(
    await newest(path.join(root, 'src')),
    (await stat(path.join(root, 'public', 'manifest.json'))).mtimeMs,
  );
  if (sources > built) {
    throw new Error(
      'dist/ is older than src/. Run `npm run build` first, or use `npm run smoke`, ' +
        'which builds. Results from a stale build are worse than no results.',
    );
  }
}

/**
 * Loads the *project root* as an unpacked extension and checks it works.
 *
 * The build writes a manifest at the root that points into `dist/`, so
 * `chrome://extensions` can load the project folder rather than making you descend a
 * level on every reload — matching the plain-JavaScript extensions in this workspace,
 * whose source is their bundle.
 *
 * Worth a check of its own because the failure is quiet: `chrome.scripting` resolves
 * `files:` against the extension root, so a hard-coded `notice.js` is simply absent
 * when the root is one level up, and the only symptom is a banner that never appears.
 */
async function checkRootLoad(chromium, check) {
  const context = await launch(chromium, root);
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const extensionId = new URL(worker.url()).host;
    check(Boolean(extensionId), `the project root loads as an extension (${extensionId})`);

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/dist/popup.html`);
    // The wait is the assertion. Written as `check(true, …)` after a bare
    // `waitForSelector`, this line printed "ok" for a condition nothing had evaluated,
    // and a popup that failed to render threw instead — taking the remaining checks,
    // and the summary the README quotes, down with it.
    await checkWait(check, 'its popup renders from the root manifest', () =>
      page.waitForSelector('#period-tabs button', { timeout: 10_000 }),
    );

    /**
     * The popup is loaded from `dist/` under this manifest, so its navigation buttons
     * must open the same directory. A direct `getURL("settings.html")` still lets the
     * popup render and only fails when a person follows one of its two main routes —
     * exactly the kind of root-load regression the check above cannot see.
     */
    async function checkPopupRoute(button, expectedPath, selector, label) {
      await checkWait(check, label, async () => {
        const popup = await context.newPage();
        try {
          await popup.goto(`chrome-extension://${extensionId}/dist/popup.html`);
          await popup.waitForSelector(button, { timeout: 10_000 });
          const opened = context.waitForEvent('page', { timeout: 10_000 });
          await popup.click(button);
          const target = await opened;
          try {
            await target.waitForSelector(selector, { state: 'attached', timeout: 10_000 });
            if (new URL(target.url()).pathname !== expectedPath) {
              throw new Error(`opened ${target.url()}`);
            }
          } finally {
            await target.close().catch(() => undefined);
          }
        } finally {
          await popup.close().catch(() => undefined);
        }
      });
    }

    await checkPopupRoute(
      '#settings-button',
      '/dist/settings.html',
      '#pane-plan',
      'the root popup opens Settings',
    );
    await checkPopupRoute(
      '#dashboard-button',
      '/dist/dashboard.html',
      '#stats',
      'the root popup opens Dashboard',
    );

    // The path both content scripts are injected by, resolved the way the worker
    // resolves it. Wrong and the banner never shows.
    const resolved = await page.evaluate(() => {
      const declared = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0] ?? '';
      const slash = declared.lastIndexOf('/');
      return slash < 0 ? '' : declared.slice(0, slash + 1);
    });
    check(resolved === 'dist/', `injected files resolve under "${resolved}"`);

    const reachable = await page.evaluate(async (prefix) => {
      const response = await fetch(chrome.runtime.getURL(`${prefix}notice.js`));
      return response.ok;
    }, resolved);
    check(reachable === true, 'and the file is actually there');
  } finally {
    await context.close();
  }
}

/**
 * Whether a launch failure means "the `chromium` channel is not installed here".
 *
 * Playwright words that one of two ways depending on how the channel resolves — a
 * missing executable, or a distribution it cannot find — and both point at the same
 * install command. Matched on the message because Playwright does not give it a code.
 */
function isMissingChannel(error) {
  const text = String(error?.message ?? error);
  return (
    /Executable doesn'?t exist/i.test(text) ||
    /is not found at/i.test(text) ||
    /playwright install/i.test(text)
  );
}

/** Launches a persistent context with an unpacked extension loaded from `dir`. */
async function launch(chromium, dir) {
  /**
   * Extensions do not load in Playwright's default headless *shell* binary, and
   * passing `--headless=new` as an argument does not help — the binary is already
   * chosen by then. `channel: "chromium"` selects the full browser, which launches in
   * the new headless mode and does load extensions. A machine without that channel
   * falls back to a visible window rather than failing.
   */
  const args = [
    `--disable-extensions-except=${dir}`,
    `--load-extension=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  try {
    return await chromium.launchPersistentContext('', { channel: 'chromium', args });
  } catch (error) {
    /**
     * Narrow, because this catch used to swallow everything.
     *
     * A missing binary, a Chromium whose major the installed Playwright cannot drive,
     * and a genuine crash on launch all arrived at the same log line — "running headed"
     * — and the retry then failed differently, or on a headless runner sat waiting for
     * a display until the job timed out. A real crash has to surface as itself.
     */
    if (!isMissingChannel(error)) throw error;
    /**
     * And the fallback is only a fallback where a window can actually open. On Linux
     * with no display server the headed retry blocks until Playwright's own timeout,
     * turning a one-line install instruction into a hung CI job.
     */
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new Error(
        'the "chromium" channel is not installed and there is no display to fall back to. ' +
          'Run `npx playwright install --with-deps chromium`.',
      );
    }
    console.log('note  the "chromium" channel is unavailable; running headed');
    return await chromium.launchPersistentContext('', {
      headless: false,
      args,
      // Bounded rather than open-ended: this path is already the degraded one, and a
      // second failure here should be reported, not waited on indefinitely.
      timeout: 60_000,
    });
  }
}

async function main() {
  await assertFresh();
  const { chromium } = await import('playwright');
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;

  const problems = [];
  const check = (condition, message) => {
    if (!condition) problems.push(message);
    console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}`);
  };

  await checkRootLoad(chromium, check);

  const context = await launch(chromium, dist);

  // Extension errors surface in the worker's own console and nowhere else, so it
  // is worth forwarding: a silent failure there looks exactly like "no traffic".
  const logs = [];
  const watch = (sw) => {
    if (sw.__watched) return;
    sw.__watched = true;
    sw.on('console', (message) => logs.push(`[worker] ${message.type()}: ${message.text()}`));
  };
  // Both directions: the worker may already have started while the context was
  // launching, in which case the event has been and gone.
  context.on('serviceworker', watch);
  for (const sw of context.serviceWorkers()) watch(sw);
  context.on('page', (opened) => {
    opened.on('console', (message) => logs.push(`[page] ${message.type()}: ${message.text()}`));
    opened.on('pageerror', (error) => logs.push(`[page] error: ${error.message}`));
  });

  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    watch(worker);
    const extensionId = new URL(worker.url()).host;
    check(Boolean(extensionId), `service worker registered (${extensionId})`);

    const page = await context.newPage();
    const dashboard = await context.newPage();
    const settings = await context.newPage();
    await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html`);
    await settings.goto(`chrome-extension://${extensionId}/settings.html`);
    await settings.waitForSelector('#optimize-toggle', { state: 'attached', timeout: 10_000 });
    await settings.waitForSelector('.impact-label', { state: 'attached', timeout: 10_000 });

    /**
     * Opens one of the six settings sections and waits for it to be on screen.
     *
     * The options page is a rail and six panes now, not one column: five of the six are
     * `hidden` at any moment, and Playwright's actionability checks would sit and wait
     * for a control that is deliberately not displayed. Every interaction below names
     * the section it is in, which is also the honest description of what a person does.
     *
     * The hash is set rather than the rail item clicked, because at a narrow viewport
     * the rail scrolls sideways and the item may be out of view — which is a real
     * property of the layout and not something a test should have to scroll around.
     */
    const openSection = async (name) => {
      await settings.evaluate((section) => {
        location.hash = `#${section}`;
      }, name);
      await settings.waitForSelector(`#pane-${name}:not([hidden])`, { timeout: 10_000 });
    };

    /**
     * One message to the worker, from an extension page.
     *
     * Defined here rather than beside the first blocking experiment because the waits
     * throughout now poll it: "has the worker finished counting the load" is a question
     * the extension can be asked, and asking beats sleeping for six seconds and hoping.
     */
    const ask = (message) =>
      dashboard.evaluate(
        (payload) =>
          new Promise((resolve) =>
            chrome.runtime.sendMessage(payload, (value) =>
              resolve(value ?? { lastError: chrome.runtime.lastError?.message }),
            ),
          ),
        message,
      );

    /**
     * What Chrome is actually holding.
     *
     * Every rule count in this script used to come from the extension: `SET_ENFORCEMENT`
     * answers with the length of the array it composed, and `SAVE_OPTIMIZE` with the
     * length of the array it handed to `publishRules`. Neither has ever asked the
     * browser. That matters because `updateSessionRules` is atomic — a set containing
     * one condition Chrome will not accept installs *nothing*, and the number the
     * extension reports is exactly the number that does not change when it happens. So
     * "we think we installed N" and "Chrome holds N" are different claims, and only the
     * second one is evidence.
     */
    const sessionRules = () =>
      dashboard.evaluate(() => chrome.declarativeNetRequest.getSessionRules());

    /** Chrome's session rules minus the permanent guard. See `isGuardRule`. */
    const heldRules = async () => (await sessionRules()).filter((rule) => !isGuardRule(rule));

    /**
     * Puts the install on the free or the paid tier, without touching the network.
     *
     * The subscription state is a record in `chrome.storage.local`, written by the
     * worker and read back through `GET_PLUS`. Writing it here is not a back door into
     * production code — there is no test-only branch in `plus/gate.ts` — it is the same
     * record the worker itself writes, and the memo-invalidation listener in `startPlus`
     * is what makes an external write take effect. That listener exists for its own
     * reasons (a cleared storage area must not leave a stale copy in a worker that lives
     * for hours); this just happens to be the second thing it buys.
     *
     * Polls rather than assumes. `storage.onChanged` reaches the worker asynchronously,
     * and a check that ran a millisecond too early would read the tier it was replacing
     * and produce a confusing FAIL somewhere else entirely.
     */
    const setPlus = async (paid) => {
      await dashboard.evaluate(
        (on) =>
          chrome.storage.local.set({
            'plus.status': {
              plus: on,
              reason: on ? 'paid' : 'never',
              trialEndsAt: null,
              trialAvailable: !on,
              interval: on ? 'month' : null,
              checkedAt: Date.now(),
              stale: false,
            },
          }),
        paid,
      );
      const deadline = Date.now() + 10_000;
      for (;;) {
        const response = await ask({ type: 'GET_PLUS' });
        if (response?.plus?.plus === paid) return true;
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    const optionsPage = await dashboard.evaluate(
      () => chrome.runtime.getManifest().options_page ?? '',
    );
    check(optionsPage === 'settings.html', `the Options page is separate (${optionsPage})`);
    check(
      (await dashboard.$('#optimize-toggle')) === null && (await dashboard.$('#limits-list')) === null,
      'the dashboard contains reporting, not settings controls',
    );
    check(
      (await settings.$('#stats')) === null && (await settings.$('#site-list')) === null,
      'the Settings page contains controls, not dashboard reporting',
    );

    /*
     * Nothing on the dashboard is clipped to a width it does not fit.
     *
     * The tile captions used to be one line with an ellipsis, which was invisible
     * until a caption became a sentence — and the two on the Data Saver panel are the
     * product saying which of its two figures is measured and which is modelled. They
     * shipped reading "Original sizes on file, minus what the sma…" and "The size
     * model's guess for requests refus…", so the half that fitted was the half that
     * said nothing.
     *
     * Asserted over every caption on the page rather than those two, and by comparing
     * scroll width against client width rather than by looking for a "…": a clipped
     * element is one whose content is wider than the box it is in, whatever put it
     * there. `textContent` would not do — CSS truncation does not change it.
     *
     * What it does not prove: putting `white-space: nowrap` back on `.stat-hint` does
     * not fail this run today, because the tiles were widened in the same change and
     * the fixture's captions now fit one line either way. It is a net under the whole
     * class of defect, not a pin on the one instance of it.
     */
    const clipped = await dashboard.$$eval('.stat-hint, .stat-note, .panel-note', (nodes) =>
      nodes
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .map((node) => `${node.className}: ${node.textContent?.slice(0, 40)}`),
    );
    check(
      clipped.length === 0,
      `no caption on the dashboard is cut off${clipped.length ? ` — ${clipped.join('; ')}` : ''}`,
    );

    /*
     * The Dashboard and Settings frames are the same frame.
     *
     * They are two pages of one product and the only thing a person sees on both is
     * the header and the nav under it — so anything that differs between them reads as
     * the page jumping when they switch. It drifted three ways at once and each was
     * invisible from inside one page: Settings capped `.page` 60px narrower, so both
     * surfaces centred 30px apart; the nav sat inside the header here and under it
     * there; and the header was a line shorter here, so everything below it started
     * 18px higher.
     *
     * Measured at one viewport with fonts settled, and asserted as equality rather
     * than as four remembered numbers, so it keeps holding when the header changes.
     */
    for (const surface of [dashboard, settings]) {
      await surface.setViewportSize({ width: 1280, height: 900 });
      await settle(surface);
    }
    const frameOf = (surface) =>
      surface.evaluate(() => {
        const box = (selector) => {
          const rect = document.querySelector(selector)?.getBoundingClientRect();
          return rect
            ? [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value))
            : null;
        };
        const page = box('.page');
        return {
          // Where the frame sits and how wide it is. Not its height: the two pages hold
          // different amounts of content, which is the one thing they are allowed to
          // disagree about.
          pageAcross: page && [page[0], page[2]],
          head: box('.page-head'),
          nav: box('.section-nav'),
          mark: box('.brand-mark'),
        };
      });
    const [dashFrame, setFrame] = await Promise.all([frameOf(dashboard), frameOf(settings)]);
    const differs = Object.keys(dashFrame).filter(
      (part) => JSON.stringify(dashFrame[part]) !== JSON.stringify(setFrame[part]),
    );
    check(
      dashFrame.pageAcross !== null && differs.length === 0,
      `Dashboard and Settings share one frame` +
        (differs.length
          ? ` — ${differs
              .map((part) => `${part} ${JSON.stringify(dashFrame[part])} vs ${JSON.stringify(setFrame[part])}`)
              .join('; ')}`
          : ` (frame ${JSON.stringify(dashFrame.pageAcross)}, nav ${JSON.stringify(dashFrame.nav)})`),
    );

    /*
     * Every deep link into Settings names a section that exists.
     *
     * The popup's "Set a plan" and "Manage limits" buttons and two links on the
     * dashboard jump straight to a part of this page. Settings decides what those
     * fragments are, the other three surfaces spell them out, and nothing connects the
     * two — so a renamed section leaves four buttons that open Settings at the top and
     * look, to anyone pressing one, like a page that ignored them. That is precisely
     * what happened when the panels became panes: all four still pointed at
     * `#…-panel`.
     *
     * Read out of `dist/` rather than driven through the UI, because two of the four
     * are in the popup and open a tab, and the failure is in the string either way.
     */
    const panes = await settings.$$eval('.pane', (nodes) =>
      nodes.map((node) => node.dataset.pane),
    );
    const linked = new Set();
    for (const name of await readdir(dist)) {
      if (!/\.(js|html)$/.test(name)) continue;
      const body = await readFile(path.join(dist, name), 'utf8');
      for (const match of body.matchAll(/settings\.html#([A-Za-z0-9_-]+)/g)) {
        linked.add(match[1]);
      }
    }
    const dangling = [...linked].filter((fragment) => !panes.includes(fragment));
    const missingPanes = SETTINGS_SECTIONS.filter((name) => !panes.includes(name));
    check(
      missingPanes.length === 0 && linked.size > 0 && dangling.length === 0,
      `all ${linked.size} deep links into Settings name one of its ${panes.length} sections` +
        (dangling.length ? ` — dangling: ${dangling.join(', ')}` : '') +
        (missingPanes.length ? ` — declared but not built: ${missingPanes.join(', ')}` : ''),
    );
    const impacts = await settings.$$eval('.impact-meter', (nodes) =>
      nodes.map((node) => ({
        label: node.querySelector('.impact-label')?.textContent ?? '',
        filled: node.querySelectorAll('[data-filled="true"]').length,
      })),
    );
    // Asserted as a property, not as a fixed list. The features are now rendered by
    // iterating FEATURES and grouped by visibility, so the order follows the grouping
    // and the count follows how many features carry an impact figure — pinning either
    // would make this fail the next time a feature is added, which is a test failing
    // for a reason that is not a defect. What must hold is that the meter never
    // disagrees with its own label.
    const FILL_FOR = { High: 3, Medium: 2, Low: 1 };
    check(
      impacts.length > 0 && impacts.every((entry) => FILL_FOR[entry.label] === entry.filled),
      `every impact meter matches its label (${JSON.stringify(impacts)})`,
    );

    // Exercise the extracted controller through visible controls, not direct messages.
    await openSection('saver');
    const saverSwitch = '#pane-saver .switch-control';
    if (await settings.isChecked('#optimize-toggle')) {
      await settings.click(saverSwitch);
      await settings.waitForFunction(
        () => document.querySelector('#optimize-body')?.hasAttribute('hidden') === true,
      );
    }
    await settings.click(saverSwitch);
    await settings.waitForFunction(
      () => document.querySelector('#optimize-body')?.hasAttribute('hidden') === false,
    );
    check(await settings.isChecked('#optimize-toggle'), 'the Settings Data Saver switch works');

    /*
     * The three preset levels replace the eight checkboxes as the ordinary way to use
     * Data Saver, so what has to hold is that the picker and the switches agree: choose
     * a level, and the individual switches under Advanced must be exactly the set that
     * level names. Read back off the checkboxes, not off the settings object, because
     * the defect this guards against is a picker that saves one thing and shows
     * another.
     */
    const featuresOn = () =>
      settings.$$eval('[id^="feature-"]', (nodes) =>
        nodes.filter((node) => node.checked).map((node) => node.id.replace("feature-", "")).sort(),
      );
    await settings.click('#saver-level-group [data-option="light"]');
    await settings.waitForFunction(
      () =>
        document
          .querySelector('#saver-level-group [data-option="light"]')
          ?.getAttribute('aria-checked') === 'true',
    );
    const lightSet = await featuresOn();
    await settings.click('#saver-level-group [data-option="maximum"]');
    await settings.waitForFunction(
      () => document.querySelectorAll('[id^="feature-"]:checked').length === 8,
    );
    const maximumSet = await featuresOn();
    check(
      lightSet.length > 0 &&
        maximumSet.length > lightSet.length &&
        lightSet.every((id) => maximumSet.includes(id)),
      `the savings level sets the individual switches (light ${lightSet.length}, maximum ${maximumSet.length})`,
    );
    /* ---------------------------------------------------------------- *
     * The paid tier
     *
     * Here, and in this order, because everything above this point is free and
     * everything below it needs Advanced to be usable. The install has never been
     * subscribed at this stage — nothing has written the record — so this is the one
     * moment in the run where the free tier's ceilings are the live state and can be
     * asserted rather than simulated.
     * ---------------------------------------------------------------- */

    // The allow rule that keeps a limit from refusing the subscription check. Read out
    // of Chrome rather than out of the extension, for the reason `sessionRules` gives:
    // an invalid condition makes `updateSessionRules` reject the whole set atomically,
    // so finding this rule installed also proves it is one Chrome accepts. If it were
    // not, every limit and optimizer rule in the run would be missing too.
    const guardRule = (await sessionRules()).find(
      (rule) =>
        rule.action?.type === 'allow' &&
        (rule.condition?.requestDomains ?? []).includes('extensionpay.com'),
    );
    check(Boolean(guardRule), 'the subscription check is exempt from the limit rules');

    await settings.click('#saver-advanced > summary');
    const advancedLockedFree = await settings.$$eval('#feature-groups input', (nodes) =>
      nodes.length > 0 && nodes.every((node) => node.disabled),
    );
    const advancedNoticeFree = await settings.$('#saver-advanced-lock .plus-lock');
    check(
      advancedLockedFree && Boolean(advancedNoticeFree),
      'a free install finds Advanced locked, with a notice saying which control replaces it',
    );

    // The state, not merely a class. Arrow keys move *and* activate in a radio group,
    // so a lock that only dimmed would be bypassable by pressing Right — `bindGroup`
    // steps over locked options for exactly that reason.
    const holdoutLockedFree = await settings.$$eval('#holdout-group [data-option]', (nodes) =>
      nodes.length > 0 &&
      nodes.every((node) => node.dataset.locked === 'true' && node.getAttribute('aria-disabled') === 'true'),
    );
    check(holdoutLockedFree, 'the holdout rate is locked on the free tier');

    /*
     * The three things that make a locked option readable rather than merely inert.
     *
     * This is the regression net for a defect that shipped: the first version set
     * `disabled` and dimmed to 45%, which on a light panel made "30 days" all but
     * indistinguishable from "7 days" beside it — so the segment looked ordinary, did
     * nothing when pressed, and never said why. A check on the locked *state* alone
     * would have passed against every bit of that.
     */
    const monthOption = await dashboard.$eval('#period-tabs [data-option="month"]', (node) => ({
      locked: node.dataset.locked === 'true',
      title: node.title,
      ariaLabel: node.getAttribute('aria-label'),
      glyphs: node.querySelectorAll('.option-lock').length,
    }));
    const weekFreeOnDashboard = await dashboard.$eval(
      '#period-tabs [data-option="week"]',
      (node) => node.dataset.locked !== 'true' && node.querySelectorAll('.option-lock').length === 0,
    );
    check(
      monthOption.locked && weekFreeOnDashboard,
      'a free install may report over a week but not a month',
    );
    check(
      monthOption.glyphs === 1 &&
        Boolean(monthOption.title) &&
        (monthOption.ariaLabel ?? '').startsWith('30 days'),
      `and the locked one says so — padlock, tooltip and accessible name (${JSON.stringify(
        monthOption,
      )})`,
    );

    /*
     * The worker's own limit ceiling.
     *
     * Asserted through messages rather than the form, because the form is one of three
     * surfaces that create budgets — the popup's presets and the dashboard's drill-down
     * are the others — and `assertBudgetAllowed` is the only thing all three go through.
     * A UI-only check would pass while two of the three routes were wide open.
     *
     * The three exemptions are checked alongside the refusal, because each is a promise
     * the product makes and each fails silently: an edit that stops working, or a stored
     * window that cannot be corrected, both look like the product breaking rather than
     * like a ceiling.
     */
    const ceilingSites = ['one.example', 'two.example', 'three.example'];
    for (const site of ceilingSites) {
      await ask({ type: 'PUT_BUDGET', site, bytes: 500_000_000, period: 'day', shape: 'progressive' });
    }
    const fourth = await ask({
      type: 'PUT_BUDGET',
      site: 'four.example',
      bytes: 500_000_000,
      period: 'day',
      shape: 'progressive',
    });
    check(
      fourth.ok === false && /Plus/i.test(fourth.error ?? ''),
      `a fourth site limit is refused, and the refusal says why (${fourth.error ?? 'it was accepted'})`,
    );
    const edited = await ask({
      type: 'PUT_BUDGET',
      site: ceilingSites[0],
      bytes: 900_000_000,
      period: 'day',
      shape: 'progressive',
    });
    check(edited.ok === true, 'but an existing limit can still be edited at the ceiling');
    const widened = await ask({
      type: 'PUT_BUDGET',
      site: ceilingSites[0],
      bytes: 900_000_000,
      period: 'week',
      shape: 'progressive',
    });
    check(
      widened.ok === false,
      `and a weekly window is refused on the free tier (${widened.error ?? 'it was accepted'})`,
    );
    // The plan's own limit is outside the count, so it must still be creatable at the
    // ceiling — it is what every alert is measured against.
    const planWide = await ask({
      type: 'PUT_BUDGET',
      site: '#all',
      bytes: 2_000_000_000,
      period: 'month',
      shape: 'progressive',
    });
    check(planWide.ok === true, 'and the plan-wide limit is exempt from the count and the window');

    await settings.reload();
    await settings.waitForSelector('#pane-limits', { state: 'attached', timeout: 10_000 });
    await openSection('limits');
    const addLocked = await settings.$eval('#limit-add', (node) => node.disabled);
    const ceilingNotice = await settings.$('#limit-form-lock .plus-lock');
    check(
      addLocked && Boolean(ceilingNotice),
      'and the add-limit form is locked, with its Set limit button visibly disabled',
    );

    for (const site of [...ceilingSites, '#all']) await ask({ type: 'REMOVE_BUDGET', site });

    /*
     * And it is not a dead control. Pressing it has to lead somewhere, which is the
     * other half of "clickable but does nothing".
     *
     * `force: true` because Playwright's actionability check reads `aria-disabled` as
     * "not enabled" and will not dispatch. A browser has no such rule — `aria-disabled`
     * is advisory to assistive technology and the click event fires normally — so
     * forcing here reproduces what a real press does rather than working around a
     * defect. The attribute stays because it is the truthful claim about a radio option
     * that cannot be selected; what it must not do is stop the option explaining itself.
     */
    await dashboard.click('#period-tabs [data-option="month"]', { force: true });
    await checkWait(check, 'pressing a locked option opens the Plus section', () =>
      dashboard.waitForFunction(
        () => location.pathname.endsWith('settings.html') && location.hash === '#plus',
        null,
        { timeout: 10_000 },
      ),
    );
    // Put the dashboard back; everything after this point expects to be on it.
    await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html`);
    await dashboard.waitForSelector('#period-tabs [data-option]', { timeout: 10_000 });

    await openSection('plus');
    const plusDisclosure = await settings.$eval('#pane-plus', (node) => node.textContent ?? '');
    check(
      plusDisclosure.includes('account email') && plusDisclosure.includes('discards the rest'),
      'the Plus page accurately discloses provider account data handling',
    );
    check(
      plusDisclosure.includes("developer, not Google") &&
        plusDisclosure.includes('refund request') &&
        plusDisclosure.includes('renew until cancelled'),
      'the Plus page states the seller, renewal, cancellation and refund terms',
    );

    check(await setPlus(true), 'the paid tier unlocks for the rest of this run');
    await settings.reload();
    // `attached`, not the default `visible`: a reload keeps the fragment, and the
    // fragment is whatever the last `openSection` set — so this waited on a pane that
    // was deliberately hidden as soon as a check above it left the page on a different
    // section. `openSection` below is what makes it visible.
    await settings.waitForSelector('#pane-saver', { state: 'attached', timeout: 10_000 });
    await openSection('saver');
    await settings.click('#saver-advanced > summary');
    await checkWait(check, 'unlocking Plus enables the individual Data Saver switches', () =>
      settings.waitForFunction(
        () =>
          [...document.querySelectorAll('#feature-groups input')].every((node) => !node.disabled),
        null,
        { timeout: 10_000 },
      ),
    );

    // And switching one back off has to be reported as Custom rather than silently
    // rounded to the level it is nearest. The individual switches are inside Advanced,
    // which is the whole point of the level picker — so opening it is part of the
    // interaction rather than setup for it.
    await settings.click('label[for="feature-systemFonts"]');
    await checkWait(check, 'unpicking one switch reads as Custom', () =>
      settings.waitForFunction(
        () => document.querySelector('#saver-level-custom')?.hasAttribute('hidden') === false,
        null,
        { timeout: 10_000 },
      ),
    );

    /*
     * Wait for the previous save to land before touching the switch again.
     *
     * `changeOptimize` disables every optimize input while a write is in flight, master
     * switch included, and clicking a disabled input does nothing — so this line
     * followed the systemFonts click straight into an occasional 30-second timeout. It
     * reproduced roughly one run in three and never in isolation, which is what a race
     * against a real await looks like. The control being disabled is correct behaviour;
     * what was wrong was a test that did not wait for it.
     */
    await settings.waitForFunction(
      () => document.querySelector('#optimize-toggle')?.disabled === false,
      null,
      { timeout: 10_000 },
    );
    await settings.click(saverSwitch);
    // `checkWait`, not a bare wait: under this script's rule 2 a throw here would delete
    // every check after it from the evidence, so a regression has to print a FAIL.
    await checkWait(check, 'the Data Saver master switch turns it back off', () =>
      settings.waitForFunction(
        () => document.querySelector('#optimize-body')?.hasAttribute('hidden') === true,
        null,
        { timeout: 10_000 },
      ),
    );

    // `data-option`, not the old `data-theme-value`. Every segmented control on every
    // surface now goes through `bindGroup` in `core/dom.ts`, which builds the options
    // itself and stamps `dataset.option` — that is what gave the three fake tablists
    // real radiogroup semantics, arrow keys and a roving tabindex. Scoped to
    // `#theme-group` because there are eleven such groups on this page now, and an
    // unscoped `[data-option="dark"]` is only unambiguous by luck.
    await openSection('appearance');
    await settings.click('#theme-group [data-option="dark"]');
    // Same correction as the popup check above: the `waitForFunction` is the assertion,
    // and a theme picker that does not repaint the document has to print a FAIL rather
    // than throw a timeout over the rest of the run.
    await checkWait(check, 'the Settings appearance control works', () =>
      settings.waitForFunction(
        () => document.documentElement.getAttribute('data-theme') === 'dark',
        null,
        { timeout: 10_000 },
      ),
    );
    await settings.click('#theme-group [data-option="auto"]');
    await settings.waitForFunction(
      () =>
        document
          .querySelector('#theme-group [data-option="auto"]')
          ?.getAttribute('aria-checked') === 'true',
    );

    /**
     * Warm-up, then clear, then measure.
     *
     * Without this the test was flaky at about one run in two, and the cause was
     * the harness rather than the extension: `launchPersistentContext` resolves
     * while the extension is still being loaded, so the very first navigation can
     * complete before the worker's `webRequest` listeners exist, and its document
     * request is never seen. Nobody browses a millisecond after installing an
     * extension, so the honest fix is to let it finish loading — and clearing
     * afterwards means the measured numbers are still only from the second load.
     */
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    /**
     * Waited out on the ledger, not on a clock.
     *
     * "The extension has finished loading" is exactly "the extension has recorded this
     * load", and that is a question it can be asked. The condition is both fixtures at
     * full size rather than merely the site appearing, because a clear that lands while
     * a request is still parked would commit those bytes *after* it — polluting the
     * measured phase with warm-up traffic, which is the one thing this sequence exists
     * to prevent.
     */
    const warmed = await until(
      () => ask({ type: 'GET_OVERVIEW', period: 'today' }),
      (value) =>
        (value.byType?.script ?? 0) >= SCRIPT_BYTES && (value.byType?.image ?? 0) >= IMAGE_BYTES,
      { timeout: 25_000 },
    );
    check(
      (warmed.byType?.script ?? 0) >= SCRIPT_BYTES && (warmed.byType?.image ?? 0) >= IMAGE_BYTES,
      `the warm-up load is fully recorded before anything is cleared (script ${
        warmed.byType?.script ?? 0
      } B, image ${warmed.byType?.image ?? 0} B)`,
    );
    await ask({ type: 'CLEAR_DATA' });

    await page.goto(`${origin}/?measured`, { waitUntil: 'load' });
    await page.evaluate(
      (url) => fetch(url, { cache: 'no-store' }).then((response) => response.arrayBuffer()),
      `${origin}/streamed`,
    );

    /**
     * The first of the three deliberate clocks in this file.
     *
     * Long enough for the content script's batch, the parked-request TTL, and the ledger
     * flush behind both. It stays a clock because the TTL is one: the document and the
     * streamed fetch are both chunked with no declared length, so `webRequest` cannot
     * size either, and each waits in the parked queue for the page's resource timing —
     * posted on the content script's own batching interval — or for the queue's own
     * eight-second sweep. Neither the batch nor the queue is exposed on any message, and
     * adding one so the test could poll it would be changing the product to suit its
     * test.
     */
    await page.waitForTimeout(12_000);
    await dashboard.reload();
    try {
      await dashboard.waitForSelector('.site-row', { timeout: 15_000 });
    } catch {
      // Dump what the dashboard actually shows before giving up. "No rows" and
      // "the read threw" look identical from the outside and have nothing in
      // common as bugs.
      console.log('  stats html:', await dashboard.$eval('#stats', (node) => node.innerHTML));
      console.log('  live region:', await dashboard.$eval('#live-region', (node) => node.textContent));
      console.log(
        '  overview:',
        JSON.stringify(
          await dashboard.evaluate(
            () =>
              new Promise((resolve) =>
                chrome.runtime.sendMessage({ type: 'GET_OVERVIEW', period: 'today' }, (value) =>
                  resolve(value ?? { lastError: chrome.runtime.lastError?.message }),
                ),
              ),
          ),
        ).slice(0, 1200),
      );
      throw new Error('no site rows in the dashboard');
    }

    const rows = await dashboard.$$eval('.site-row', (nodes) =>
      nodes.map((node) => ({
        name: node.querySelector('.site-name')?.textContent ?? '',
        bytes: node.querySelector('.site-bytes')?.textContent ?? '',
      })),
    );
    console.log('  rows:', JSON.stringify(rows));

    // The raw payload, not just what the UI printed: a category missing from the
    // breakdown and a category rounded out of the legend look identical on screen.
    const payload = await dashboard.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'GET_OVERVIEW', period: 'today' }, (value) =>
            resolve(value ?? { lastError: chrome.runtime.lastError?.message }),
          ),
        ),
    );
    console.log('  byType:', JSON.stringify(payload.byType));
    console.log(
      '  totals:',
      JSON.stringify({
        down: payload.totals?.down,
        up: payload.totals?.up,
        requests: payload.totals?.requests,
        estimatedDown: payload.totals?.estimatedDown,
      }),
    );
    check(
      (payload.byType?.main_frame ?? 0) > 0,
      `the HTML document itself is counted (main_frame = ${payload.byType?.main_frame ?? 0} B)`,
    );
    check(
      (payload.byType?.script ?? 0) >= SCRIPT_BYTES,
      `the sized script is measured at full size (${payload.byType?.script ?? 0} of ${SCRIPT_BYTES} B)`,
    );
    check(
      (payload.byType?.image ?? 0) >= IMAGE_BYTES,
      `the sized image is measured at full size (${payload.byType?.image ?? 0} of ${IMAGE_BYTES} B)`,
    );
    check(
      (payload.byType?.xmlhttprequest ?? 0) >= STREAMED_BYTES,
      `the streamed fetch is measured from resource timing (${payload.byType?.xmlhttprequest ?? 0} B)`,
    );

    const local = rows.find((row) => row.name === '127.0.0.1');
    check(Boolean(local), 'the local site appears in the dashboard');

    // Parse the figure the dashboard printed back into bytes and compare it with
    // what the server actually sent. The floor is the two sized fixtures; the
    // ceiling leaves room for headers, favicon attempts and the streamed body.
    const parsed = local ? parseBytes(local.bytes) : 0;
    const floor = SCRIPT_BYTES + IMAGE_BYTES;
    const ceiling = (SCRIPT_BYTES + IMAGE_BYTES + STREAMED_BYTES + PAGE.length) * 1.35;
    check(
      parsed >= floor && parsed <= ceiling,
      `measured ${local?.bytes ?? 'nothing'} (${parsed} B), expected between ${floor} and ${Math.round(ceiling)}`,
    );

    // The measured share moved. It used to be a headline stat card called "Accuracy" —
    // a near-constant number about the tool, sitting in one of four slots that could
    // have carried something actionable, and overclaiming besides, since the figure
    // excludes the halved headers and the zero-counted cancelled bodies. It is now a
    // pill on the "Data used" card. Read it from there; falling back to a stat card
    // keeps this assertion honest rather than silently passing on a missing element.
    const measured = await dashboard.$$eval('.stat', (nodes) =>
      nodes.map((node) => ({
        label: node.querySelector('.stat-label')?.textContent ?? '',
        value: node.querySelector('.stat-value')?.textContent ?? '',
        pill: node.querySelector('.stat-pill')?.textContent ?? '',
      })),
    );
    console.log('  stats:', JSON.stringify(measured));
    const shareText =
      measured.find((stat) => /%/.test(stat.pill))?.pill ??
      measured.find((stat) => stat.label === 'Accuracy')?.value ??
      '';
    const percent = Number(shareText.replace(/[^\d]/g, ''));
    check(
      /%/.test(shareText) && percent >= 60,
      `measured share is ${shareText || 'missing'}, expected 60% or better`,
    );

    // The drill-down: a different set of queries (per-host rows, per-hour rows,
    // visit statistics) that the overview never touches.
    await dashboard.click('.site-row');
    await dashboard.waitForSelector('#detail-panel:not([hidden])', { timeout: 10_000 });
    const detail = await dashboard.evaluate(() => ({
      site: document.querySelector('#detail-site')?.textContent ?? '',
      sub: document.querySelector('#detail-sub')?.textContent ?? '',
      hosts: [...document.querySelectorAll('#detail-hosts tbody tr')].map(
        (row) => row.querySelector('.host-name')?.textContent ?? '',
      ),
      hourBars: document.querySelectorAll('#detail-hours .chart-bar-fill').length,
    }));
    console.log('  detail:', JSON.stringify(detail));
    check(detail.site === '127.0.0.1', `the drill-down names the site (${detail.site})`);
    check(detail.hosts.includes('127.0.0.1'), 'the per-host breakdown has a row');
    check(detail.hourBars >= 1, `the hourly chart has a bar (${detail.hourBars})`);
    check(/page load/.test(detail.sub), `the drill-down reports page loads (${detail.sub})`);

    // Export: the only way anyone can check these numbers against their own bill.
    const csv = await dashboard.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'EXPORT', format: 'csv', days: 30 }, resolve),
        ),
    );
    const lines = String(csv.body ?? '').trim().split('\n');
    check(lines[0]?.startsWith('date,site,down_bytes'), 'the CSV has the expected header');
    check(
      lines.some((line) => line.includes('127.0.0.1')),
      `the CSV has a row for the site (${lines.length - 1} data rows)`,
    );
    check(/\.csv$/.test(csv.filename ?? ''), `the CSV is named sensibly (${csv.filename})`);

    /**
     * A request still in flight when the page changes belongs to the page that asked
     * for it.
     *
     * The ledger used to credit a tab's *current* page load, which for a chunked
     * response means up to eight seconds after the request finished — comfortably long
     * enough to have clicked a link. Those bytes then landed on the next page's row.
     * Nothing looked wrong: the period totals are keyed by site and stayed correct,
     * and `visits` quietly became the wrong shape instead. `visits` is the only input
     * to the optimizer's on-versus-off comparison, so the error correlated with the
     * thing being measured.
     *
     * `localhost` and `127.0.0.1` are the same server and two different site keys,
     * which is what makes any of this observable. The fetch is cross-origin and
     * `no-cors`, so its `transferSize` is 0 and the page cannot report it — that is
     * what keeps the request parked past the navigation rather than settled a second
     * later by the content script.
     *
     * The same wait covers the other half of the defect. Once the page has gone there
     * is no more traffic, so no flush is scheduled and no page can report anything:
     * the request is committed by the parked queue's own timer or it is not counted at
     * all. It used to be the latter, and only for streamed responses — the ones an
     * estimate is least able to stand in for.
     */
    await page.goto(`http://localhost:${port}/plain`, { waitUntil: 'load' });
    await page.evaluate(
      (url) =>
        fetch(url, { mode: 'no-cors', cache: 'no-store' }).then(
          (response) => response.arrayBuffer(),
          () => undefined,
        ),
      `${origin}/streamed`,
    );
    /**
     * The second deliberate clock, and the smallest.
     *
     * The `evaluate` above already resolved, so the body has arrived — what is still
     * outstanding is `onCompleted` reaching the worker and the request being filed in the
     * parked queue. Neither is reported on any message, so there is no condition to poll:
     * the queue is deliberately invisible to the UI, and adding a message to expose it
     * would be changing the product to suit its test. 1500 ms is generous for one event
     * following a body the page has finished reading.
     */
    await page.waitForTimeout(1500);
    await page.goto(`${origin}/plain`, { waitUntil: 'load' });
    /**
     * The third deliberate clock: the parked queue's eight-second TTL, its sweep, and the
     * ledger flush behind that. Same argument as the first — the page is gone, so nothing
     * can report the request and no traffic remains to schedule a flush. Whether these
     * bytes are counted at all is decided by that timer, which is the defect this whole
     * block exists to pin.
     */
    await page.waitForTimeout(12_000);

    const carried = await dashboard.evaluate(
      (site) =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'GET_SITE', site, period: 'today' }, (value) =>
            resolve(value ?? { lastError: chrome.runtime.lastError?.message }),
          ),
        ),
      'localhost',
    );
    console.log(
      '  localhost:',
      JSON.stringify({ down: carried.totals?.down, visits: carried.visits }),
    );
    check(
      (carried.totals?.down ?? 0) >= STREAMED_BYTES,
      `a parked request survives the page that made it (${carried.totals?.down ?? 0} of ${STREAMED_BYTES} B)`,
    );
    check(
      (carried.visits?.count ?? 0) >= 1 && (carried.visits?.meanDown ?? 0) >= STREAMED_BYTES,
      `and stays on that page load rather than the next one (${Math.round(
        carried.visits?.meanDown ?? 0,
      )} B over ${carried.visits?.count ?? 0} load(s))`,
    );

    // Dark theme is a whole second palette; a broken token shows up as unreadable
    // text rather than as an error, so at least confirm it is applied.
    await dashboard.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'SAVE_SETTINGS', changes: { theme: 'dark' } },
            resolve,
          ),
        ),
    );
    await dashboard.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'dark',
      { timeout: 5000 },
    );
    const darkBackground = await dashboard.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    check(
      darkBackground !== 'rgb(242, 246, 246)' && darkBackground !== '',
      `the dark theme changes the background (${darkBackground})`,
    );

    if (process.argv.includes('--shots')) {
      await dashboard.setViewportSize({ width: 1280, height: 1100 });
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await settle(dashboard);
      await dashboard.screenshot({
        path: path.join(root, 'outputs', 'dashboard-dark.png'),
        fullPage: true,
      });
    }

    await dashboard.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'SAVE_SETTINGS', changes: { theme: 'auto' } },
            resolve,
          ),
        ),
    );

    /* ---------------------------------------------------------------- *
     * The blocking experiment
     *
     * The question this answers: when a page asks for a 250 kB image, can the
     * extension stop it, or does it only find out afterwards? `declarativeNetRequest`
     * is evaluated inside Chrome's network stack, so a refused request is never
     * dispatched — but that is a claim from a document until the server confirms it
     * was never asked.
     * ---------------------------------------------------------------- */

    // Cleared *before* the tier is set by hand, not after. `CLEAR_DATA` now also drops
    // every enforcement decision — deleting the usage a limit was computed from and
    // leaving the limit in place would keep a site cut off on the strength of numbers
    // that no longer exist anywhere. So clearing after the `SET_ENFORCEMENT` below would
    // undo it, and the refusal assertions would fail for a reason that is not a bug.
    // Nothing between here and there writes usage, so the clear does its real job —
    // emptying the size model so refusals price from the per-type default — either way.
    await ask({ type: 'CLEAR_DATA' });

    // Every usage store is empty on disk. Necessary but not sufficient, which is the
    // point of the assertion further down: the size model was also being held in
    // memory, so the table emptied here refilled itself from a copy the report could
    // not see.
    const cleared = await ask({ type: 'GET_STORAGE_REPORT' });
    check(
      cleared.sizeModelRows === 0 && cleared.visitRows === 0 && cleared.dailyRows === 0,
      `deleting usage empties every store (${JSON.stringify({
        sizeModel: cleared.sizeModelRows,
        visits: cleared.visitRows,
        daily: cleared.dailyRows,
      })})`,
    );

    /*
     * What the dashboard says when it has nothing to say.
     *
     * This is the only moment in the run where the state a new install opens on exists:
     * every store is empty, no plan is set, and Data Saver has never been on. It is
     * checked here rather than in a test of its own because it cannot be constructed
     * anywhere else, and because every one of these four is a one-line predicate whose
     * failure is silent — the page still renders, it just renders the confident version
     * of itself over nothing.
     *
     * Before SET_ENFORCEMENT below, deliberately: a refusal credits `blocked`, which is
     * one of the figures that takes the savings panel out of its untouched state.
     */
    await dashboard.reload();
    // Through `checkWait`, not bare: the panel not reaching its empty state *is* one of
    // the regressions this block is here to catch, and a thrown wait would report it by
    // deleting every check after it from the evidence rather than by naming it.
    await checkWait(check, 'the Data Saver panel reaches its empty state', () =>
      dashboard.waitForSelector('#savings-idle:not([hidden])', { timeout: 10_000 }),
    );
    const fresh = await dashboard.evaluate(() => ({
      // The pill claims a measured share of a total with no requests in it. It reads
      // "100% measured" because `measuredShare` returns 1 for an empty total, which is
      // right for the figure and wrong as a caption on "0 B".
      pill: document.querySelectorAll('#stats .stat-pill').length,
      // `GET_SERIES` answers a 30-day request with 30 rows whether or not anything is
      // in them, so a length test never fired and the panel drew an axis over no bars.
      chartBars: document.querySelectorAll('#trend-slot .chart-bar-track').length,
      chartNote: (document.querySelector('#trend-slot .stack-note')?.textContent ?? '').trim(),
      statsHidden: document.querySelector('#savings-stats')?.hidden === true,
      compareHidden: document.querySelector('#savings-compare')?.hidden === true,
      // The storage table's own contradiction: seven counts of zero over a non-zero
      // size. Both figures are right and the note is the only thing that says so.
      storageNote: (document.querySelector('#storage-body .field-hint')?.textContent ?? '').trim(),
    }));
    check(
      fresh.pill === 0,
      `no accuracy pill is shown over an empty total (${fresh.pill} pill(s))`,
    );
    check(
      fresh.chartBars === 0 && fresh.chartNote !== '',
      `the daily chart says it is empty rather than drawing nothing (${fresh.chartBars} bars, ${JSON.stringify(fresh.chartNote)})`,
    );
    check(
      fresh.statsHidden && fresh.compareHidden,
      `the Data Saver panel holds one sentence, not its methodology (${JSON.stringify({
        stats: fresh.statsHidden,
        compare: fresh.compareHidden,
      })})`,
    );
    check(
      fresh.storageNote.includes('empty database'),
      `the storage note explains a disk figure over zero rows (${JSON.stringify(fresh.storageNote.slice(0, 60))})`,
    );

    // Photographed here for the same reason it is checked here: this is the only point
    // in the run where the page a new install opens on exists, and the `--shots` block
    // at the end runs against a profile with usage, a limit and a plan in it.
    if (process.argv.includes('--shots')) {
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      // The site drill-down survives the reload, and an earlier check in this run left
      // one open. A capture that documents the first thing anyone sees must not carry a
      // panel nobody has opened yet.
      const detailOpen = await dashboard.$('#detail-panel:not([hidden]) #detail-close');
      if (detailOpen) await detailOpen.click();
      await settle(dashboard);
      await dashboard.screenshot({
        path: path.join(root, 'outputs', 'dashboard-first-run.png'),
        fullPage: true,
      });

      const welcome = await context.newPage();
      await welcome.setViewportSize({ width: 1280, height: 1100 });
      await welcome.goto(`chrome-extension://${extensionId}/welcome.html`);
      await welcome.waitForSelector('#pin-panel', { timeout: 10_000 });
      await settle(welcome);
      await welcome.screenshot({
        path: path.join(root, 'outputs', 'welcome.png'),
        fullPage: true,
      });
      await welcome.close();
      console.log('  wrote outputs/dashboard-first-run.png and welcome.png');
    }

    const applied = await ask({ type: 'SET_ENFORCEMENT', site: '127.0.0.1', tier: 'lean' });
    check(
      applied.ok === true && applied.rules >= 1,
      `enforcement installed ${applied.rules ?? 0} rule(s) for the site`,
    );
    check(
      applied.enforcement?.[0]?.tier === 'lean',
      `the site is recorded as limited (${JSON.stringify(applied.enforcement)})`,
    );

    // And Chrome's own answer, which is a different claim. The optimizer is off at this
    // point, so the whole session set is these rules and nothing else.
    const leanHeld = await heldRules();
    console.log('  rules Chrome holds at lean:', describeRules(leanHeld));
    check(
      ruleIdsAreContiguous(leanHeld, applied.rules ?? 0),
      `Chrome holds the ${applied.rules ?? 0} rule(s) it was handed, numbered from 1 (${describeRules(
        leanHeld,
      )})`,
    );
    check(
      leanHeld.length > 0 &&
        leanHeld.every(
          (rule) =>
            rule.action?.type === 'block' &&
            (rule.condition?.initiatorDomains ?? []).includes('127.0.0.1'),
        ),
      'and every one of them is a block scoped to the limited site',
    );

    resetHits();
    await page.goto(`${origin}/?limited`, { waitUntil: 'load' });

    // The server's own record. `lean` refuses media, images and fonts, so the
    // document and the script must still arrive and the image must not. The load event
    // is what makes the record final: every subresource has by then either arrived or
    // been refused, so no wait is needed before reading it.
    console.log('  server hits while limited:', JSON.stringify(hits));
    check(
      !hits.includes('/fixture.png'),
      `the server was never asked for the image (hits: ${hits.join(' ')})`,
    );
    check(
      hits.includes('/fixture.js'),
      'the script was still allowed through, so the block is selective',
    );

    // What is still in flight is the worker's accounting, so that is what is polled for.
    const limited = await until(
      () => ask({ type: 'GET_OVERVIEW', period: 'today' }),
      (value) =>
        (value.byType?.script ?? 0) >= SCRIPT_BYTES && (value.totals?.blocked ?? 0) >= 1,
      { timeout: 25_000 },
    );
    console.log(
      '  while limited:',
      JSON.stringify({
        byType: limited.byType,
        down: limited.totals?.down,
        blocked: limited.totals?.blocked,
        saved: limited.totals?.saved,
      }),
    );
    check(
      (limited.byType?.image ?? 0) === 0,
      `no image bytes were counted (${limited.byType?.image ?? 0} B)`,
    );
    check(
      (limited.totals?.blocked ?? 0) >= 1,
      `the refusal is recorded (${limited.totals?.blocked ?? 0} blocked)`,
    );
    /**
     * A refused request has no size, so this figure can only come from the model — and
     * the clear above emptied it, so every refusal has to be priced from the per-type
     * default and nothing else.
     *
     * `image` defaults to 45 kB. This server serves a 250 kB image, and the model had
     * learned that before the clear: the previous version of this check asserted the
     * saving was over 100 kB and passed, because the model was still answering from
     * memory after the store had been emptied. So "delete all recorded usage" left the
     * learned model — a table keyed by hostname — in place, and this is the assertion
     * that says otherwise. Exact rather than a range, because a range is what let the
     * old behaviour hide.
     */
    const blockedCount = limited.totals?.blocked ?? 0;
    check(
      blockedCount > 0 && (limited.totals?.saved ?? 0) === blockedCount * DEFAULT_IMAGE_ESTIMATE,
      `every refusal is priced from the default, so the model really was deleted ` +
        `(${limited.totals?.saved ?? 0} B = ${blockedCount} x ${DEFAULT_IMAGE_ESTIMATE})`,
    );
    check(
      (limited.byType?.script ?? 0) >= SCRIPT_BYTES,
      `the script still arrived at full size (${limited.byType?.script ?? 0} B)`,
    );
    // The tight version of "the image did not arrive": with `lean` on, the only
    // bytes recorded for the whole period are the document and the script.
    const expectedLimited =
      (limited.byType?.script ?? 0) + (limited.byType?.main_frame ?? 0);
    check(
      Math.abs((limited.totals?.down ?? 0) - expectedLimited) < 2000,
      `the period total is the document plus the script and nothing else ` +
        `(${limited.totals?.down ?? 0} vs ${expectedLimited} B)`,
    );
    // Two refusals, not one: the page's `<img>` and the favicon, which is also an
    // image request. Worth stating because it is why `saved` is twice the per-type
    // default rather than once.
    check(
      (limited.totals?.saved ?? 0) < IMAGE_BYTES * 3,
      `the credited saving stays in the right order of magnitude (${limited.totals?.saved ?? 0} B)`,
    );

    // And it must be reversible: a rule that cannot be lifted is a broken browser.
    const lifted = await ask({ type: 'SET_ENFORCEMENT', site: '127.0.0.1', tier: 'off' });
    check(lifted.rules === 0, `lifting the limit removes every rule (${lifted.rules})`);
    const afterLift = await heldRules();
    check(
      afterLift.length === 0,
      `and Chrome holds none afterwards, not merely none composed (${describeRules(afterLift)})`,
    );
    resetHits();
    await page.goto(`${origin}/?unlimited`, { waitUntil: 'load' });
    await until(() => hits, (list) => list.includes('/fixture.png'), { timeout: 15_000 });
    check(
      hits.includes('/fixture.png'),
      `the image loads again once the limit is lifted (hits: ${hits.join(' ')})`,
    );

    /* ---------------------------------------------------------------- *
     * The other two tiers
     *
     * `lean` above is where the budget ladder lands first, and it was the only tier ever
     * exercised in a browser. The two that were not are the two that can fail in ways
     * `lean` cannot show.
     *
     * `trim` refuses exactly one resource type. A bug that widens it — an off-by-one in
     * `TIER_DEPTH`, a reordered `SHED_ORDER` — costs a person their images at the tier
     * whose whole promise is that nothing visible changes, and no aggregate anywhere
     * would look different.
     *
     * `strict` is the only tier that sends `sub_frame`, `script`, `stylesheet` and
     * `websocket` to Chrome. A rule set Chrome rejects is rejected atomically: nothing is
     * installed, every limit in the browser silently stops working, and the count the
     * extension reports is exactly the number that does not change when it happens. This
     * script already guards the pack patterns with `isRegexSupported`; enforcement rules
     * had no equivalent, and this is it.
     * ---------------------------------------------------------------- */

    /**
     * The control arm, and it is not a formality.
     *
     * "The server was never asked for the audio" is satisfied just as well by a Chrome
     * that never requests media in this environment as by a working `trim`. Asserting the
     * request happens with nothing enforcing is what tells those two apart, and it is the
     * same argument as the beacon pair further down.
     */
    resetHits();
    await page.goto(`${origin}/tiers?control`, { waitUntil: 'load' });
    await until(() => hits, (list) => TIER_ASSETS.every((asset) => list.includes(asset)), {
      timeout: 20_000,
    });
    console.log('  tier control hits:', JSON.stringify(hits));
    check(
      TIER_ASSETS.every((asset) => hits.includes(asset)),
      `with nothing enforced the page asks for all of ${TIER_ASSETS.join(' ')} (${hits.join(' ')})`,
    );

    const trimmed = await ask({ type: 'SET_ENFORCEMENT', site: '127.0.0.1', tier: 'trim' });
    check(
      trimmed.ok === true && trimmed.rules >= 1,
      `trim installs ${trimmed.rules ?? 0} rule(s) (${JSON.stringify(trimmed.enforcement)})`,
    );
    const trimHeld = await heldRules();
    console.log('  rules Chrome holds at trim:', describeRules(trimHeld));
    check(
      ruleIdsAreContiguous(trimHeld, trimmed.rules ?? 0),
      `Chrome accepted the whole trim set (${describeRules(trimHeld)})`,
    );
    check(
      trimHeld.length > 0 &&
        trimHeld.every((rule) => {
          const types = rule.condition?.resourceTypes ?? [];
          return types.length === 1 && types[0] === 'media';
        }),
      `and trim asks it to refuse media and nothing else (${describeRules(trimHeld)})`,
    );

    resetHits();
    await page.goto(`${origin}/tiers?trim`, { waitUntil: 'load' });
    await until(() => hits, (list) => list.includes('/fixture.js'), { timeout: 20_000 });
    console.log('  server hits at trim:', JSON.stringify(hits));
    check(
      !hits.includes('/fixture.wav'),
      `trim refuses the audio (hits: ${hits.join(' ')})`,
    );
    check(
      ['/fixture.png', '/fixture.css', '/frame', '/fixture.js'].every((asset) =>
        hits.includes(asset),
      ),
      `and refuses nothing else — image, stylesheet, frame and script all arrive (${hits.join(' ')})`,
    );

    const strict = await ask({ type: 'SET_ENFORCEMENT', site: '127.0.0.1', tier: 'strict' });
    check(
      strict.ok === true && strict.rules >= 1,
      `strict installs ${strict.rules ?? 0} rule(s) (${JSON.stringify(strict.enforcement)})`,
    );
    const strictHeld = await heldRules();
    console.log('  rules Chrome holds at strict:', describeRules(strictHeld));
    check(
      ruleIdsAreContiguous(strictHeld, strict.rules ?? 0),
      `Chrome accepted the strict set rather than rejecting it whole (${describeRules(strictHeld)})`,
    );
    /**
     * The four types no other tier ever sends.
     *
     * This is the assertion the section exists for. If Chrome refuses one of them the
     * update fails atomically, `getSessionRules` comes back empty or stale, and the
     * extension's own `strict.rules` is unchanged — so this is the only reading in the
     * script that can see it.
     */
    const strictTypes = new Set(
      strictHeld.flatMap((rule) => rule.condition?.resourceTypes ?? []),
    );
    check(
      ['sub_frame', 'script', 'stylesheet', 'websocket'].every((type) => strictTypes.has(type)),
      `and accepted sub_frame, script, stylesheet and websocket (${[...strictTypes].join(' ')})`,
    );
    check(
      !strictTypes.has('main_frame'),
      'and no tier asks it to block the document, which is what leaves the page able to explain itself',
    );

    resetHits();
    await page.goto(`${origin}/tiers?strict`, { waitUntil: 'load' });
    // Waiting for a subresource here would be waiting for something that must never
    // arrive, so the navigation itself is the condition.
    await until(() => hits, (list) => list.some((url) => url.startsWith('/tiers')), {
      timeout: 20_000,
    });
    console.log('  server hits at strict:', JSON.stringify(hits));
    check(
      hits.some((url) => url.startsWith('/tiers?strict')),
      `the document still arrives at strict (hits: ${hits.join(' ')})`,
    );
    check(
      TIER_ASSETS.every((asset) => !hits.includes(asset)),
      `and every subresource on it is refused (${hits.join(' ')})`,
    );

    const unstrict = await ask({ type: 'SET_ENFORCEMENT', site: '127.0.0.1', tier: 'off' });
    check(unstrict.rules === 0, `lifting strict removes every rule (${unstrict.rules})`);
    check(
      (await heldRules()).length === 0,
      'and Chrome is left holding none of them',
    );

    /* ---------------------------------------------------------------- *
     * A budget enforcing itself
     *
     * The experiment above set a tier by hand. This one sets a *budget* and lets
     * traffic cross it: the governor has to notice from its own counters, install the
     * rules, and tell the page — with nothing driving it but the page loading.
     *
     * 800 kB per day, so the guard band is 80 kB and the tiers land at 400 kB (video),
     * 600 kB (images) and 720 kB (everything). One load of this page without the
     * streamed fetch is about 651 kB, which puts it in `lean` — images refused — with
     * nothing set by hand.
     *
     * The first load still gets its image: every request on the page is dispatched
     * while parsing, before any of them has finished being counted. That is the
     * overshoot described in PLAN.md §4.2, and it is why the assertion below is about
     * the *second* load.
     * ---------------------------------------------------------------- */

    const ALLOWANCE = 800_000;
    await ask({ type: 'CLEAR_DATA' });
    const budgeted = await ask({
      type: 'PUT_BUDGET',
      site: '127.0.0.1',
      bytes: ALLOWANCE,
      period: 'day',
      shape: 'progressive',
    });
    check(
      budgeted.statuses?.[0]?.budget?.bytes === ALLOWANCE,
      `the budget is stored (${JSON.stringify(budgeted.statuses?.[0]?.budget)})`,
    );
    check(
      budgeted.statuses?.[0]?.tier === 'off',
      `nothing is enforced before any traffic (${budgeted.statuses?.[0]?.tier})`,
    );

    resetHits();
    await page.goto(`${origin}/?budget-1`, { waitUntil: 'load' });
    // Polled on both halves of what is being claimed — the governor counted it, and the
    // governor acted on it. A sleep here proved neither: it just made the read late
    // enough that they were usually both true.
    const crossed = await until(
      () => ask({ type: 'GET_BUDGETS' }),
      (value) =>
        (value.statuses?.[0]?.used ?? 0) > 600_000 && value.statuses?.[0]?.tier !== 'off',
      { timeout: 25_000 },
    );
    const first = crossed.statuses?.[0];
    console.log(
      '  after one load:',
      JSON.stringify({ used: first?.used, share: first?.share, tier: first?.tier }),
    );
    check(
      (first?.used ?? 0) > 600_000,
      `the governor counted the load live (${first?.used ?? 0} B)`,
    );
    check(
      first?.tier === 'lean' || first?.tier === 'strict',
      `enforcement engaged from usage alone, no rules set by hand (${first?.tier})`,
    );

    // The governor's counter is kept in memory and incremented per request; the
    // ledger's figure is read back off disk. They are two independent paths to the
    // same number and they must not drift, or a limit would fire against a total
    // nothing else in the extension agrees with.
    const ledgerView = await ask({ type: 'GET_OVERVIEW', period: 'today' });
    const ledgerTotal =
      (ledgerView.sites ?? []).find((entry) => entry.site === '127.0.0.1')?.totals ?? {};
    const persisted = (ledgerTotal.down ?? 0) + (ledgerTotal.up ?? 0);
    check(
      Math.abs(persisted - (first?.used ?? 0)) <= 2000,
      `the live counter agrees with the stored ledger (${first?.used ?? 0} vs ${persisted} B)`,
    );

    // Second load: the budget is already over, so the image must never be requested.
    resetHits();
    await page.goto(`${origin}/?budget-2`, { waitUntil: 'load' });
    console.log('  server hits over budget:', JSON.stringify(hits));
    check(
      !hits.includes('/fixture.png'),
      `the over-budget load never asked for the image (hits: ${hits.join(' ')})`,
    );

    // And the page has to say so, or a limit is indistinguishable from a bug. The banner
    // is injected by the worker after the load, so this is the one condition here that is
    // genuinely still outstanding when `load` fires — and it is polled, not slept on.
    await checkWait(check, 'the page shows a notice', () =>
      page.waitForFunction(() => Boolean(document.getElementById('byte-budget-notice')), null, {
        timeout: 15_000,
      }),
    );

    /* ---------------------------------------------------------------- *
     * Settings at a phone width
     *
     * Checked rather than eyeballed, because the failure is invisible on a desktop
     * and severe on a phone. A grid item's automatic minimum size is its min-content
     * size, and the six-column limits table Settings used to carry gave its panel a
     * min-content width of 760px — so at 390px the whole document was 772px wide, the
     * page scrolled sideways, and Pause and Remove sat off screen. The table is a list
     * of cards now, which is the layout it collapsed into at this width anyway; what
     * is measured here is that it has not found a new way to overflow. A limit has to
     * exist for the list to have anything in it, which is why the check lives here
     * rather than with the other Settings checks.
     * ---------------------------------------------------------------- */

    await settings.setViewportSize({ width: 390, height: 900 });
    await settings.reload();
    await openSection('limits');
    await settings.waitForSelector('.limit-card', { timeout: 10_000 });
    // Fonts, then a forced layout flush — the actual precondition for measuring a
    // stacked card, rather than a third of a second and a hope.
    await settle(settings);
    const narrow = await settings.evaluate(() => {
      const doc = document.documentElement;
      const card = document.querySelector('.limit-card');
      const text = (selector) => card.querySelector(selector)?.textContent?.trim() ?? '';
      return {
        scrollW: doc.scrollWidth,
        clientW: doc.clientWidth,
        // Every row action has to be reachable without a sideways scroll nobody is
        // told about.
        actionsOnScreen: [...document.querySelectorAll('.row-actions .ghost-button')].every(
          (node) => node.getBoundingClientRect().right <= doc.clientWidth + 1,
        ),
        actions: document.querySelectorAll('.row-actions .ghost-button').length,
        // There is no header row to lose any more, so what has to hold is that the
        // card names all four of its figures itself.
        lines: [
          text('.limit-site'),
          text('.limit-allowance .ghost-button'),
          text('.limit-meter span'),
          text('.limit-card > .row-sub'),
        ],
      };
    });
    console.log('  narrow settings:', JSON.stringify(narrow));
    check(
      narrow.scrollW <= narrow.clientW,
      `Settings does not scroll sideways at 390px (${narrow.scrollW} of ${narrow.clientW})`,
    );
    check(
      narrow.actions >= 3 && narrow.actionsOnScreen,
      `all ${narrow.actions} limit actions stay on screen at 390px`,
    );
    check(
      narrow.lines.length === 4 && narrow.lines.every((value) => /\w/.test(value)),
      `the limit card says what each of its figures is (${JSON.stringify(narrow.lines)})`,
    );

    if (process.argv.includes('--shots')) {
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await settings.evaluate(() => window.scrollTo(0, 0));
      await settings.screenshot({
        path: path.join(root, 'outputs', 'settings-narrow.png'),
        fullPage: true,
      });
      console.log('  wrote outputs/settings-narrow.png');
    }

    // Back to the desktop width the remaining checks and screenshots assume.
    await settings.setViewportSize({ width: 1280, height: 1100 });

    if (process.argv.includes('--shots')) {
      // Photographed while a limit is actually in force, which is the only state
      // where the limit UI has anything to show.
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await page.screenshot({ path: path.join(root, 'outputs', 'notice.png') });

      const popup = await context.newPage();
      await popup.setViewportSize({ width: 420, height: 900 });
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      // The popup asks the worker which site the *active* tab is showing, so the
      // limited page has to be the active one for the limit card to have anything to
      // say. Photographing an extension page as if it were the toolbar popup is the
      // one place that distinction leaks.
      await page.bringToFront();
      await popup.reload();
      try {
        await popup.waitForSelector('#limit-card:not([hidden])', { timeout: 5000 });
      } catch {
        console.log('  note  the popup limit card did not render for the shot');
      }
      await popup.screenshot({ path: path.join(root, 'outputs', 'popup-limit.png'), fullPage: true });
      await popup.close();

      await settings.reload();
      await settings.setViewportSize({ width: 1280, height: 1100 });
      await openSection('limits');
      await settings.waitForSelector('.limit-card', { timeout: 10_000 });
      await settings.evaluate(() => window.scrollTo(0, 0));
      await settle(settings);
      await settings.screenshot({
        path: path.join(root, 'outputs', 'settings-limits.png'),
        fullPage: true,
      });
      console.log('  wrote outputs/notice.png, popup-limit.png and settings-limits.png');
    }

    // A grant relaxes it for this window only, and takes effect without a reload.
    const granted = await ask({ type: 'GRANT_BYTES', site: '127.0.0.1', bytes: 25_000_000 });
    const relaxed = granted.statuses?.[0];
    check(
      relaxed?.allowance === ALLOWANCE + 25_000_000,
      `the grant raises the allowance for this window (${relaxed?.allowance})`,
    );
    check(relaxed?.tier === 'off', `and lifts enforcement (${relaxed?.tier})`);

    // The banner has to go with it, on the page that is already open. A notice that
    // outlives the limit it describes is worse than no notice.
    await checkWait(check, 'the notice is withdrawn when the limit is lifted', () =>
      page.waitForFunction(() => !document.getElementById('byte-budget-notice'), null, {
        timeout: 15_000,
      }),
    );

    resetHits();
    await page.goto(`${origin}/?granted`, { waitUntil: 'load' });
    await until(() => hits, (list) => list.includes('/fixture.png'), { timeout: 15_000 });
    check(
      hits.includes('/fixture.png'),
      `the image loads again after the grant (hits: ${hits.join(' ')})`,
    );

    const removed = await ask({ type: 'REMOVE_BUDGET', site: '127.0.0.1' });
    check(
      (removed.statuses ?? []).length === 0,
      `removing the budget leaves nothing behind (${JSON.stringify(removed.statuses)})`,
    );

    /* ---------------------------------------------------------------- *
     * First run
     *
     * The install used to open nothing and say nothing. `welcome.html` asks two
     * questions, and the second half of the first one is load-bearing in a way that is
     * easy to miss: `settings.planBytes` on its own produces no alert and no enforcement,
     * because both read the governor's *budgets*. A plan recorded without a matching
     * `#all` allowance is a number on a screen and a default-on plan warning watching
     * nothing — a failure that is silent and looks exactly like one that works.
     *
     * So the assertion is not "the form saves". It is that answering the question wires
     * the two together, in both directions.
     * ---------------------------------------------------------------- */

    const PLAN_BYTES = 2_000_000_000;
    const welcome = await context.newPage();
    try {
      await welcome.goto(`chrome-extension://${extensionId}/welcome.html`);
      await checkWait(check, 'the first-run page asks its two questions and offers the switch', () =>
        Promise.all([
          welcome.waitForSelector('#plan-size', { timeout: 10_000 }),
          welcome.waitForSelector('#cycle-day', { timeout: 10_000 }),
          welcome.waitForSelector('#saver-toggle', { timeout: 10_000 }),
        ]),
      );

      await welcome.fill('#plan-size', '2 GB');
      // The echo is the whole reason that field has a hint. `parseByteSize` reads a bare
      // number as megabytes and reads a comma differently depending on how many digits
      // follow it, and a size taken as ten times what was typed produces a limit that
      // then simply never fires. Matched loosely on the separator because the hint is
      // formatted with `Intl` and the browser's locale decides the character.
      const sizeHint = await welcome.textContent('#plan-size-hint');
      check(
        /\b2[.,]0 GB\b/.test(sizeHint ?? ''),
        `and echoes back the size it actually read (${sizeHint})`,
      );

      await welcome.selectOption('#cycle-day', '17');
      await welcome.click('#plan-save');
      await checkWait(check, 'the plan saves', () =>
        welcome.waitForFunction(
          () => /Saved/.test(document.querySelector('#plan-status')?.textContent ?? ''),
          null,
          { timeout: 15_000 },
        ),
      );

      const planned = await ask({ type: 'GET_SETTINGS' });
      check(
        planned.settings?.planBytes === PLAN_BYTES && planned.settings?.cycleStartDay === 17,
        `the plan and the cycle are stored (${planned.settings?.planBytes} B, resets on day ${planned.settings?.cycleStartDay})`,
      );
      const planBudget = ((await ask({ type: 'GET_BUDGETS' })).statuses ?? []).find(
        (entry) => entry.budget?.site === '#all',
      );
      check(
        planBudget?.budget?.bytes === PLAN_BYTES && planBudget?.budget?.period === 'month',
        `and the plan is an allowance the governor tracks, not just a number on a screen (${JSON.stringify(
          planBudget?.budget,
        )})`,
      );

      // The other direction, which is the one that leaves a browser broken when it is
      // missing: clearing the plan has to take the allowance with it, or a `hard` cap
      // keeps refusing requests on the strength of a figure no surface displays any more.
      await welcome.fill('#plan-size', '');
      await welcome.click('#plan-save');
      await checkWait(check, 'clearing the plan saves too', () =>
        welcome.waitForFunction(
          () => /No plan set/.test(document.querySelector('#plan-status')?.textContent ?? ''),
          null,
          { timeout: 15_000 },
        ),
      );
      const unplanned = await ask({ type: 'GET_SETTINGS' });
      const leftover = ((await ask({ type: 'GET_BUDGETS' })).statuses ?? []).filter(
        (entry) => entry.budget?.site === '#all',
      );
      check(
        unplanned.settings?.planBytes === null && leftover.length === 0,
        `clearing the plan takes its allowance with it (${unplanned.settings?.planBytes}, ${JSON.stringify(
          leftover,
        )})`,
      );
    } finally {
      await welcome.close();
    }

    /* ---------------------------------------------------------------- *
     * The budget over everything
     *
     * `#all` is the only budget whose rule names no site. Its condition carries
     * `resourceTypes` and nothing else, which Chrome reads as "every request in this
     * browser" — the one shape that can reach traffic with no origin to scope against,
     * which is most of what a data plan is actually spent on. It is also the one shape
     * that can go wrong everywhere at once, and until now nothing had proven it installs,
     * that it applies past the site that happened to trip it, or that it lifts.
     *
     * The proof that it is genuinely unscoped is the second load. `localhost` and
     * `127.0.0.1` are the same server and two different site keys, so a rule that had
     * quietly acquired an `initiatorDomains` — by a bad merge, or by the `ALL_SITES`
     * branch in `enforcementRules` falling through — would still refuse the first and let
     * the second straight through, and every byte-counting assertion in this file would
     * carry on passing.
     * ---------------------------------------------------------------- */

    const totalOf = (statuses) => (statuses ?? []).find((entry) => entry.budget?.site === '#all');

    await ask({ type: 'CLEAR_DATA' });
    const total = await ask({
      type: 'PUT_BUDGET',
      site: '#all',
      bytes: ALLOWANCE,
      period: 'day',
      shape: 'progressive',
    });
    check(
      totalOf(total.statuses)?.budget?.bytes === ALLOWANCE,
      `a budget over everything is stored (${JSON.stringify(totalOf(total.statuses)?.budget)})`,
    );
    check(
      totalOf(total.statuses)?.tier === 'off',
      `and nothing is enforced before any traffic (${totalOf(total.statuses)?.tier})`,
    );

    resetHits();
    await page.goto(`${origin}/?all-1`, { waitUntil: 'load' });
    const totalCrossed = await until(
      () => ask({ type: 'GET_BUDGETS' }),
      (value) => (totalOf(value.statuses)?.used ?? 0) > 600_000 && totalOf(value.statuses)?.tier !== 'off',
      { timeout: 25_000 },
    );
    const totalStatus = totalOf(totalCrossed.statuses);
    console.log(
      '  total budget after one load:',
      JSON.stringify({ used: totalStatus?.used, share: totalStatus?.share, tier: totalStatus?.tier }),
    );
    check(
      (totalStatus?.used ?? 0) > 600_000,
      `the total counted the load, priming from every site's rows rather than one (${
        totalStatus?.used ?? 0
      } B)`,
    );
    check(
      totalStatus?.tier === 'lean' || totalStatus?.tier === 'strict',
      `and enforcement engaged from usage alone (${totalStatus?.tier})`,
    );

    /**
     * The rule's shape, read from Chrome.
     *
     * No assertion about bytes can distinguish an unscoped rule from one scoped to the
     * site that happened to trip it, because on this server they refuse the same request.
     * This is the only reading that can, and it is why the check exists separately from
     * the two loads either side of it.
     */
    const totalHeld = await heldRules();
    console.log('  rules while the total budget enforces:', describeRules(totalHeld));
    check(
      ruleIdsAreContiguous(totalHeld, 1),
      `one rule covers everything, and Chrome holds it (${describeRules(totalHeld)})`,
    );
    check(
      totalHeld.length > 0 &&
        totalHeld.every(
          (rule) =>
            (rule.condition?.initiatorDomains ?? []).length === 0 &&
            (rule.condition?.tabIds ?? []).length === 0,
        ),
      `and it names no site and no tab, as a limit over everything has to (${describeRules(
        totalHeld,
      )})`,
    );

    // The other half, on a site key that has never had a budget of its own.
    resetHits();
    await page.goto(`http://localhost:${port}/?all-2`, { waitUntil: 'load' });
    await until(() => hits, (list) => list.some((url) => url.startsWith('/?all-2')), {
      timeout: 20_000,
    });
    console.log('  server hits under the total budget:', JSON.stringify(hits));
    check(
      !hits.includes('/fixture.png'),
      `the total budget refuses images on a site it was never pointed at (hits: ${hits.join(' ')})`,
    );
    // Deliberately not asserted against the script: one more load can carry the total
    // past 100%, and at `strict` the script is refused too. What holds at every tier is
    // that the document arrives, which is the property the ladder is built around.
    check(
      hits.some((url) => url.startsWith('/?all-2')),
      'while the document itself is never refused, at any tier',
    );

    const totalRemoved = await ask({ type: 'REMOVE_BUDGET', site: '#all' });
    check(
      totalOf(totalRemoved.statuses) === undefined,
      `removing it leaves no status behind (${JSON.stringify(totalRemoved.statuses)})`,
    );
    // `heldRules`, not `sessionRules`: the permanent subscription exemption is always
    // installed, so a poll waiting for Chrome to hold literally nothing would wait out
    // its timeout and then report the exemption as the unscoped block that outlived its
    // budget — which is the one thing this check exists to catch.
    const afterTotal = await until(() => heldRules(), (list) => list.length === 0, {
      timeout: 15_000,
    });
    check(
      afterTotal.length === 0,
      `and Chrome is left holding nothing — an unscoped block outliving its budget is a ` +
        `browser that refuses images on every site with nothing left anywhere to say why ` +
        `(${describeRules(afterTotal)})`,
    );

    resetHits();
    await page.goto(`http://localhost:${port}/?all-3`, { waitUntil: 'load' });
    await until(() => hits, (list) => list.includes('/fixture.png'), { timeout: 15_000 });
    check(
      hits.includes('/fixture.png'),
      `and images load again everywhere once it is removed (hits: ${hits.join(' ')})`,
    );

    /* ---------------------------------------------------------------- *
     * The optimizers
     *
     * Each one is checked against something the extension cannot fake: what the local
     * server was asked for, and what URL Playwright's route handler was handed. The
     * Wikimedia request goes to the real host pattern — Playwright fulfils it rather
     * than the network, so what it is *asked for* is the proof the rewrite happened.
     * ---------------------------------------------------------------- */

    // Every pattern has to be one Chrome's RE2 will accept. An invalid one is not
    // rejected on its own: `updateSessionRules` applies atomically, so it takes down
    // every other rule with it, including the limits.
    /*
     * `requireCapturing` and `isCaseSensitive` are not decoration — they are the whole
     * assertion.
     *
     * This guard asked `isRegexSupported({ regex })` and reported all six packs fine
     * while Chrome rejected two of them at install with `memoryLimitExceeded`. A pack
     * rule is a REDIRECT, so its compiled program has to retain capture groups for
     * `regexSubstitution`, and that is what pushes a pattern over RE2's 2 KB budget.
     * Checking without the flag compiles something the extension never installs.
     *
     * The cost of the miss was total: Chrome applies a session rule set atomically, so
     * one oversized pattern meant zero optimizer rules installed and Data Saver doing
     * nothing at all, on every browser, silently. These options must stay in step with
     * how `rules/session.ts` actually publishes the rule.
     */
    const regexSupport = await dashboard.evaluate(async (patterns) => {
      const results = [];
      for (const [id, regex] of patterns) {
        const outcome = await chrome.declarativeNetRequest.isRegexSupported({
          regex,
          isCaseSensitive: true,
          requireCapturing: true,
        });
        results.push([id, outcome.isSupported === true, outcome.reason ?? '']);
      }
      return results;
    }, PACK_PATTERNS);
    for (const [id, supported, reason] of regexSupport) {
      check(supported, `pack "${id}" uses a pattern Chrome accepts${reason ? ` (${reason})` : ''}`);
    }

    /**
     * Wikimedia, served locally, at a size that depends on the width in the URL.
     *
     * The first version of this fixture returned the same bytes for both variants, and
     * the measured saving came out as exactly zero — correctly. A rewrite that fetches an
     * identically sized file has saved nothing, and a test whose two variants weigh the
     * same cannot tell a working measurement from a broken one.
     */
    const wikiAsked = [];
    await context.route('https://upload.wikimedia.org/**', async (route) => {
      const url = route.request().url();
      wikiAsked.push(url);
      const width = Number(/\/(\d+)px-/.exec(url)?.[1] ?? 800);
      // Pixel area scales with the square of the width, and an uncompressed PNG's size
      // scales with its area — so the 800px variant is about a quarter of the 1600px one,
      // which is roughly what a real thumbnail pair does.
      const side = Math.max(16, Math.round(width / 4));
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'Cache-Control': 'no-store', 'Timing-Allow-Origin': '*' },
        body: buildPng(side, side),
      });
    });

    // The analytics beacon's witness. `blockBeacons` refuses by destination, so what
    // matters is whether this handler is ever reached — a refused request never leaves
    // Chrome, so an empty list is the pass. The first-party `/beacon` is watched by the
    // server's own hit log, and the two together prove the scoping in both directions.
    const analyticsAsked = [];
    await context.route('https://www.google-analytics.com/**', async (route) => {
      analyticsAsked.push(route.request().url());
      await route.fulfill({ status: 204, body: '' });
    });

    // `dropHints` is off by default because a page may be prefetching something you are
     // about to want. Turned on here so it can be tested at all.
    const enabled = await ask({
      type: 'SAVE_OPTIMIZE',
      changes: { enabled: true, features: { dropHints: true } },
    });
    check(
      enabled.ok === true && enabled.rules >= 6,
      `the optimizer installs its rules (${enabled.rules ?? 0})`,
    );
    const optimizeHeld = await heldRules();
    console.log('  rules Chrome holds for the optimizer:', describeRules(optimizeHeld));
    check(
      ruleIdsAreContiguous(optimizeHeld, enabled.rules ?? 0),
      `and Chrome holds all ${enabled.rules ?? 0} of them (${describeRules(optimizeHeld)})`,
    );

    /**
     * Which of two matching rules Chrome would pick, asserted against Chrome.
     *
     * DNR compares `priority` first and falls back to the allow > block > redirect
     * ordering only to break a tie *within* one priority. At the numbers this shipped
     * with — limits at 1, pack redirects at 2 — a site over a hard cap kept spending
     * bytes through exactly the five CDNs the optimizer knows how to rewrite, refused
     * everywhere else and quietly not refused there. `tests/rules.test.mjs` pins the gap
     * between the two pure functions; this pins that both sets survive into one
     * installed rule set with the gap intact, which is a separate thing that can break.
     *
     * `trim` on the site the optimizer page is served from, because it refuses `media`
     * and that page has none — so the limit is inert as an experiment and real as a rule.
     */
    const withBoth = await ask({ type: 'SET_ENFORCEMENT', site: '127.0.0.1', tier: 'trim' });
    const mixed = await heldRules();
    // Limits are composed first and the whole set is renumbered from 1, so the lowest
    // ids are the limit rules. That ordering is `SOURCE_ORDER`'s only job and it is what
    // makes the two halves separable here.
    const limitCount = withBoth.rules ?? 0;
    const limitPriority = mixed
      .filter((rule) => rule.id <= limitCount + GUARD_RULE_COUNT)
      .map((rule) => rule.priority);
    const optimizePriority = mixed
      .filter((rule) => rule.id > limitCount + GUARD_RULE_COUNT)
      .map((rule) => rule.priority);
    console.log(
      '  priorities Chrome holds:',
      JSON.stringify({ limit: limitPriority, optimize: optimizePriority }),
    );
    check(
      limitPriority.length > 0 &&
        optimizePriority.length > 0 &&
        Math.min(...limitPriority) > Math.max(...optimizePriority),
      `every limit rule outranks every optimizer rule in Chrome's own set (limits ${JSON.stringify(
        limitPriority,
      )} vs optimizers ${JSON.stringify(optimizePriority)})`,
    );
    await ask({ type: 'SET_ENFORCEMENT', site: '127.0.0.1', tier: 'off' });

    /**
     * A control load first, so the original variant's size is on record.
     *
     * This is the mechanism that turns a modelled saving into a measured one, and it is
     * worth demonstrating in that order: with no baseline the first rewrite can only be
     * priced from the pack's expected ratio, and once the original has been seen the
     * saving is subtraction.
     */
    // Cleared *before* the control load, not between it and the optimized one: deleting
    // recorded usage deletes the observed original sizes too, and the whole point of the
    // control load is to record one.
    await ask({ type: 'CLEAR_DATA' });
    await ask({ type: 'SET_SITE_OPTIMIZE', site: '127.0.0.1', optimize: false });
    resetHits();
    wikiAsked.length = 0;
    analyticsAsked.length = 0;
    await page.goto(`${origin}/optimized`, { waitUntil: 'load' });
    // The three things this load has to produce, waited on as themselves. Both beacons
    // are dispatched by the same inline script, so the first-party one arriving is what
    // says the analytics one has been attempted — which is what makes its absence from
    // the optimized load below mean something.
    await until(
      () => ({ hits, wikiAsked, analyticsAsked }),
      (seen) =>
        seen.hits.includes('/beacon') &&
        seen.analyticsAsked.length > 0 &&
        seen.wikiAsked.length > 0,
      { timeout: 20_000 },
    );
    console.log('  control load asked for:', JSON.stringify(wikiAsked));
    check(
      wikiAsked.some((url) => url.includes('/1600px-')),
      'an unoptimized load fetches the original variant',
    );
    check(
      hits.includes('/beacon') && analyticsAsked.length > 0,
      `and keeps both its beacons (hits: ${hits.join(' ')}, analytics: ${analyticsAsked.length})`,
    );
    check(
      saveDataByPath.get('/optimized') !== 'on',
      `and gets no Save-Data header (${saveDataByPath.get('/optimized')})`,
    );

    const baselined = await until(
      () => ask({ type: 'GET_SAVINGS', days: 30 }),
      (value) => (value.baselines ?? 0) >= 1,
      { timeout: 20_000 },
    );
    check(
      (baselined.baselines ?? 0) >= 1,
      `the original size is now on file (${baselined.baselines ?? 0})`,
    );

    await ask({ type: 'SET_SITE_OPTIMIZE', site: '127.0.0.1', optimize: true });

    // The page optimizer has to actually be registered. Excluding a site rewrites the
    // script's `excludeMatches`, and an invalid pattern there makes Chrome reject the
    // whole registration — which left the page optimizers absent everywhere, with the
    // network rules still working so nothing looked wrong.
    const registration = await dashboard.evaluate(async () => {
      const scripts = await chrome.scripting.getRegisteredContentScripts();
      return scripts.map((entry) => ({ id: entry.id, excludes: entry.excludeMatches ?? [] }));
    });
    console.log('  registered scripts:', JSON.stringify(registration));
    check(
      registration.some((entry) => entry.id === 'byte-budget-optimize'),
      'the page optimizer is registered once the site is optimized again',
    );

    resetHits();
    wikiAsked.length = 0;
    analyticsAsked.length = 0;
    await page.goto(`${origin}/optimized`, { waitUntil: 'load' });
    // The same two network conditions as the control load. The first-party beacon and
    // the Wikimedia request are the last two things this page does, so their arrival is
    // what says the page is finished — and the analytics beacon, which must *not*
    // arrive, was dispatched by the same inline script as the one that did.
    await until(
      () => ({ hits, wikiAsked }),
      (seen) => seen.hits.includes('/beacon') && seen.wikiAsked.length > 0,
      { timeout: 20_000 },
    );

    console.log('  wikimedia asked for:', JSON.stringify(wikiAsked));
    console.log('  server hits while optimizing:', JSON.stringify(hits));
    console.log('  analytics beacons that escaped:', JSON.stringify(analyticsAsked));

    check(
      wikiAsked.length > 0 && wikiAsked.every((url) => url.includes('/800px-')),
      `the Wikimedia thumbnail was requested at 800px, not 1600 (${wikiAsked.join(' ')})`,
    );
    check(
      !wikiAsked.some((url) => url.includes('/1600px-')),
      'and the large variant was never requested',
    );

    check(
      saveDataByPath.get('/optimized') === 'on',
      `the document carried Save-Data: on (${saveDataByPath.get('/optimized')})`,
    );
    check(
      analyticsAsked.length === 0,
      `the analytics beacon was refused (escaped: ${analyticsAsked.length})`,
    );
    check(
      hits.includes('/beacon'),
      `and the page's own beacon still went (hits: ${hits.join(' ')})`,
    );

    /**
     * Reported, not asserted — and that demotion is the finding, not a concession.
     *
     * `dropHints` has no network rule behind it. It is a content script that removes
     * `<link rel=prefetch>` elements, so whether the request reaches the server is a
     * race against Chrome's preload scanner, which reads the hint out of the first HTML
     * before any script exists. This check asserted the network outcome and had been
     * passing on the winning side of that race; when it lost, it looked like a
     * regression in code that had not been touched.
     *
     * It is the same limit PLAN.md §5.2 records for the image features, and the same one
     * the click-to-load copy already discloses. The customer-facing wording was the
     * thing actually wrong here and has been corrected; what the feature can genuinely
     * promise is the DOM assertion below, and hints a page adds after the initial parse.
     */
    console.log(
      `  note  the prefetch hint ${
        hits.includes('/prefetched') ? 'was requested before the script could remove it' : 'never reached the server'
      }`,
    );

    /**
     * The page optimizer, checked by its effects on the document.
     *
     * Not by its marker on `window`: a content script runs in an isolated world, so
     * anything it sets there is invisible to `page.evaluate`, which runs in the main
     * one. The DOM is what the two worlds share, and the DOM is what was supposed to
     * change.
     *
     * Polled rather than read once after a sleep, because the script runs after `load`
     * and is the one part of this page that is genuinely still outstanding when the
     * navigation resolves. Polled with `until` rather than `waitForFunction` so that a
     * script which never arrives produces the two named failures below carrying the
     * values actually found, instead of a timeout that asserts nothing and ends the run.
     */
    const pageState = await until(
      () =>
        page.evaluate(() => ({
          belowLoading: document.getElementById('below')?.getAttribute('loading') ?? null,
          prefetchLinks: document.querySelectorAll('link[rel~="prefetch"]').length,
        })),
      (state) => state.belowLoading === 'lazy' && state.prefetchLinks === 0,
      { timeout: 20_000 },
    );
    console.log('  page optimizer:', JSON.stringify(pageState));
    check(
      pageState.belowLoading === 'lazy',
      `the page script reached the document and marked the offscreen image (${pageState.belowLoading})`,
    );
    check(pageState.prefetchLinks === 0, 'the prefetch link was removed from the document');

    /**
     * And an honest note about what that did *not* achieve.
     *
     * Marking a parser-inserted image lazy does not stop it being fetched — its request
     * left before any script could see the element. The attribute is what makes the
     * feature work for content added later, which is what its description now says. This
     * assertion exists so the claim cannot quietly drift back.
     */
    console.log(
      `  note  the offscreen image was ${hits.includes('/fixture.png') ? 'still' : 'not'} fetched on the initial load`,
    );

    const report = await until(
      () => ask({ type: 'GET_SAVINGS', days: 30 }),
      (value) => (value.rewritten ?? 0) >= 1 && (value.savedMeasured ?? 0) > 0,
      { timeout: 20_000 },
    );
    console.log(
      '  savings:',
      JSON.stringify({
        saved: report.saved,
        savedMeasured: report.savedMeasured,
        rewritten: report.rewritten,
        blocked: report.blocked,
        baselines: report.baselines,
        deltas: report.deltas?.length,
      }),
    );
    check((report.rewritten ?? 0) >= 1, `the rewrite is counted (${report.rewritten ?? 0})`);
    check((report.saved ?? 0) > 0, `a saving is credited (${report.saved ?? 0} B)`);
    check(
      (report.savedMeasured ?? 0) <= (report.saved ?? 0),
      'the measured part is never larger than the whole',
    );
    // The control load above put the original's size on file, so this saving is
    // arithmetic on two observed numbers rather than a model.
    check(
      (report.savedMeasured ?? 0) > 0,
      `the saving is measured, not modelled (${report.savedMeasured ?? 0} of ${report.saved ?? 0} B)`,
    );
    check(
      (report.deltas ?? []).length === 0,
      'no page-load comparison is claimed without samples on both sides',
    );

    /*
     * The Advanced feature rows at a phone width. The meters are the reason: they are
     * the only part of the UI that communicates a quantity visually, so a row narrow
     * enough to drop a segment or push the High/Medium/Low label off the side would be
     * saying something different from what it says on a desktop.
     *
     * The three-column card grid this used to measure is gone — the features are rows
     * in a group now, like every other control on the page — so the column count is no
     * longer a thing to assert. What replaced it is the switch: a row whose control has
     * been pushed off the screen is a feature that cannot be switched off.
     */
    await settings.setViewportSize({ width: 390, height: 900 });
    await settings.reload();
    await openSection('saver');
    await settings.waitForSelector('#optimize-toggle:checked', { timeout: 10_000 });
    await settings.evaluate(() => {
      const node = document.querySelector('#saver-advanced');
      if (node) node.open = true;
    });
    // Fonts, then a layout flush. Opening a `<details>` is synchronous, so what the
    // sleep here was covering was font metrics, and that is a condition rather than a
    // duration.
    await settle(settings);
    const narrowAdvanced = await settings.evaluate(() => {
      const doc = document.documentElement;
      const onScreen = (node) => node.getBoundingClientRect().right <= doc.clientWidth + 1;
      return {
        scrollW: doc.scrollWidth,
        clientW: doc.clientWidth,
        switchesOnScreen: [...document.querySelectorAll('#feature-groups .switch-track')].every(
          onScreen,
        ),
        switches: document.querySelectorAll('#feature-groups .switch-track').length,
        // Only the rows that actually carry a meter: three of the eight features have a
        // measured impact figure, and dereferencing a missing `.impact-meter` throws
        // inside `evaluate` — which aborts the whole run rather than failing one check.
        meters: [...document.querySelectorAll('#feature-groups .row')]
          .filter((option) => option.querySelector('.impact-meter'))
          .map((option) => ({
            label: option.querySelector('.impact-label')?.textContent ?? '',
            filled: option.querySelectorAll('[data-filled="true"]').length,
            onScreen: onScreen(option.querySelector('.impact-meter')),
          })),
      };
    });
    console.log('  narrow advanced:', JSON.stringify(narrowAdvanced));
    check(
      narrowAdvanced.scrollW <= narrowAdvanced.clientW,
      `Advanced does not scroll sideways at 390px (${narrowAdvanced.scrollW} of ${narrowAdvanced.clientW})`,
    );
    check(
      narrowAdvanced.switches === 8 && narrowAdvanced.switchesOnScreen,
      `all ${narrowAdvanced.switches} feature switches stay on screen at 390px`,
    );
    // Asserted as a property rather than as a fixed list, for the same reason as the
    // impact check earlier in this run: the features are rendered by iterating FEATURES
    // and grouped by visibility, so the order follows the grouping and the count follows
    // how many features carry an impact figure. Pinning either makes this fail the next
    // time a feature is added, which is a red line for something that is not a defect.
    // What has to hold at 390px is that every meter still agrees with its label and that
    // none of them has been pushed off the side of the screen.
    const FILL_AT_WIDTH = { High: 3, Medium: 2, Low: 1 };
    check(
      narrowAdvanced.meters.length > 0 &&
        narrowAdvanced.meters.every(
          (entry) => FILL_AT_WIDTH[entry.label] === entry.filled && entry.onScreen,
        ),
      `the impact meters survive a phone width (${JSON.stringify(narrowAdvanced.meters)})`,
    );

    if (process.argv.includes('--shots')) {
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await settings.evaluate(() => window.scrollTo(0, 0));
      await settings.screenshot({
        path: path.join(root, 'outputs', 'settings-narrow-advanced.png'),
        fullPage: true,
      });
      console.log('  wrote outputs/settings-narrow-advanced.png');
    }

    await settings.setViewportSize({ width: 1280, height: 1100 });

    if (process.argv.includes('--shots')) {
      // Capture the control surface with Advanced open so its visual impact cues
      // are inspected rather than hidden behind the default disclosure state.
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await settings.reload();
      await settings.setViewportSize({ width: 1280, height: 1100 });
      await openSection('saver');
      await settings.waitForSelector('#optimize-toggle:checked', { timeout: 10_000 });
      await settings.click('#saver-advanced > summary');
      // The eight per-feature switches are inside Advanced now, under the three-way
      // level picker that sets them in one go — so this shot is of the state a person
      // has to ask for, not the one the page opens on.
      await settings.waitForSelector('#feature-groups .impact-label', { state: 'visible', timeout: 5000 });
      await settings.evaluate(() => window.scrollTo(0, 0));
      await settle(settings);
      await settings.screenshot({
        path: path.join(root, 'outputs', 'settings-optimize.png'),
        fullPage: true,
      });
      console.log('  wrote outputs/settings-optimize.png');
    }

    const off = await ask({ type: 'SAVE_OPTIMIZE', changes: { enabled: false } });
    check(off.rules === 0, `switching the optimizer off removes every rule (${off.rules})`);
    const afterOff = await heldRules();
    check(
      afterOff.length === 0,
      `and Chrome is holding none, so nothing is left rewriting requests (${describeRules(
        afterOff,
      )})`,
    );

    /*
     * The exemption is permanent, and this is the reading that proves it.
     *
     * `publishRules` reinstalls the whole set on every change, and by this point in the
     * run limits and optimizer rules have each been installed and torn down several
     * times. A guard that was being dropped by one of those publishes would leave the
     * subscription check refusable by the next limit anyone set — silently, because the
     * gate fails open and would simply keep serving a staler and staler answer.
     */
    const guardAtEnd = (await sessionRules()).filter(isGuardRule);
    check(
      guardAtEnd.length === GUARD_RULE_COUNT,
      `the subscription exemption survived every install and teardown (${describeRules(
        guardAtEnd,
      )})`,
    );

    if (process.argv.includes('--shots')) {
      /*
       * The free tier, photographed last and deliberately.
       *
       * Every other capture in this run is taken with Plus unlocked, because the run
       * unlocks it early so the paid controls can be driven. That makes the locked
       * state exactly what `NEXT_AI_HANDOFF.md` rule 20 warns about: the state every
       * new install is in, and the one no screenshot has ever shown. These two are it.
       *
       * The tier is put back at the end, so nothing after this point inherits a
       * half-locked page.
       */
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await setPlus(false);
      await settings.setViewportSize({ width: 1280, height: 1100 });
      await settings.reload();
      // `attached`, not the default `visible`: every pane but the current one is
      // `hidden`, and `#plus` is not the one this page opens on.
      await settings.waitForSelector('#pane-plus', { state: 'attached', timeout: 10_000 });

      await openSection('plus');
      await settle(settings);
      await settings.screenshot({
        path: path.join(root, 'outputs', 'settings-plus.png'),
        fullPage: true,
      });

      await openSection('saver');
      // The master switch has to be on for Advanced to be reachable at all; the run
      // left it off after the optimizer teardown above.
      if (!(await settings.isChecked('#optimize-toggle'))) {
        await settings.click('#pane-saver .switch-control');
        await settings.waitForFunction(
          () => document.querySelector('#optimize-body')?.hasAttribute('hidden') === false,
        );
      }
      await settings.click('#saver-advanced > summary');
      await settle(settings);
      await settings.screenshot({
        path: path.join(root, 'outputs', 'settings-saver-locked.png'),
        fullPage: true,
      });
      console.log('  wrote outputs/settings-plus.png and settings-saver-locked.png');
      await setPlus(true);
    }

    const errors = await worker.evaluate(() => 'ok');
    check(errors === 'ok', 'the service worker is still alive and evaluable');

    if (process.argv.includes('--shots')) {
      const shots = path.join(root, 'outputs');
      await mkdir(shots, { recursive: true });
      await dashboard.reload();
      await dashboard.waitForSelector('#stats .stat', { timeout: 10_000 });
      const closeDetail = await dashboard.$('#detail-panel:not([hidden]) #detail-close');
      if (closeDetail) await closeDetail.click();
      await dashboard.evaluate(() => window.scrollTo(0, 0));
      await dashboard.setViewportSize({ width: 1280, height: 1100 });
      await settle(dashboard);
      await dashboard.screenshot({ path: path.join(shots, 'dashboard.png'), fullPage: true });

      await settings.reload();
      await settings.setViewportSize({ width: 1280, height: 1100 });
      // The section the page opens on, which is the one a first-time reader lands in.
      await openSection('plan');
      await settings.evaluate(() => window.scrollTo(0, 0));
      await settle(settings);
      await settings.screenshot({ path: path.join(shots, 'settings.png'), fullPage: true });

      // The popup is a normal extension page; opening it directly at its real
      // width is how it is photographed without driving the toolbar.
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 420, height: 720 });
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.waitForSelector('.site-row', { timeout: 10_000 });
      await settle(popup);
      await popup.screenshot({ path: path.join(shots, 'popup.png'), fullPage: true });
      console.log('  wrote outputs/dashboard.png, settings.png and popup.png');
    }

    if (process.argv.includes('--store-assets')) {
      const assets = path.join(root, 'store-assets');
      await mkdir(assets, { recursive: true });

      const capture = async (target, name, width = 1280, height = 800) => {
        await target.setViewportSize({ width, height });
        await target.evaluate(() => {
          window.scrollTo(0, 0);
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        });
        await settle(target);
        const bytes = await target.screenshot({ path: path.join(assets, name) });
        const actualWidth = bytes.readUInt32BE(16);
        const actualHeight = bytes.readUInt32BE(20);
        if (actualWidth !== width || actualHeight !== height) {
          throw new Error(
            `${name} is ${actualWidth}x${actualHeight}, expected ${width}x${height}`,
          );
        }
      };

      // The browser suite necessarily records traffic against its local fixture. Store
      // screenshots use representative sample labels so the listing reads as a product,
      // not as a test transcript. Only rendered text is changed; the interface, layout,
      // charts and figures are the extension's real output.
      const replaceFixtureHosts = (target) =>
        target.evaluate(() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            node.textContent = (node.textContent ?? '')
              .replaceAll('127.0.0.1', 'youtube.com')
              .replaceAll('localhost', 'wikipedia.org');
          }
        });

      await setPlus(true);
      // Navigate without the site-detail hash. Closing an existing detail view calls
      // history.back(), whose later scroll restoration can race a screenshot.
      await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html`);
      await dashboard.waitForSelector('#stats .stat', { timeout: 10_000 });
      await replaceFixtureHosts(dashboard);
      await capture(dashboard, '01-dashboard.png');

      await settings.reload();
      await settings.waitForSelector('#pane-saver', { state: 'attached', timeout: 10_000 });
      await openSection('saver');
      if (!(await settings.isChecked('#optimize-toggle'))) {
        await settings.click('#pane-saver .switch-control');
        await settings.waitForFunction(
          () => document.querySelector('#optimize-body')?.hasAttribute('hidden') === false,
        );
      }
      await capture(settings, '02-data-saver.png');

      await ask({
        type: 'PUT_BUDGET',
        site: 'youtube.com',
        bytes: 5_000_000_000,
        period: 'month',
        shape: 'progressive',
      });
      await settings.reload();
      await settings.waitForSelector('#pane-limits', { state: 'attached', timeout: 10_000 });
      await openSection('limits');
      await settings.waitForFunction(() => document.body.textContent?.includes('youtube.com'));
      await capture(settings, '03-site-limits.png');

      await setPlus(false);
      await settings.reload();
      await settings.waitForSelector('#pane-plus', { state: 'attached', timeout: 10_000 });
      await openSection('plus');
      await capture(settings, '04-plus.png');

      const welcome = await context.newPage();
      await welcome.goto(`chrome-extension://${extensionId}/welcome.html`);
      await welcome.waitForSelector('#pin-panel', { timeout: 10_000 });
      await capture(welcome, '05-welcome.png');
      await welcome.close();

      const promo = await context.newPage();
      const icon = (await readFile(path.join(root, 'public', 'icon.png'))).toString('base64');
      await promo.setContent(`<!doctype html>
        <html><head><meta charset="utf-8"><style>
          * { box-sizing: border-box; }
          html, body { margin: 0; width: 440px; height: 280px; overflow: hidden; }
          body {
            display: grid;
            grid-template-columns: 118px 1fr;
            align-items: center;
            gap: 28px;
            padding: 42px;
            color: #f7fffd;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
            background:
              radial-gradient(circle at 15% 15%, rgba(98,214,196,.28), transparent 38%),
              linear-gradient(135deg, #073d3a 0%, #0b625c 56%, #0c7770 100%);
          }
          img { width: 118px; height: 118px; filter: drop-shadow(0 12px 24px rgba(0,0,0,.22)); }
          .eyebrow { margin: 0 0 8px; color: #90e9dc; font-size: 13px; font-weight: 750; letter-spacing: .14em; text-transform: uppercase; }
          h1 { margin: 0; font-size: 37px; line-height: 1; letter-spacing: -.035em; }
          p { margin: 14px 0 0; max-width: 205px; color: #d7f3ee; font-size: 17px; line-height: 1.35; }
        </style></head><body>
          <img src="data:image/png;base64,${icon}" alt="">
          <div><div class="eyebrow">Chrome data, clear</div><h1>Byte Budget</h1><p>Know where your data goes.</p></div>
        </body></html>`);
      await capture(promo, 'promo-440x280.png', 440, 280);
      await promo.close();

      await setPlus(true);
      console.log('  wrote 6 verified Chrome Web Store assets to store-assets/');
    }
  } finally {
    if (logs.length > 0) {
      console.log('\nconsole output:');
      for (const line of logs.slice(-40)) console.log(`  ${line}`);
    }
    await context.close();
    server.close();
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} check(s) failed:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

/** Reads "1.2 MB" back into bytes, in whichever unit system the UI used. */
function parseBytes(text) {
  const match = /([\d.]+)\s*(B|kB|MB|GB|KiB|MiB|GiB)/.exec(text);
  if (!match) return 0;
  const factors = {
    B: 1,
    kB: 1000,
    MB: 1e6,
    GB: 1e9,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
  };
  return Number(match[1]) * (factors[match[2]] ?? 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

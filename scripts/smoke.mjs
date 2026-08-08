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
 * Playwright is expected to be installed out of tree (`npm i --no-save playwright`)
 * so it stays out of the extension's dependencies.
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

function fixture(size, byte = 0x41) {
  return Buffer.alloc(size, byte);
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
    await page.waitForSelector('#period-tabs button', { timeout: 10_000 });
    check(true, 'its popup renders from the root manifest');

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
  } catch {
    console.log('note  the "chromium" channel is unavailable; running headed');
    return await chromium.launchPersistentContext('', { headless: false, args });
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
    await settings.waitForSelector('#optimize-toggle', { timeout: 10_000 });
    await settings.waitForSelector('.impact-label', { state: 'attached', timeout: 10_000 });

    const optionsPage = await dashboard.evaluate(
      () => chrome.runtime.getManifest().options_page ?? '',
    );
    check(optionsPage === 'settings.html', `the Options page is separate (${optionsPage})`);
    check(
      (await dashboard.$('#optimize-toggle')) === null && (await dashboard.$('#limits-table')) === null,
      'the dashboard contains reporting, not settings controls',
    );
    check(
      (await settings.$('#stats')) === null && (await settings.$('#site-list')) === null,
      'the Settings page contains controls, not dashboard reporting',
    );
    const impacts = await settings.$$eval('.impact-meter', (nodes) =>
      nodes.map((node) => ({
        label: node.querySelector('.impact-label')?.textContent ?? '',
        filled: node.querySelectorAll('[data-filled="true"]').length,
      })),
    );
    check(
      JSON.stringify(impacts) ===
        JSON.stringify([
          { label: 'High', filled: 3 },
          { label: 'Medium', filled: 2 },
          { label: 'Low', filled: 1 },
        ]),
      `Advanced shows honest relative impact (${JSON.stringify(impacts)})`,
    );

    // Exercise the extracted controller through visible controls, not direct messages.
    if (await settings.isChecked('#optimize-toggle')) {
      await settings.click('.setting-hero .switch-control');
      await settings.waitForFunction(
        () => document.querySelector('#optimize-body')?.hasAttribute('hidden') === true,
      );
    }
    await settings.click('.setting-hero .switch-control');
    await settings.waitForFunction(
      () => document.querySelector('#optimize-body')?.hasAttribute('hidden') === false,
    );
    check(await settings.isChecked('#optimize-toggle'), 'the Settings Data Saver switch works');
    await settings.click('.setting-hero .switch-control');
    await settings.waitForFunction(
      () => document.querySelector('#optimize-body')?.hasAttribute('hidden') === true,
    );

    await settings.click('[data-theme-value="dark"]');
    await settings.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'dark',
    );
    check(true, 'the Settings appearance control works');
    await settings.click('[data-theme-value="auto"]');
    await settings.waitForFunction(
      () => document.querySelector('[data-theme-value="auto"]')?.getAttribute('aria-checked') === 'true',
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
    await page.waitForTimeout(3000);
    await dashboard.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, () => resolve(true)),
        ),
    );

    await page.goto(`${origin}/?measured`, { waitUntil: 'load' });
    await page.evaluate(
      (url) => fetch(url, { cache: 'no-store' }).then((response) => response.arrayBuffer()),
      `${origin}/streamed`,
    );

    // Long enough for the content script's batch, the parked-request TTL, and the
    // ledger flush behind both.
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

    const measured = await dashboard.$$eval('.stat', (nodes) =>
      nodes.map((node) => ({
        label: node.querySelector('.stat-label')?.textContent ?? '',
        value: node.querySelector('.stat-value')?.textContent ?? '',
      })),
    );
    console.log('  stats:', JSON.stringify(measured));
    const share = measured.find((stat) => stat.label === 'Accuracy');
    const percent = Number((share?.value ?? '0').replace(/[^\d]/g, ''));
    check(percent >= 60, `measured share is ${share?.value ?? 'missing'}, expected 60% or better`);

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
    // Long enough for the body to arrive and `onCompleted` to fire, so the request is
    // parked rather than cancelled by the navigation.
    await page.waitForTimeout(1500);
    await page.goto(`${origin}/plain`, { waitUntil: 'load' });
    // The eight-second wait, the queue's sweep behind it, and the flush behind that.
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
      await dashboard.waitForTimeout(300);
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

    const applied = await ask({ type: 'SET_ENFORCEMENT', site: '127.0.0.1', tier: 'lean' });
    check(
      applied.ok === true && applied.rules >= 1,
      `enforcement installed ${applied.rules ?? 0} rule(s) for the site`,
    );
    check(
      applied.enforcement?.[0]?.tier === 'lean',
      `the site is recorded as limited (${JSON.stringify(applied.enforcement)})`,
    );

    resetHits();
    await page.goto(`${origin}/?limited`, { waitUntil: 'load' });
    await page.waitForTimeout(8000);

    // The server's own record. `lean` refuses media, images and fonts, so the
    // document and the script must still arrive and the image must not.
    console.log('  server hits while limited:', JSON.stringify(hits));
    check(
      !hits.includes('/fixture.png'),
      `the server was never asked for the image (hits: ${hits.join(' ')})`,
    );
    check(
      hits.includes('/fixture.js'),
      'the script was still allowed through, so the block is selective',
    );

    const limited = await ask({ type: 'GET_OVERVIEW', period: 'today' });
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
    resetHits();
    await page.goto(`${origin}/?unlimited`, { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    check(hits.includes('/fixture.png'), 'the image loads again once the limit is lifted');

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
    await page.waitForTimeout(6000);

    const crossed = await ask({ type: 'GET_BUDGETS' });
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
    await page.waitForTimeout(4000);
    console.log('  server hits over budget:', JSON.stringify(hits));
    check(
      !hits.includes('/fixture.png'),
      `the over-budget load never asked for the image (hits: ${hits.join(' ')})`,
    );

    // And the page has to say so, or a limit is indistinguishable from a bug.
    const banner = await page.evaluate(() => {
      const host = document.getElementById('byte-budget-notice');
      return host ? { present: true, tag: host.tagName } : { present: false };
    });
    check(banner.present === true, `the page shows a notice (${JSON.stringify(banner)})`);

    /* ---------------------------------------------------------------- *
     * Settings at a phone width
     *
     * Checked rather than eyeballed, because the failure is invisible on a desktop
     * and severe on a phone. A grid item's automatic minimum size is its min-content
     * size, and the six-column limits table gave `#limits-panel` a min-content width
     * of 760px — so at 390px the whole document was 772px wide, the page scrolled
     * sideways, and Pause and Remove sat off screen. This is the only viewport where
     * that shows up, and a limit has to exist for the table to have anything in it,
     * which is why the check lives here rather than with the other Settings checks.
     * ---------------------------------------------------------------- */

    await settings.setViewportSize({ width: 390, height: 900 });
    await settings.reload();
    await settings.waitForSelector('#limits-table tbody tr', { timeout: 10_000 });
    await settings.waitForTimeout(300);
    const narrow = await settings.evaluate(() => {
      const doc = document.documentElement;
      const label = (cell) => getComputedStyle(cell, '::before').content;
      return {
        scrollW: doc.scrollWidth,
        clientW: doc.clientWidth,
        // Every row action has to be reachable without a sideways scroll nobody is
        // told about.
        actionsOnScreen: [...document.querySelectorAll('.row-actions .ghost-button')].every(
          (node) => node.getBoundingClientRect().right <= doc.clientWidth + 1,
        ),
        actions: document.querySelectorAll('.row-actions .ghost-button').length,
        // The header row is gone at this width, so each figure has to name itself.
        labels: [...document.querySelectorAll('#limits-table tbody td[data-label]')].map(label),
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
      narrow.labels.length >= 4 && narrow.labels.every((value) => /\w/.test(value)),
      `the stacked limit card labels its figures (${JSON.stringify(narrow.labels)})`,
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
      await settings.waitForSelector('#limits-table tbody tr', { timeout: 10_000 });
      await settings.evaluate(() => window.scrollTo(0, 0));
      await settings.waitForTimeout(400);
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
    await page.waitForTimeout(700);
    const stillThere = await page.evaluate(() =>
      Boolean(document.getElementById('byte-budget-notice')),
    );
    check(stillThere === false, 'the notice is withdrawn when the limit is lifted');

    resetHits();
    await page.goto(`${origin}/?granted`, { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    check(hits.includes('/fixture.png'), 'the image loads again after the grant');

    const removed = await ask({ type: 'REMOVE_BUDGET', site: '127.0.0.1' });
    check(
      (removed.statuses ?? []).length === 0,
      `removing the budget leaves nothing behind (${JSON.stringify(removed.statuses)})`,
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
    const regexSupport = await dashboard.evaluate(async (patterns) => {
      const results = [];
      for (const [id, regex] of patterns) {
        const outcome = await chrome.declarativeNetRequest.isRegexSupported({ regex });
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
    await page.waitForTimeout(3500);
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

    const baselined = await ask({ type: 'GET_SAVINGS', days: 30 });
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
    await page.waitForTimeout(6000);

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
     */
    const pageState = await page.evaluate(() => ({
      belowLoading: document.getElementById('below')?.getAttribute('loading') ?? null,
      prefetchLinks: document.querySelectorAll('link[rel~="prefetch"]').length,
    }));
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

    const report = await ask({ type: 'GET_SAVINGS', days: 30 });
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
     * The Advanced impact cards at a phone width, which is the one place their
     * three-column grid has to give way. The meters are the reason: they are the
     * only part of the UI that communicates a quantity visually, so a card narrow
     * enough to drop a segment or wrap the High/Medium/Low label would be saying
     * something different from what it says on a desktop.
     */
    await settings.setViewportSize({ width: 390, height: 900 });
    await settings.reload();
    await settings.waitForSelector('#optimize-toggle:checked', { timeout: 10_000 });
    await settings.evaluate(() => {
      const node = document.querySelector('.advanced-settings');
      if (node) node.open = true;
    });
    await settings.waitForTimeout(300);
    const narrowAdvanced = await settings.evaluate(() => {
      const doc = document.documentElement;
      const grid = document.querySelector('.advanced-options');
      return {
        scrollW: doc.scrollWidth,
        clientW: doc.clientWidth,
        columns: getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length,
        meters: [...document.querySelectorAll('.advanced-option')].map((option) => ({
          label: option.querySelector('.impact-label')?.textContent ?? '',
          filled: option.querySelectorAll('[data-filled="true"]').length,
          onScreen:
            option.querySelector('.impact-meter').getBoundingClientRect().right <=
            doc.clientWidth + 1,
        })),
      };
    });
    console.log('  narrow advanced:', JSON.stringify(narrowAdvanced));
    check(
      narrowAdvanced.scrollW <= narrowAdvanced.clientW,
      `Advanced does not scroll sideways at 390px (${narrowAdvanced.scrollW} of ${narrowAdvanced.clientW})`,
    );
    check(
      narrowAdvanced.columns === 1,
      `the impact cards stack to one column at 390px (${narrowAdvanced.columns})`,
    );
    check(
      JSON.stringify(narrowAdvanced.meters) ===
        JSON.stringify([
          { label: 'High', filled: 3, onScreen: true },
          { label: 'Medium', filled: 2, onScreen: true },
          { label: 'Low', filled: 1, onScreen: true },
        ]),
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
      await settings.waitForSelector('#optimize-toggle:checked', { timeout: 10_000 });
      await settings.click('.advanced-settings > summary');
      await settings.waitForSelector('.advanced-settings[open] .impact-label', { timeout: 5000 });
      await settings.evaluate(() => window.scrollTo(0, 0));
      await settings.waitForTimeout(400);
      await settings.screenshot({
        path: path.join(root, 'outputs', 'settings-optimize.png'),
        fullPage: true,
      });
      console.log('  wrote outputs/settings-optimize.png');
    }

    const off = await ask({ type: 'SAVE_OPTIMIZE', changes: { enabled: false } });
    check(off.rules === 0, `switching the optimizer off removes every rule (${off.rules})`);

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
      await dashboard.waitForTimeout(400);
      await dashboard.screenshot({ path: path.join(shots, 'dashboard.png'), fullPage: true });

      await settings.reload();
      await settings.setViewportSize({ width: 1280, height: 1100 });
      await settings.waitForSelector('#limits-panel', { timeout: 10_000 });
      await settings.evaluate(() => window.scrollTo(0, 0));
      await settings.waitForTimeout(400);
      await settings.screenshot({ path: path.join(shots, 'settings.png'), fullPage: true });

      // The popup is a normal extension page; opening it directly at its real
      // width is how it is photographed without driving the toolbar.
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 420, height: 720 });
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.waitForSelector('.site-row', { timeout: 10_000 });
      await popup.waitForTimeout(400);
      await popup.screenshot({ path: path.join(shots, 'popup.png'), fullPage: true });
      console.log('  wrote outputs/dashboard.png, settings.png and popup.png');
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

/**
 * Package a built channel for the Chrome Web Store.
 *
 *   node scripts/package.mjs              zip dist/          -> artifacts/byte-budget-<version>.zip
 *   node scripts/package.mjs --throttle   zip dist-throttle/ -> artifacts/byte-budget-throttle-<version>.zip
 *
 * Run after the matching `vite build`; `npm run zip` / `npm run zip:throttle`
 * chain both steps so the archive can only ever contain what was just built.
 *
 * `dist/` is the one you load in Chrome. `dist-throttle/` is the channel that
 * declares the `debugger` permission so it can cap a tab's throughput for real
 * (see PLAN.md §1.4); it exists to be packaged separately, because `debugger`
 * cannot be an optional permission and should not be forced on everyone.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip, verifyZip } from './zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const throttle = process.argv.slice(2).includes('--throttle');
const source = path.join(root, throttle ? 'dist-throttle' : 'dist');
const artifacts = path.join(root, 'artifacts');

/**
 * Strings that must never reach an upload.
 *
 * Checked generically rather than field by field so a future support URL, OAuth id or
 * other fill-me-in value cannot quietly reach the Store. `.example` is a reserved TLD
 * that can never resolve, so anything under it is a placeholder by definition.
 */
const PLACEHOLDER_PATTERNS = [/REPLACE[-_ ]?ME/i, /\.example(?![a-z0-9-])/i];

/**
 * Code that must not exist in the store channel's bundles.
 *
 * README says the store build "compiles the throttle code out entirely rather than
 * shipping a branch that can never be taken", and until now the only thing behind
 * that claim was the manifest's `permissions` array — which says what the extension
 * asked for, not what the file contains. A `debugger` call in a build that cannot
 * hold the permission is dead weight at best and a review question at worst, and
 * the tree-shake that removes it depends on `__THROTTLE_BUILD__` folding to a
 * literal `false`, which is a property of the bundler's mood on any given upgrade.
 */
const THROTTLE_MARKERS = ['chrome.debugger', 'emulateNetworkConditions'];

/** Files a loadable extension cannot be missing. */
const REQUIRED = [
  'manifest.json',
  'popup.html',
  'popup.js',
  'dashboard.html',
  'dashboard.js',
  'settings.html',
  'settings.js',
  'background.js',
];

/** Every file under `dir`, as forward-slash paths relative to it. */
async function collect(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await collect(path.join(dir, entry.name), name)));
    else files.push({ name, data: await readFile(path.join(dir, entry.name)) });
  }
  return files;
}

/**
 * Cross-check the manifest against what was actually built.
 *
 * Vite writes the manifest from `public/`, and a plugin patches it per channel.
 * That is two places a path can go stale, so every local file the manifest names
 * is resolved here. A missing content script is a silently broken feature, not a
 * build error, which is the worst kind.
 */
function verifyManifestReferences(manifest, present) {
  const referenced = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      if (/\.(js|html|css|png|svg|json)$/.test(value) && !/^https?:/.test(value)) {
        referenced.add(value.replace(/^\.?\//, ''));
      }
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(manifest);

  const missing = [...referenced].filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`manifest names files that are not in the build: ${missing.join(', ')}`);
  }
}

/**
 * Refuse to package a manifest that still carries a fill-me-in value.
 *
 * Reports the field path because a bare "REPLACE-ME is still in the manifest" sends
 * the reader looking. Every string is walked so the next placeholder is caught too.
 */
function verifyNoPlaceholders(manifest) {
  const found = [];
  const walk = (value, path) => {
    if (typeof value === 'string') {
      if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))) {
        found.push(`${path} = ${value}`);
      }
    } else if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
    else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) walk(entry, path ? `${path}.${key}` : key);
    }
  };
  walk(manifest, '');

  if (found.length > 0) {
    throw new Error(
      `the manifest still carries placeholder values, fill them in before submitting:\n  ${found.join('\n  ')}`,
    );
  }
}

/**
 * Prove the channel split in the bundles, not just in the manifest.
 *
 * Both directions are asserted, because both failures are silent. A store build
 * that still contains the throttle code has shipped code it cannot run; a throttle
 * build that does not contain it is an extension that asks for the `debugger`
 * permission and then never throttles anything — and its manifest looks perfect.
 *
 * Every `.js` in the build is searched, not just `background.js`: a rollup chunking
 * change could move the code into `assets/` without changing anything the manifest
 * says.
 */
function verifyThrottleCode(files, expected) {
  const scripts = files.filter((file) => file.name.endsWith('.js'));
  for (const marker of THROTTLE_MARKERS) {
    const hits = scripts
      .filter((file) => file.data.toString('utf8').includes(marker))
      .map((file) => file.name);

    if (!expected && hits.length > 0) {
      throw new Error(
        `the store channel must not ship throttle code, but ${hits.join(', ')} ` +
          `contains "${marker}"`,
      );
    }
    if (expected && hits.length === 0) {
      throw new Error(
        `the throttle channel declares the "debugger" permission but no bundle ` +
          `contains "${marker}"`,
      );
    }
  }
}

async function main() {
  let files;
  try {
    files = await collect(source);
  } catch {
    throw new Error(
      `${path.relative(root, source)}/ does not exist. Run ` +
        `\`npm run ${throttle ? 'build:throttle' : 'build'}\` first.`,
    );
  }

  // Source maps are produced for both channels but shipped with only one. The store
  // channel builds them `hidden` (vite.config.ts), so nothing in the bundle points at
  // them and they would travel to the Web Store as unreferenced source; they stay in
  // `dist/` instead, where they are what turns a stack trace in a bug report back
  // into line numbers. The throttle channel links its maps, so it ships them — a
  // linked map that is missing from the archive is a DevTools error on every page.
  if (!throttle) files = files.filter((file) => !file.name.endsWith('.map'));

  const present = new Set(files.map((file) => file.name));
  const missing = REQUIRED.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`${path.relative(root, source)}/ is missing: ${missing.join(', ')}`);
  }

  const manifest = JSON.parse(
    files.find((file) => file.name === 'manifest.json').data.toString('utf8'),
  );
  verifyManifestReferences(manifest, present);
  verifyNoPlaceholders(manifest);

  // The channels differ by exactly one permission. Getting that backwards would
  // publish a store build that asks to debug the browser, or a throttle build
  // that cannot throttle.
  const declaresDebugger = (manifest.permissions ?? []).includes('debugger');
  if (declaresDebugger !== throttle) {
    throw new Error(
      throttle
        ? 'the throttle channel must declare the "debugger" permission'
        : 'the store channel must not declare the "debugger" permission',
    );
  }
  verifyThrottleCode(files, throttle);

  // The manifest's version is written by the `manifest-channel` plugin from
  // `package.json`, so this is no longer two sources disagreeing — it is the check
  // that this archive came from a build of this version. `npm run zip` chains the
  // build, but `node scripts/package.mjs` on its own does not, and packaging a
  // `dist/` from before a version bump produces an artifact named for a release it
  // does not contain.
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    throw new Error(
      `dist/manifest.json is ${manifest.version} but package.json is ${pkg.version}; ` +
        `rebuild before packaging`,
    );
  }

  await mkdir(artifacts, { recursive: true });
  const name = `byte-budget${throttle ? '-throttle' : ''}-${manifest.version}.zip`;
  const archivePath = path.join(artifacts, name);
  const bytes = createZip(files);
  await writeFile(archivePath, bytes);

  const entries = verifyZip(bytes);
  if (entries.length !== files.length) {
    throw new Error(`zip verification found ${entries.length} of ${files.length} entries`);
  }

  console.log(
    `wrote artifacts/${name}  "${manifest.name}"  ` +
      `(${entries.length} files, ${(bytes.length / 1024).toFixed(1)} kB, verified)`,
  );
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});

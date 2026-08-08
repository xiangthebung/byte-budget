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

  const present = new Set(files.map((file) => file.name));
  const missing = REQUIRED.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`${path.relative(root, source)}/ is missing: ${missing.join(', ')}`);
  }

  const manifest = JSON.parse(
    files.find((file) => file.name === 'manifest.json').data.toString('utf8'),
  );
  verifyManifestReferences(manifest, present);

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

  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    throw new Error(`manifest is ${manifest.version} but package.json is ${pkg.version}`);
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

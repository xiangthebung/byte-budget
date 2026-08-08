import { defineConfig } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * Entries whose output is loaded as a *classic* script by Chrome, not a module.
 *
 * Content scripts registered in the manifest cannot be ES modules, so their
 * bundles must not contain a single `import`. Rollup will happily split shared
 * code into a chunk and import it, which produces a file that loads fine in the
 * popup and silently does nothing on a page. The rule is that a content script
 * imports nothing from `src/`, and `assert-classic-scripts` below enforces it
 * rather than trusting it.
 */
const CLASSIC_SCRIPTS = ["timing.js", "notice.js", "optimize.js"];

/** Anything in the manifest that names a file shipped alongside it. */
const LOCAL_FILE = /\.(js|html|css|png|svg|json)$/;

/**
 * Rewrites every local path in a manifest so it resolves from one directory up.
 *
 * Manifest paths are relative to the manifest, so prefixing them with `dist/` gives
 * a manifest that works from the project root. Deliberately generic rather than a
 * list of fields: a path added to the manifest later would otherwise be missed, and
 * the failure — one content script silently absent — is invisible.
 *
 * Strings that are not file paths are left alone, which is what the extension check
 * is for: match patterns and the content security policy must not be touched.
 */
function prefixPaths(value: unknown, prefix: string): unknown {
  if (typeof value === "string") {
    return LOCAL_FILE.test(value) && !/^(https?:|\/)/.test(value)
      ? `${prefix}/${value.replace(/^\.\//, "")}`
      : value;
  }
  if (Array.isArray(value)) return value.map((entry) => prefixPaths(entry, prefix));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, prefixPaths(entry, prefix)]),
    );
  }
  return value;
}

/**
 * Writes a manifest at the project root that points into `dist/`.
 *
 * Purely a convenience, and it exists because of how this workspace is used: the
 * plain-JavaScript extensions here (Decaf, PagePack, 2FA Paster) *are* their own
 * source, so "Load unpacked" on the project folder just works. A TypeScript build
 * cannot do that, and having to descend into `dist/` every time is friction that
 * lands on every reload.
 *
 * `dist/` is still the only thing that gets packaged and published. This file is
 * generated, gitignored, and never appears in an archive — the packaging script reads
 * `dist/` and nothing else, so the two cannot disagree about what shipped.
 */
function writeRootManifest(distManifest: unknown): void {
  const rooted = prefixPaths(distManifest, "dist") as Record<string, unknown>;
  writeFileSync(`${projectRoot}/manifest.json`, `${JSON.stringify(rooted, null, 2)}\n`);
}

/**
 * `--mode throttle` selects the channel that declares the `debugger` permission.
 *
 * Chrome does not allow `debugger` as an optional permission, and it is the only
 * API that can actually cap a tab's throughput (PLAN.md §1.4). Forcing that
 * install warning on everyone to serve the few people who want a kbps cap is the
 * wrong trade, so it ships as a second channel instead.
 *
 * `--mode` is a Vite flag rather than a `BUILD_CHANNEL=throttle` shell prefix,
 * because cmd.exe and PowerShell do not understand that syntax and the script
 * would fail before Vite started.
 */
export default defineConfig(({ mode }) => {
  const isThrottleBuild = mode === "throttle";
  const outputDirectory = `${projectRoot}/${isThrottleBuild ? "dist-throttle" : "dist"}`;

  return {
    root: `${projectRoot}/src`,
    publicDir: `${projectRoot}/public`,
    base: "./",
    define: {
      __THROTTLE_BUILD__: JSON.stringify(isThrottleBuild),
    },
    plugins: [
      {
        name: "manifest-channel",
        writeBundle() {
          const manifestPath = `${outputDirectory}/manifest.json`;
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
            name: string;
            description: string;
            permissions: string[];
          };
          if (isThrottleBuild) {
            manifest.name = "Byte Budget (throttle)";
            manifest.description =
              "Byte Budget with a real per-tab speed cap. Chrome shows a debugging banner while a cap is active.";
            if (!manifest.permissions.includes("debugger")) {
              manifest.permissions = [...manifest.permissions, "debugger"];
            }
          } else {
            manifest.permissions = manifest.permissions.filter(
              (permission) => permission !== "debugger",
            );
          }
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

          if (!isThrottleBuild) writeRootManifest(manifest);
        },
      },
      {
        name: "assert-classic-scripts",
        writeBundle(_options, bundle) {
          for (const [fileName, output] of Object.entries(bundle)) {
            if (!CLASSIC_SCRIPTS.includes(fileName)) continue;
            if (output.type !== "chunk") continue;
            if (output.imports.length > 0 || output.dynamicImports.length > 0) {
              throw new Error(
                `${fileName} is loaded as a classic content script but imports ` +
                  `${[...output.imports, ...output.dynamicImports].join(", ")}. ` +
                  `Inline what it needs instead.`,
              );
            }
          }
        },
      },
    ],
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
      target: "es2022",
      minify: "esbuild",
      /**
       * No `<link rel="modulepreload">` in the extension pages.
       *
       * Chrome refuses to use a preload issued from an extension page for a chunk
       * it then loads in the extension's own world — "cross-world extension
       * resource mismatch" — so every hint is a console warning that buys nothing.
       * There is no network here to warm up anyway; the chunks are local files.
       */
      modulePreload: false,
      rollupOptions: {
        input: {
          popup: `${projectRoot}/src/popup.html`,
          dashboard: `${projectRoot}/src/dashboard.html`,
          settings: `${projectRoot}/src/settings.html`,
          /*
           * The first-run screen, opened from `onInstalled`. An extension page like the
           * three above, not a content script, so it may import freely — `welcome.ts`
           * pulls in `core/messages`, `core/format` and the shared stylesheet, and the
           * `assert-classic-scripts` check deliberately does not cover it.
           *
           * Nothing else has to change for it: it is reached through
           * `chrome.runtime.getURL`, which needs no `web_accessible_resources` entry,
           * and it loads one module script and one stylesheet from the extension's own
           * origin, which `default-src 'self'` already allows. It carries no inline
           * script, no inline `style` attribute and no remote asset, so it stays inside
           * the tightened policy without an exception.
           */
          welcome: `${projectRoot}/src/welcome.html`,
          background: `${projectRoot}/src/background.ts`,
          timing: `${projectRoot}/src/content/timing.ts`,
          notice: `${projectRoot}/src/content/notice.ts`,
          optimize: `${projectRoot}/src/content/optimize.ts`,
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  };
});

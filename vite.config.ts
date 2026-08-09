import { defineConfig } from "vite";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * The extension's version, read from `package.json` — the one place it is written.
 *
 * `public/manifest.json` used to carry a second copy, and `scripts/package.mjs`
 * compared the two at `npm run zip`: after typecheck, tests, build and archive
 * assembly had all already run against a number that was wrong. The plugin below
 * stamps this one into every channel's manifest instead, so the two cannot
 * disagree and packaging is left checking only that `dist/` is current.
 *
 * Anything the source manifest still says about `version` is overwritten here and
 * means nothing; the field belongs only in `package.json`.
 */
const { version } = JSON.parse(
  readFileSync(`${projectRoot}/package.json`, "utf8"),
) as { version: string };

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
const CLASSIC_SCRIPTS = ["timing.js", "notice.js", "optimize.js", "subscription.js"];

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
 *
 * One thing here cannot be redirected into `dist/`: Chrome looks for `_locales` beside
 * the manifest and follows no path to it. The `merge-locales` plugin therefore writes a
 * second copy of the catalogue next to this file. It is generated the same way and
 * packaged the same way — never.
 */
function writeRootManifest(distManifest: unknown): void {
  const rooted = prefixPaths(distManifest, "dist") as Record<string, unknown>;
  writeFileSync(`${projectRoot}/manifest.json`, `${JSON.stringify(rooted, null, 2)}\n`);
}

/* ------------------------------------------------------------------ *
 * Message catalogues
 * ------------------------------------------------------------------ */

/**
 * The locale the catalogue is written in, and the only one that exists today.
 *
 * Chrome requires `default_locale` the moment a `_locales` directory is present and
 * refuses to load the extension if the two disagree, so this constant names the
 * directory that gets written *and* is checked against the built manifest below.
 * A build that produced `_locales/en/` under a manifest saying `en_GB` would be a
 * clean build and an extension that will not install.
 */
const DEFAULT_LOCALE = "en";

/**
 * Where the per-surface partials live, before they are merged.
 *
 * `_locales/en/messages.json` is generated and nobody edits it. Each surface writes
 * its own file here instead — `core.json`, `popup.json`, `dashboard.json`,
 * `settings.json`, `welcome.json` — because a single 300-entry catalogue is a merge
 * conflict every time two people add a string, and the conflict resolution is where
 * a string quietly loses its `description` or gets clobbered.
 *
 * Keys carry their surface as a prefix (`popupPlanRemaining`, `coreTierStrictLabel`)
 * so a collision means a genuine mistake rather than two surfaces naming the same
 * idea. The merge below does not trust that convention; it proves it.
 */
const LOCALE_PARTIALS = `${projectRoot}/i18n`;

/** Chrome's own rule for a message name. A `.` or a `-` makes the extension unloadable. */
const MESSAGE_NAME = /^[A-Za-z0-9_@]+$/;

/**
 * A named placeholder reference inside a message, as `$SPAN$`.
 *
 * Chrome also accepts bare `$1`-style positional substitution, which mostly cannot
 * match here because it has no closing `$` — but two of them adjacent can, so a
 * purely numeric name is skipped below rather than demanded as a declaration.
 */
const NAMED_PLACEHOLDER = /\$([A-Za-z0-9_]+)\$/g;

/** A `__MSG_key__` reference in a manifest field Chrome will localise. */
const MANIFEST_MESSAGE_REFERENCE = /__MSG_([A-Za-z0-9_@]+)__/g;

interface LocaleMessage {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
}

/**
 * Every `$NAME$` a message refers to, lowercased the way Chrome compares them.
 *
 * `$$` is Chrome's escape for a literal dollar sign and is removed first, so a
 * message that prints `$$5` is not read as opening a placeholder.
 */
function namedPlaceholdersIn(message: string): string[] {
  const found: string[] = [];
  for (const match of message.replace(/\$\$/g, "").matchAll(NAMED_PLACEHOLDER)) {
    const name = match[1];
    // `$1$` is positional substitution, not a named placeholder, and declares nothing.
    if (name !== undefined && !/^\d+$/.test(name)) found.push(name.toLowerCase());
  }
  return found;
}

/**
 * Checks one entry, and throws naming the file so the message can be found.
 *
 * `description` is required rather than encouraged. It is the entire context a
 * translator gets — they see the string and this sentence, never the call site — so a
 * message without one is a string that will come back translated for the wrong sense
 * of the word, and nothing in the build would have said so.
 */
function assertMessage(key: string, entry: LocaleMessage, file: string): void {
  if (!MESSAGE_NAME.test(key)) {
    throw new Error(
      `${file}: "${key}" is not a legal message name. Chrome allows [A-Za-z0-9_@] ` +
        `only, and rejects the whole extension at load if a name is outside it.`,
    );
  }
  if (typeof entry?.message !== "string" || entry.message === "") {
    throw new Error(`${file}: "${key}" has no "message".`);
  }
  if (typeof entry.description !== "string" || entry.description.trim() === "") {
    throw new Error(
      `${file}: "${key}" has no "description". It is what a translator reads ` +
        `instead of the source file, so it is required.`,
    );
  }
  const declared = new Set(
    Object.keys(entry.placeholders ?? {}).map((name) => name.toLowerCase()),
  );
  for (const name of namedPlaceholdersIn(entry.message)) {
    if (!declared.has(name)) {
      throw new Error(
        `${file}: "${key}" uses the placeholder $${name.toUpperCase()}$ but does not ` +
          `declare it. Chrome leaves an undeclared placeholder in the output verbatim.`,
      );
    }
  }
}

/**
 * Folds every partial into one catalogue, refusing to guess at a collision.
 *
 * A duplicate key is not merged and not warned about: whichever file the directory
 * listing reached second would win, so the string a surface renders would depend on
 * a filename. That is a bug whose symptom is one label reading as another label, on
 * one surface, and it is invisible in review — so it fails the build, naming both
 * files.
 *
 * Output is sorted by key so the generated file is stable across builds and a diff
 * of it shows what actually changed.
 */
function mergeLocalePartials(): Record<string, LocaleMessage> {
  const files = readdirSync(LOCALE_PARTIALS)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new Error(
      `${LOCALE_PARTIALS} holds no message partials, but the manifest declares ` +
        `"default_locale". Chrome will not load an extension whose catalogue is empty.`,
    );
  }

  const merged = new Map<string, LocaleMessage>();
  const declaredIn = new Map<string, string>();
  for (const name of files) {
    const file = `i18n/${name}`;
    const partial = JSON.parse(
      readFileSync(`${LOCALE_PARTIALS}/${name}`, "utf8"),
    ) as Record<string, LocaleMessage>;
    for (const [key, entry] of Object.entries(partial)) {
      const first = declaredIn.get(key);
      if (first !== undefined) {
        throw new Error(
          `duplicate message key "${key}": declared in ${first} and again in ${file}. ` +
            `Prefix it with the surface that owns it so the two cannot collide.`,
        );
      }
      assertMessage(key, entry, file);
      declaredIn.set(key, file);
      merged.set(key, entry);
    }
  }

  return Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Every `__MSG_key__` the manifest asks Chrome to substitute.
 *
 * Chrome refuses to load an extension whose manifest names a message the catalogue
 * does not hold, and the error it gives points at the manifest rather than at the
 * missing key. Cheaper to find here.
 */
function manifestMessageReferences(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(MANIFEST_MESSAGE_REFERENCE)) {
      if (match[1] !== undefined) found.add(match[1]);
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) manifestMessageReferences(entry, found);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) manifestMessageReferences(entry, found);
  }
  return found;
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
            version: string;
            description: string;
            permissions: string[];
          };
          manifest.version = version;

          // The copy in `public/manifest.json` is now inert — the line above wins —
          // which makes it a place to bump a number and watch nothing happen. A
          // warning rather than an error, because an ignored field breaks no build.
          const sourceManifest = JSON.parse(
            readFileSync(`${projectRoot}/public/manifest.json`, "utf8"),
          ) as Record<string, unknown>;
          if ("version" in sourceManifest) {
            this.warn(
              'public/manifest.json still declares "version". It is overwritten from ' +
                "package.json on every build; delete the field so there is one source.",
            );
          }

          if (isThrottleBuild) {
            // `__MSG_` references rather than literals, because these two strings are
            // read by a person in `chrome://extensions` exactly like the store
            // channel's are. Chrome substitutes them from `_locales` on load; the
            // English sits in `i18n/core.json` beside `extensionName`, and
            // `merge-locales` below fails the build if either key goes missing.
            manifest.name = "__MSG_extensionThrottleName__";
            manifest.description = "__MSG_extensionThrottleDescription__";
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
        /*
         * Runs after `manifest-channel` on purpose: it checks the manifest that
         * shipped, not the one in `public/`. The throttle channel replaces `name`
         * and `description` with its own `__MSG_` references a few lines above, and
         * a check against the source manifest would never see them.
         */
        name: "merge-locales",
        writeBundle() {
          const messages = mergeLocalePartials();
          const catalogue = `${JSON.stringify(messages, null, 2)}\n`;

          // Chrome resolves `_locales` relative to the manifest and nowhere else, so
          // the path is fixed: `<manifest dir>/_locales/<default_locale>/messages.json`.
          const localeDirectory = `${outputDirectory}/_locales/${DEFAULT_LOCALE}`;
          mkdirSync(localeDirectory, { recursive: true });
          writeFileSync(`${localeDirectory}/messages.json`, catalogue);

          const manifest = JSON.parse(
            readFileSync(`${outputDirectory}/manifest.json`, "utf8"),
          ) as Record<string, unknown>;

          if (manifest.default_locale !== DEFAULT_LOCALE) {
            throw new Error(
              `the build wrote _locales/${DEFAULT_LOCALE}/ but the manifest declares ` +
                `default_locale ${JSON.stringify(manifest.default_locale)}. Chrome ` +
                `refuses to load an extension where those disagree.`,
            );
          }

          const missing = [...manifestMessageReferences(manifest)].filter(
            (key) => !(key in messages),
          );
          if (missing.length > 0) {
            throw new Error(
              `the manifest references messages that no i18n/ partial declares: ` +
                `${missing.join(", ")}`,
            );
          }

          /*
           * The dev-load convenience needs its own copy, for the same reason the root
           * manifest exists at all — and it cannot point into `dist/` the way every
           * other path in that manifest does, because `_locales` is the one directory
           * Chrome will not follow a relative path to. Without this, loading the
           * project root gives an extension whose catalogue is empty: `t()` returns
           * its keys, and every label on every surface reads `coreTierStrictLabel`.
           *
           * Generated and never packaged, exactly like the root manifest beside it.
           */
          if (!isThrottleBuild) {
            const rootLocaleDirectory = `${projectRoot}/_locales/${DEFAULT_LOCALE}`;
            mkdirSync(rootLocaleDirectory, { recursive: true });
            writeFileSync(`${rootLocaleDirectory}/messages.json`, catalogue);
          }
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
       * Source maps, chosen per channel rather than omitted by default.
       *
       * Without them a bug report against `dist/background.js` is 50 kB of minified
       * service worker and a stack trace whose line numbers mean nothing, which is
       * the only diagnostic anyone will ever send for a worker that runs on their
       * machine and not on ours.
       *
       * The two channels differ because their audiences do. The store build gets
       * `"hidden"`: the maps are written, but no `sourceMappingURL` comment goes
       * into the bundle and `scripts/package.mjs` keeps `.map` files out of the
       * archive — so they exist here, for symbolicating a report, without publishing
       * the source to every install. The throttle build gets `true`: it is
       * sideloaded by people who deliberately chose a channel that holds the
       * `debugger` permission, it never goes to the store, and a linked map means
       * their report arrives with real file names in it.
       */
      sourcemap: isThrottleBuild ? true : "hidden",
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
          subscription: `${projectRoot}/src/content/subscription.ts`,
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

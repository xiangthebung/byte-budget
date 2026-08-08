/**
 * Where the bundled files actually live, at runtime.
 *
 * `chrome.scripting.executeScript({ files: [...] })` resolves paths against the
 * *extension root*, and the extension root is not always where the bundle is. The
 * build writes two manifests: `dist/manifest.json`, whose paths are bare filenames,
 * and a generated one at the project root whose paths are prefixed with `dist/` so
 * `chrome://extensions` can load the project folder directly instead of making you
 * descend into `dist/` on every reload.
 *
 * Loading the root with hard-coded `files: ["notice.js"]` fails — silently, because a
 * failed injection is caught and the limit is still enforced, so the only symptom is
 * a banner that never appears. Rather than guess, the prefix is read back out of the
 * manifest, which already has to state where the declarative content script is.
 */

const DECLARED_SCRIPT = "timing.js";

let cached: string | null = null;

/** `""` when loaded from `dist/`, `"dist/"` when loaded from the project root. */
export function bundlePrefix(): string {
  if (cached !== null) return cached;
  let declared = DECLARED_SCRIPT;
  try {
    const manifest = chrome.runtime.getManifest();
    const first = manifest.content_scripts?.[0]?.js?.[0];
    if (typeof first === "string" && first.endsWith(DECLARED_SCRIPT)) declared = first;
  } catch {
    // No manifest available (a test harness). The bare name is the shipped case.
  }
  const slash = declared.lastIndexOf("/");
  cached = slash < 0 ? "" : declared.slice(0, slash + 1);
  return cached;
}

/** A bundled file's path as `chrome.scripting` needs it. */
export function runtimeFile(name: string): string {
  return `${bundlePrefix()}${name}`;
}

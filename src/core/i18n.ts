/**
 * One lookup for every string a person reads.
 *
 * The catalogue itself is assembled at build time: each surface writes its own
 * partial under `i18n/`, and the `merge-locales` plugin in `vite.config.ts` folds
 * them into `dist/_locales/en/messages.json`. Splitting by surface is what lets
 * five people add strings at once without a merge conflict in one 300-entry file;
 * the plugin fails the build on a duplicate key so the split cannot silently
 * change a string's meaning depending on which file was read first.
 *
 * Two decisions are load-bearing here.
 *
 * **A missing message returns the key, not an empty string.** `chrome.i18n`
 * returns `""` for a name it does not know, so a typo'd key renders as a blank
 * label, a blank button, a blank tooltip — a UI that looks *finished* and says
 * nothing. Returning `coreTierStrictLabel` instead puts the fault on the screen
 * where the first person to open the page will see it.
 *
 * **The API is reached through `globalThis`.** `chrome` is not a global in Node,
 * and a bare `chrome?.i18n` still throws `ReferenceError` on an undeclared
 * binding — optional chaining guards a null value, not a missing one. The label
 * tables in `core/types.ts`, `limit/tiers.ts`, `optimize/features.ts` and
 * `optimize/packs.ts` are all evaluated at module load and all imported by
 * `node --test`, which has no `chrome` at all; without this indirection every one
 * of those suites would fail on import rather than on an assertion. The same
 * indirection covers a content script that one day imports a module that reaches
 * this file — content scripts here import nothing from `src/`, but the cost of
 * the guard is one property access and the failure it prevents is a page-side
 * crash with no stack anyone would connect to a label table.
 */

/**
 * The one method used, structurally typed rather than taken from `@types/chrome`.
 *
 * The cast below crosses out of the type system anyway, and naming the shape here
 * means this file compiles and runs identically whether or not the ambient Chrome
 * types are in scope.
 */
interface I18nApi {
  getMessage(name: string, substitutions?: string | string[]): string;
}

function i18nApi(): I18nApi | undefined {
  return (globalThis as { chrome?: { i18n?: I18nApi } }).chrome?.i18n;
}

/**
 * The message named `key`, with `$1`/`$2` filled from `substitutions`.
 *
 * Returns `key` when there is no catalogue (Node, or a page loaded before
 * `_locales` was built) or no message under that name.
 */
export function t(key: string, substitutions?: string | string[]): string {
  const message = i18nApi()?.getMessage(key, substitutions);
  return message === undefined || message === "" ? key : message;
}

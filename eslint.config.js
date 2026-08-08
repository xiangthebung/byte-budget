/**
 * Lint rules for the one convention `tsc` cannot check.
 *
 * The extension's worker is torn down whenever Chrome decides it has been idle,
 * so almost every write in `src/` is asynchronous and almost every caller has to
 * decide, deliberately, whether to await it. The codebase encodes that decision
 * with a `void` prefix: `void flushSoon()` says "this is fire-and-forget and I
 * know it". A bare `flushSoon()` with no `void` and no `await` looks identical at
 * a glance and is a write that may never land — the failure this file exists to
 * catch.
 *
 * `@typescript-eslint/no-floating-promises` is exactly that check: it ignores a
 * `void`-prefixed call by default and flags every other unhandled promise. That
 * turns the convention from something a reviewer has to notice into something CI
 * can prove.
 *
 * The tree passes it today with zero findings, and that zero means what it looks
 * like it means: run the same rule with `ignoreVoid: false` and it reports
 * exactly 70, one per `void` in `src/`. So every prefix marks a real promise —
 * none is decoration over a synchronous call — and the clean run is clean
 * because there is nothing to find, not because the rule is inert.
 *
 * Scope is deliberately narrow. This is not a style config — there is no
 * formatter here and no opinion about quotes or semicolons. It carries the few
 * rules that make an invariant checkable, and nothing that would produce a wall
 * of findings nobody reads.
 *
 * ESLint is installed out of tree, like Playwright, so it stays out of the
 * extension's dependency graph:
 *
 *   npm i --no-save eslint typescript-eslint && npm run lint
 *
 * See CHANGELOG.md and .github/workflows/ci.yml for why it is not part of the
 * blocking `verify` job.
 */
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Build output and vendored code are not ours to lint. `dist/` in particular
    // is minified, so a finding there would be unreadable and unfixable.
    ignores: ["dist/", "dist-throttle/", "artifacts/", "outputs/", "node_modules/"],
  },
  {
    // Type-aware rules need a program, and `tsconfig.json` includes `src` only.
    // Linting anything outside it under this block would fail to resolve.
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The rule this file was written for. `ignoreVoid` defaults to true, which
      // is what makes the existing `void` prefixes the accepted spelling of a
      // deliberate fire-and-forget rather than something to be rewritten.
      "@typescript-eslint/no-floating-promises": "error",

      // `await` on a non-promise is always a mistake, and in a codebase where
      // half the helpers are sync and half are not it is an easy one: it reads
      // as if it sequences something and it sequences nothing.
      "@typescript-eslint/await-thenable": "error",

      // A promise handed to something expecting `void` — an event listener, a
      // `forEach` callback, an `if` condition. The listener case is the dangerous
      // one here: an async `chrome.*` listener that rejects has nowhere to throw,
      // so the error is swallowed and the work silently does not happen.
      "@typescript-eslint/no-misused-promises": "error",

      // An empty block — the shape a branch takes when its body is deleted during
      // a refactor and the `if` guarding it is left behind, which reads as
      // deliberate and is not. `allowEmptyCatch` is on because several catches
      // here swallow on purpose (a rejected `chrome.*` call the caller genuinely
      // does not care about) and each of those carries a comment saying so.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Build tooling and the Node-side scripts. No type information is available
    // for these (they are outside `tsconfig.json`'s `include`), so only rules
    // that read the syntax tree can run.
    files: ["scripts/**/*.mjs", "tests/**/*.mjs", "vite.config.ts", "eslint.config.js"],
    extends: [tseslint.configs.base],
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);

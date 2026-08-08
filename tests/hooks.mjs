/**
 * Module hooks that let a test import the extension's TypeScript sources the way
 * the bundler sees them.
 *
 * Node 23 and later strips type annotations itself, so there is no compile step.
 * The one thing that still gets in the way is that the sources use extensionless
 * relative specifiers (`./types`), which Vite resolves and Node's ESM resolver
 * does not. Appending `.ts` here is cheaper than putting extensions in shipped
 * code to satisfy a test runner.
 *
 * Registered by `tests/register-hooks.mjs`, which the `test` script passes to
 * `node --import` so it is in place before any test file loads.
 */

/** Anything already carrying a module extension is left alone. */
const HAS_EXTENSION = /\.([cm]?[jt]s|json|node|html|css)$/;

export function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !HAS_EXTENSION.test(specifier)) {
    return next(`${specifier}.ts`, context);
  }
  return next(specifier, context);
}

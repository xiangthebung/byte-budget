/**
 * Installs `hooks.mjs` before the test files load.
 *
 * `node --import ./tests/register-hooks.mjs --test` runs this in the main thread
 * first, which is the only place a resolve hook can be registered early enough to
 * affect the static imports at the top of a test file.
 */
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);

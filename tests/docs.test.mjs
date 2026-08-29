/**
 * Assertions that the documentation still describes the code that shipped.
 *
 * Everything else in this suite tests behaviour. This file tests claims — the
 * sentences in README.md, PRIVACY_POLICY.md and STORE_LISTING.md that a reader has
 * no way to check and that no compiler, linter or unit test can notice going wrong.
 * That gap is the expensive one: a privacy policy that has drifted from the code is
 * invisible to every check in the project and is the single thing in a repository
 * most damaging to be wrong about.
 *
 * The pattern throughout is the same. Read the fact out of the *source* — the
 * manifest, a constant, a table — and assert the document contains it. Never the
 * other way round, and never a second copy of the fact written here. A test that
 * hardcodes "nineteen analytics domains" is a third place for that number to be
 * wrong in; a test that reads `ANALYTICS_DOMAINS.length` cannot disagree with the
 * code by construction, and fails the moment the document does.
 *
 * What this deliberately does not do is check prose. Whether a sentence is clear,
 * whether an explanation is honest, whether the tone is right — none of that is
 * mechanisable, and pretending otherwise by asserting on keywords would advertise
 * coverage that does not exist. Those still need a person. What is mechanised here
 * is the class of defect that is purely factual: a renamed file, a deleted script, a
 * permission added to the manifest and never justified, a price changed in one place.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ALERT_THRESHOLDS } from "../src/limit/alerts.ts";
import { PACKS } from "../src/optimize/packs.ts";
import { ANALYTICS_DOMAINS } from "../src/optimize/rules.ts";
import { PRICE_MONTHLY, PRICE_YEARLY, TRIAL_DAYS } from "../src/plus/plans.ts";
import { RETENTION_OPTIONS } from "../src/core/types.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

/**
 * The documents this file is responsible for.
 *
 * A list rather than a directory scan, because the answer to "is this document
 * checked" should be visible in one place and adding a document should be a
 * decision. A new .md that nobody added here is unchecked, which is the same
 * position every document was in before this file existed — so the last test in this
 * file asserts the list covers every tracked Markdown file, and that is what stops
 * the omission being silent.
 */
const DOCS = [
  "README.md",
  "PRIVACY_POLICY.md",
  "STORE_LISTING.md",
  "TERMS_OF_SALE.md",
  "CHANGELOG.md",
  "ARCHITECTURE.md",
  "STATE.md",
];

const text = new Map(DOCS.map((name) => [name, read(name)]));
const everything = [...text.values()].join("\n");

const packageJson = JSON.parse(read("package.json"));
const manifest = JSON.parse(read("public/manifest.json"));

const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .trim()
  .split("\n");

/* ------------------------------------------------------------------ *
 * File paths
 * ------------------------------------------------------------------ */

/**
 * Renames are the most common way documentation rots, and the least visible: the
 * sentence around the path still reads correctly, so nothing looks wrong.
 *
 * Two forms are checked, because the documents use two. A path with a separator
 * (`src/track/ledger.ts`) has to exist exactly as written. A bare filename
 * (`ledger.ts`) is shorthand and has to resolve to exactly one tracked file —
 * *exactly* one, because an ambiguous basename is its own defect: `rules.ts` names
 * three different modules in this repository, and a reader following the reference
 * has no way to tell which was meant.
 */
const byBasename = new Map();
for (const file of tracked) {
  const base = file.split("/").pop();
  byBasename.set(base, [...(byBasename.get(base) ?? []), file]);
}

/** Directories that are source. `dist/` and `_locales/` are build output. */
const SOURCE_DIRECTORIES = /^(src|tests|scripts|i18n|public|store-assets|\.github)\//;
const FILE_EXTENSION = /[\w-]\.(md|json|ts|mjs|js|css|html|yml)$/;

/** Backticked spans that are code or a pattern rather than a path. */
const NOT_A_PATH = /[*{}$ ()<>|]/;

function pathsIn(document) {
  const found = [];
  for (const [, span] of document.matchAll(/`([^`\n]+)`/g)) {
    if (NOT_A_PATH.test(span) || !FILE_EXTENSION.test(span)) continue;
    found.push(span);
  }
  return found;
}

test("every file path the documents name still exists", () => {
  const broken = [];
  for (const [name, document] of text) {
    for (const span of pathsIn(document)) {
      if (span.includes("/")) {
        // A path into a build directory describes output, not a tracked file, and
        // asserting on it would make this test depend on whether anyone has run a
        // build. The source it is generated from is checked by the basename branch.
        if (!SOURCE_DIRECTORIES.test(span)) continue;
        if (!existsSync(new URL(`../${span}`, import.meta.url))) {
          broken.push(`${name}: \`${span}\` does not exist`);
        }
        continue;
      }
      const hits = byBasename.get(span);
      // A bare `.js` name is a built artefact (`dist/timing.js`); its `.ts` source is
      // what this repository tracks, so only names that match nothing at all fail.
      if (!hits) {
        const source = byBasename.get(span.replace(/\.js$/, ".ts"));
        if (!source) broken.push(`${name}: \`${span}\` names no tracked file`);
        continue;
      }
      if (hits.length > 1) {
        broken.push(`${name}: \`${span}\` is ambiguous — ${hits.join(", ")}`);
      }
    }
  }
  assert.deepEqual(broken, [], `documentation names files that are not there:\n${broken.join("\n")}`);
});

test("every npm script the documents tell you to run exists", () => {
  const missing = [];
  for (const [name, document] of text) {
    for (const [, script] of document.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
      if (!(script in packageJson.scripts)) {
        missing.push(`${name}: \`npm run ${script}\` is not in package.json`);
      }
    }
  }
  assert.deepEqual(missing, [], missing.join("\n"));
});

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

/**
 * Manifest to document, which is the direction that protects a user.
 *
 * A permission in the manifest that no document justifies is an undisclosed
 * capability — the extension asks Chrome for something and tells the person installing
 * it nothing about why.
 *
 * The reverse direction is not asserted in general, because the documents legitimately
 * discuss a permission the store manifest does not carry: `debugger` belongs to the
 * throttle channel, which `vite.config.ts` adds it to and which is never published.
 * That one case gets its own assertion below rather than an exemption here, because
 * "the store build must not ship `debugger`" is the claim worth pinning.
 */
test("every permission the extension asks for is justified in the documents", () => {
  const undocumented = [];
  for (const permission of manifest.permissions) {
    for (const name of ["PRIVACY_POLICY.md", "STORE_LISTING.md"]) {
      if (!text.get(name).includes(`\`${permission}\``)) {
        undocumented.push(`${name} does not justify \`${permission}\``);
      }
    }
  }
  assert.deepEqual(undocumented, [], undocumented.join("\n"));
});

test("the published channel does not ask for the debugger permission", () => {
  assert.ok(
    !manifest.permissions.includes("debugger"),
    "public/manifest.json declares `debugger`; it belongs only to the throttle channel, " +
      "which vite.config.ts adds it to and which is not published.",
  );
});

test("the host access the documents describe is the access the manifest takes", () => {
  for (const host of manifest.host_permissions) {
    assert.ok(
      text.get("PRIVACY_POLICY.md").includes(host),
      `PRIVACY_POLICY.md does not mention host access to ${host}`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * The privacy policy against the code
 * ------------------------------------------------------------------ */

/**
 * The policy names the image services whose URLs the extension rewrites, and says
 * "no other host is ever rewritten". That sentence is only true while the list in
 * the policy is a superset of the list in `packs.ts`, and adding a pack is exactly
 * the change that would break it without anybody noticing.
 */
test("the policy names every image host the optimizer rewrites", () => {
  const policy = text.get("PRIVACY_POLICY.md");
  const missing = [];
  for (const pack of PACKS) {
    for (const host of pack.hosts) {
      // Photon's three hosts are written as one range in the policy (`i0-2.wp.com`),
      // which is the readable form of the same claim; match on the registrable part.
      const stem = host.replace(/^i[0-2]\./, "");
      if (!policy.includes(host) && !policy.includes(stem)) {
        missing.push(`${host} (pack "${pack.id}")`);
      }
    }
  }
  assert.deepEqual(missing, [], `PRIVACY_POLICY.md does not name: ${missing.join(", ")}`);
});

/**
 * The policy counts the analytics domains in words. A count in prose is a fact with
 * no other copy to disagree with it, so it drifts silently the first time the list
 * changes — which is what this reads out of the list instead.
 */
test("the number of analytics domains the policy states is the number in the list", () => {
  const WORDS = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen", "twenty", "twenty-one", "twenty-two",
    "twenty-three", "twenty-four", "twenty-five",
  ];
  const policy = text.get("PRIVACY_POLICY.md");
  const stated = policy.match(/([a-z-]+) analytics domains/);
  assert.ok(stated, "PRIVACY_POLICY.md no longer states how many analytics domains are blocked");
  assert.equal(
    stated[1],
    WORDS[ANALYTICS_DOMAINS.length],
    `PRIVACY_POLICY.md says "${stated[1]} analytics domains"; optimize/rules.ts lists ` +
      `${ANALYTICS_DOMAINS.length}`,
  );
});

test("the retention choices the policy lists are the choices the code offers", () => {
  const policy = text.get("PRIVACY_POLICY.md");
  for (const days of RETENTION_OPTIONS) {
    // 0 is "keep everything" and has no day figure to print.
    if (days === 0) continue;
    assert.ok(
      policy.includes(`${days} days`),
      `PRIVACY_POLICY.md does not offer the ${days}-day retention option that ` +
        "core/types.ts does",
    );
  }
  // The documents are hard-wrapped, so any run of whitespace here can be a newline.
  const listed = policy.match(/There are (\w+)\s+choices and no others/);
  assert.ok(listed, "PRIVACY_POLICY.md no longer states how many retention choices there are");
  assert.equal(
    listed[1],
    ["zero", "one", "two", "three", "four", "five", "six"][RETENTION_OPTIONS.length],
    `the policy states ${listed[1]} retention choices; core/types.ts declares ` +
      `${RETENTION_OPTIONS.length}`,
  );
});

test("the alert thresholds the documents promise are the thresholds that fire", () => {
  const stated = ALERT_THRESHOLDS.map((share) => `${Math.round(share * 100)}%`);
  for (const name of ["PRIVACY_POLICY.md", "STORE_LISTING.md", "README.md"]) {
    for (const threshold of stated) {
      assert.ok(
        text.get(name).includes(threshold),
        `${name} does not mention the ${threshold} alert that limit/alerts.ts sends`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * What is being sold
 * ------------------------------------------------------------------ */

/**
 * A price is a promise, and it is written in four places: two constants, the store
 * listing and the terms of sale. `plans.ts` says plainly that it cannot set a price
 * and that a mismatch with the ExtensionPay dashboard is a copy bug — this closes the
 * half of that which is inside the repository.
 */
test("the prices and the trial length agree everywhere they are printed", () => {
  for (const name of ["STORE_LISTING.md", "TERMS_OF_SALE.md"]) {
    const document = text.get(name);
    assert.ok(document.includes(PRICE_MONTHLY), `${name} does not print ${PRICE_MONTHLY}`);
    assert.ok(document.includes(PRICE_YEARLY), `${name} does not print ${PRICE_YEARLY}`);
    assert.ok(
      document.includes(`${TRIAL_DAYS}-day`) || document.includes(`${TRIAL_DAYS} days`),
      `${name} does not state the ${TRIAL_DAYS}-day trial that plus/plans.ts grants`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * The repository was renamed from `network-data-tracker` to `byte-budget` and two
 * documents kept linking to the old address for a while. A dead privacy-policy link
 * in a store listing is a submission blocker, and nothing in a build would ever have
 * caught it, so the slug is derived from `package.json` and every GitHub URL in every
 * document has to use it.
 */
test("every GitHub link points at this repository", () => {
  const wrong = [];
  for (const [name, document] of text) {
    for (const [url, slug] of document.matchAll(/https:\/\/github\.com\/[\w-]+\/([\w.-]+)/g)) {
      if (slug !== packageJson.name) {
        wrong.push(`${name}: ${url} does not name "${packageJson.name}"`);
      }
    }
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));
});

/**
 * The product is called Byte Budget. The directory it is developed in is not, and
 * the repository was not either until it was renamed, so the old name is the kind of
 * thing that comes back in a paste.
 */
test("no document calls the product by a name it does not have", () => {
  const found = [];
  for (const [name, document] of text) {
    // CHANGELOG.md is a historical record; an entry that says a thing was renamed has
    // to be able to say what it was renamed from.
    if (name === "CHANGELOG.md") continue;
    if (/network[- ]data[- ]tracker/i.test(document)) found.push(name);
  }
  assert.deepEqual(found, [], `these still use the old project name: ${found.join(", ")}`);
});

test("the extension's name in the catalogue is the name the documents use", () => {
  const core = JSON.parse(read("i18n/core.json"));
  const name = core.extensionName.message;
  assert.equal(name, "Byte Budget");
  for (const document of ["README.md", "PRIVACY_POLICY.md", "STORE_LISTING.md"]) {
    assert.ok(text.get(document).includes(name), `${document} never names the product`);
  }
});

/* ------------------------------------------------------------------ *
 * The list itself
 * ------------------------------------------------------------------ */

/**
 * Without this, the way to defeat every test above is to write a new document.
 *
 * A tracked Markdown file that `DOCS` does not name is unchecked, and it is unchecked
 * silently — which is precisely the state this file exists to end. Failing here forces
 * the decision to be explicit: add it to the list, or do not add the document.
 */
test("every tracked Markdown document is on the checked list", () => {
  const markdown = tracked.filter((file) => file.endsWith(".md"));
  const unchecked = markdown.filter((file) => !DOCS.includes(file));
  assert.deepEqual(
    unchecked,
    [],
    `these documents are tracked but not checked by tests/docs.test.mjs: ${unchecked.join(", ")}`,
  );
});

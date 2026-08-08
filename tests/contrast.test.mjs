/**
 * Contrast assertions over the design tokens in `src/app.css`.
 *
 * `--text-muted` shipped at `#6d8087`, which measured 4.13:1 on white and 3.46:1 on
 * `--surface-3` — under AA everywhere, on text that is 9, 10 and 11 pixels and so
 * never large enough for the 3:1 exemption. `--estimate` shipped at `#a95d10`, which
 * measured 4.40:1 on `--estimate-soft`, the surface it is actually used on, and every
 * figure that colour carries is one the product is admitting is modelled rather than
 * measured — the last thing that should be hard to read.
 *
 * Both were fixed by eye and by hand, which is exactly the kind of fix that gets
 * reverted by the next person who thinks a colour looks heavy. So the palette is
 * parsed out of the stylesheet and every text token is measured against every
 * background token in it, in both themes. The maths is here rather than in a
 * dependency because it is fifteen lines of arithmetic straight out of WCAG 2.1, and
 * a contrast checker this file could not audit would be a strange thing to trust with
 * the assertion that the palette is legible.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CSS = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");

/* ------------------------------------------------------------------ *
 * WCAG 2.1 relative luminance and contrast
 * ------------------------------------------------------------------ */

function channels(hex) {
  const value = hex.length === 4 ? hex.replace(/^#(.)(.)(.)$/, "#$1$1$2$2$3$3") : hex;
  return [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16) / 255);
}

/** WCAG 2.1 relative luminance: sRGB channels linearised, then weighted. */
function luminance(hex) {
  const [red, green, blue] = channels(hex).map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Two decimal places, which is the precision the comments in `app.css` are written to. */
const measured = (foreground, background) => Math.round(contrast(foreground, background) * 100) / 100;

/* ------------------------------------------------------------------ *
 * The palette, read out of the stylesheet
 * ------------------------------------------------------------------ */

/**
 * Every `--token: #hex` in the file, split into the two themes.
 *
 * The dark values are declared once as `--dark-*` and pointed at twice — for an
 * explicit choice and for `prefers-color-scheme` — so the `#`-valued declarations are
 * the whole palette and the `var()` ones below them are wiring.
 */
function palettes() {
  const light = new Map();
  const dark = new Map();
  for (const [, name, value] of CSS.matchAll(
    /--([a-z0-9-]+)\s*:\s*(#(?:[0-9a-f]{3}|[0-9a-f]{6}))\s*;/gi,
  )) {
    if (name.startsWith("dark-")) dark.set(name.slice(5), value.toLowerCase());
    else light.set(name, value.toLowerCase());
  }
  return { light, dark };
}

const { light, dark } = palettes();

/**
 * Every token something is painted *on*: the page and card surfaces, and the four
 * tinted chips a status colour sits inside.
 *
 * Named here and cross-checked against the stylesheet below, so a new surface cannot
 * be added without someone deciding whether the text on it is readable.
 */
const BACKGROUNDS = [
  "bg",
  "bg-glow",
  "surface",
  "surface-2",
  "surface-3",
  "accent-soft",
  "saved-soft",
  "estimate-soft",
  "danger-soft",
  "bar-track",
];

/** Every token text or a figure is painted *in*. Borders and the two hovers are not text. */
const FOREGROUNDS = ["text", "text-soft", "text-muted", "accent", "saved", "estimate", "danger"];

const AA = 4.5;

test("the palette parses, and both themes carry the same tokens", () => {
  // A token added to one theme and forgotten in the other is a colour that stops
  // responding to the theme switch, which reads as a rendering bug rather than as a
  // missing line — and it would silently drop out of every assertion below.
  assert.ok(light.size >= 20, `parsed only ${light.size} light tokens`);
  assert.deepEqual([...dark.keys()].sort(), [...light.keys()].sort());
  for (const token of [...BACKGROUNDS, ...FOREGROUNDS]) {
    assert.ok(light.has(token), `--${token} is missing from app.css`);
  }
});

test("a new surface cannot be added without being measured", () => {
  // Derived from the naming convention rather than trusted: `--bg*`, `--surface*`,
  // `--bar-track` and every `*-soft` chip are things text sits on. If someone adds one,
  // this fails until they add it to the list above and see what it does to the ratios.
  const looksLikeASurface = [...light.keys()]
    .filter((token) => /^(bg|surface|bar-track)/.test(token) || token.endsWith("-soft"))
    // `--text-soft` is the one collision in the convention: it is soft text, not a soft
    // surface. Every other `*-soft` is the tinted chip a status colour sits inside.
    .filter((token) => token !== "text-soft")
    .sort();
  assert.deepEqual(looksLikeASurface, [...BACKGROUNDS].sort());
});

test("every text colour clears AA on every background in the light palette", () => {
  // Light is the theme that failed. Nothing carrying `--text-muted` is large enough for
  // the 3:1 large-text exemption — the chart ticks are 9px, `.site-share` 10px, the
  // hints, notes and save status 11px — so 4.5:1 is the bar for all of it.
  for (const foreground of FOREGROUNDS) {
    for (const background of BACKGROUNDS) {
      const ratio = measured(light.get(foreground), light.get(background));
      assert.ok(
        ratio >= AA,
        `--${foreground} on --${background} is ${ratio}:1 in light, needs ${AA}:1`,
      );
    }
  }
});

test("every text colour clears AA on every background in the dark palette", () => {
  for (const foreground of FOREGROUNDS) {
    for (const background of BACKGROUNDS) {
      const ratio = measured(dark.get(foreground), dark.get(background));
      assert.ok(
        ratio >= AA,
        `--${foreground} on --${background} is ${ratio}:1 in dark, needs ${AA}:1`,
      );
    }
  }
});

test("a button's label clears AA on the button, in both themes and both states", () => {
  // `--accent-contrast` is the one foreground that never appears on a surface token, so
  // the loops above cannot see it. Its two backgrounds are the accent and its hover, and
  // the hover is the state a pointer is over when someone is reading the label.
  for (const [name, theme] of [
    ["light", light],
    ["dark", dark],
  ]) {
    for (const background of ["accent", "accent-hover"]) {
      const ratio = measured(theme.get("accent-contrast"), theme.get(background));
      assert.ok(ratio >= AA, `--accent-contrast on --${background} is ${ratio}:1 in ${name}`);
    }
  }
});

test("the ratios written into app.css are the ratios the palette has", () => {
  // The comments beside these two tokens are the record of why they hold the values
  // they do. A comment carrying a number nobody re-derives is a comment that becomes
  // false quietly, and this file is the only thing that can catch it.
  assert.equal(measured(light.get("text-muted"), light.get("surface")), 5.7);
  assert.equal(measured(light.get("text-muted"), light.get("bg")), 5.23);
  assert.equal(measured(light.get("text-muted"), light.get("surface-2")), 5.12);
  assert.equal(measured(light.get("text-muted"), light.get("surface-3")), 4.78);
  const tinted = ["accent-soft", "saved-soft", "estimate-soft", "danger-soft"].map((token) =>
    measured(light.get("text-muted"), light.get(token)),
  );
  assert.equal(Math.min(...tinted), 4.86, "no lower than 4.86 on the four tinted surfaces");
  assert.equal(measured(dark.get("text-muted"), dark.get("surface")), 6.11, "dark was never the problem");

  assert.equal(measured(light.get("estimate"), light.get("estimate-soft")), 5.09);
  assert.equal(measured(light.get("estimate"), light.get("surface")), 5.7);
  assert.equal(measured(light.get("estimate"), light.get("bg")), 5.24);
  assert.equal(measured(light.get("estimate"), light.get("surface-2")), 5.12);

  // The stated cost of the fix: muted now sits much closer to `--text-soft`, so the
  // hierarchy leans on size and weight rather than on colour.
  assert.equal(measured(light.get("text-soft"), light.get("text-muted")), 1.17);
});

test("the values these tokens replaced still fail, which is why they were replaced", () => {
  // The archaeology, kept executable. Someone who thinks the muted grey looks heavy can
  // read the old figures here and see what reverting costs, rather than rediscovering it
  // from a bug report about a 9px tick label.
  assert.equal(measured("#6d8087", light.get("surface")), 4.13);
  assert.equal(measured("#6d8087", light.get("bg")), 3.79);
  assert.equal(measured("#6d8087", light.get("surface-2")), 3.71);
  assert.equal(measured("#6d8087", light.get("surface-3")), 3.46);
  // And the obvious stop on the way, which clears three of the four backgrounds and
  // fails on the one `.host-tag` and the paused chip both sit on.
  assert.equal(measured("#5a6f76", light.get("surface-3")), 4.43);
  assert.ok(measured("#5a6f76", light.get("surface-3")) < AA);
  // The previous `--estimate`, on the surface it is actually used on.
  assert.equal(measured("#a95d10", light.get("estimate-soft")), 4.4);
});

test("the contrast maths agrees with the two ratios everyone knows", () => {
  // A self-check on the arithmetic above, because every other assertion in this file is
  // only as good as it is. Black on white is 21:1 by definition, a colour against itself
  // is 1:1, and the relation is symmetric.
  assert.equal(measured("#000000", "#ffffff"), 21);
  assert.equal(measured("#ffffff", "#ffffff"), 1);
  assert.equal(measured("#777777", "#ffffff"), measured("#ffffff", "#777777"));
  // Three-digit hex expands, so a palette written in shorthand would still be measured
  // rather than silently parsed as black.
  assert.equal(measured("#fff", "#000"), 21);
});

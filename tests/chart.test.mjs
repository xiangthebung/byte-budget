/**
 * Tests for the two charts, which are pure functions from numbers to elements.
 *
 * Everything asserted here was a defect someone could see on screen, and every one of
 * them is decided by an expression short enough to be re-broken in a one-line edit:
 *
 * - Ticks are counted back from the newest bar. Counting forward from the oldest left
 *   index 29 of a 30-day chart — today, the one bar anyone opens the chart to read —
 *   guaranteed unlabelled at every tick interval that does not divide 29.
 * - A category is folded into "Everything else" as soon as one segment has been kept,
 *   and there is an absolute floor as well as a share. The old `kept.length >= 3` meant
 *   no threshold could bite until three segments were already named, which is how a
 *   68-byte row ended up in the legend directly above "Everything else 68 B" — the same
 *   value twice, separated only by where the sort had put it.
 * - The second colour inside the bars is suppressed entirely when there is none to
 *   show. A key and an extra table column naming a quantity that is zero everywhere is
 *   a legend for a thing nobody can find.
 *
 * `chart.ts` builds real elements, so this file carries the smallest DOM that
 * `core/dom.ts` uses. Rendering rather than inspecting a data structure is the point:
 * the tick decision and the fold decision only exist in the output.
 */
import assert from "node:assert/strict";
import test from "node:test";

/* ------------------------------------------------------------------ *
 * The smallest DOM `element()` needs
 * ------------------------------------------------------------------ */

class FakeText {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.className = "";
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {
      properties: new Map(),
      setProperty(name, value) {
        this.properties.set(name, value);
      },
    };
  }
  get textContent() {
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.childNodes = [new FakeText(String(value))];
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  appendChild(child) {
    this.childNodes.push(child);
    return child;
  }
  addEventListener() {}
}

globalThis.document = {
  createElement: (tagName) => new FakeElement(tagName),
  createTextNode: (data) => new FakeText(data),
};

const { barChart, stackedBar } = await import("../src/core/chart.ts");

function* elements(node) {
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    yield child;
    yield* elements(child);
  }
}

const byClass = (root, className) =>
  [...elements(root)].filter((node) => node.className === className);

/** `scope` is set as a property by `valueTable`, the way the DOM reflects it. */
const columnHeadings = (root) =>
  [...elements(root)]
    .filter((node) => node.tagName === "TH" && node.scope === "col")
    .map((node) => node.textContent);

const bytes = (value) => `${value} B`;

/* ------------------------------------------------------------------ *
 * Tick anchoring
 * ------------------------------------------------------------------ */

const month = Array.from({ length: 30 }, (_value, index) => ({
  key: `day-${index}`,
  value: 1_000 + index,
  tick: String(index),
  label: `day ${index}`,
}));

test("the newest column is the one that is always labelled", () => {
  const figure = barChart({ points: month, format: bytes, tickEvery: 4 });
  const ticks = byClass(figure, "chart-bar-tick").map((node) => node.textContent);
  assert.equal(ticks.length, 30, "one tick slot per column, labelled or not");

  // Today, and it carries its label. Counting forward from the oldest bar labels
  // 0, 4, 8 … 28 and stops, so the bar the chart exists to be read for is the one bar
  // with no date under it.
  assert.equal(ticks.at(-1), "29");
  assert.equal(ticks[0], "", "the anchor is still the oldest column");

  const labelled = ticks
    .map((tick, index) => (tick === "" ? null : index))
    .filter((index) => index !== null);
  assert.deepEqual(labelled, [1, 5, 9, 13, 17, 21, 25, 29]);
});

test("every column keeps its label when they all fit", () => {
  const figure = barChart({ points: month, format: bytes });
  const ticks = byClass(figure, "chart-bar-tick").map((node) => node.textContent);
  assert.deepEqual(ticks, month.map((point) => point.tick));
});

/* ------------------------------------------------------------------ *
 * The overlay
 * ------------------------------------------------------------------ */

const withOverlay = (overlay) =>
  Array.from({ length: 4 }, (_value, index) => ({
    key: `day-${index}`,
    value: 1_000,
    tick: String(index),
    label: `day ${index}`,
    overlay,
  }));

test("a series that saved nothing is drawn and described in one colour", () => {
  const figure = barChart({
    points: withOverlay(0),
    format: bytes,
    caption: "Data used",
    overlayLabel: "saved",
  });

  assert.deepEqual(byClass(figure, "chart-bar-overlay"), [], "a second band with nothing in it");
  assert.deepEqual(byClass(figure, "chart-key"), [], "a key for a colour that is never drawn");

  const chart = byClass(figure, "chart")[0];
  assert.ok(!chart.getAttribute("aria-label").includes("saved"), chart.getAttribute("aria-label"));

  // And no third column of zeroes in the table a screen reader actually reads.
  assert.deepEqual(columnHeadings(figure), ["When", "Data"]);
});

test("a series that saved something names the second colour everywhere it appears", () => {
  const figure = barChart({
    points: withOverlay(250),
    format: bytes,
    caption: "Data used",
    overlayLabel: "saved",
  });

  assert.equal(byClass(figure, "chart-bar-overlay").length, 4);
  const key = byClass(figure, "chart-key");
  assert.equal(key.length, 1);
  assert.ok(key[0].textContent.includes("saved"));
  assert.ok(key[0].textContent.includes("Total"));

  const chart = byClass(figure, "chart")[0];
  // A second colour makes a claim about the first, and the summary is the only reading
  // of that claim a screen reader gets.
  assert.ok(chart.getAttribute("aria-label").includes("1000 B saved"));

  assert.deepEqual(columnHeadings(figure), ["When", "Data", "saved"]);
});

/* ------------------------------------------------------------------ *
 * The legend fold
 * ------------------------------------------------------------------ */

const legendOf = (stack) => ({
  labels: byClass(stack, "stack-legend-label").map((node) => node.textContent),
  values: byClass(stack, "stack-legend-value").map((node) => node.textContent),
});

test("a category the size of the remainder is not named beside it", () => {
  // The breakdown from the shipped popup screenshot: one real category and three
  // tiny ones. Under the old `kept.length >= 3` guard the first three segments were
  // named whatever their size, so the legend read "Beacons 68 B" and then
  // "Everything else 68 B" — the same number twice, and the only thing deciding which
  // row a category landed in was where the sort had put it.
  const stack = stackedBar({
    segments: [
      { key: "image", label: "Images", value: 700 },
      { key: "ping", label: "Beacons", value: 68 },
      { key: "script", label: "Scripts", value: 68 },
      { key: "font", label: "Fonts", value: 68 },
    ],
    format: bytes,
  });

  const { labels, values } = legendOf(stack);
  assert.deepEqual(labels, ["Images", "Everything else"]);
  assert.deepEqual(values, ["700 B", "204 B"]);
  assert.equal(new Set(values).size, values.length, "two legend rows print the same value");
});

test("the share test alone cannot fold anything on a quiet day", () => {
  // 68 bytes out of 904 is 7.5%, which clears any share threshold worth having. The
  // absolute floor is what folds it, and this is the case that needs it: on a quiet
  // day every category is a large share of almost nothing.
  const stack = stackedBar({
    segments: [
      { key: "image", label: "Images", value: 700 },
      { key: "ping", label: "Beacons", value: 68 },
    ],
    format: bytes,
    minShare: 0,
  });
  assert.deepEqual(legendOf(stack).labels, ["Images", "Everything else"]);
});

test("the share test still folds a category the floor would keep", () => {
  // 60 kB clears the absolute floor and is still 0.6% of the total. The floor is an
  // addition to the share test, not a replacement for it.
  const stack = stackedBar({
    segments: [
      { key: "media", label: "Video", value: 10_000_000 },
      { key: "script", label: "Scripts", value: 60_000 },
    ],
    format: bytes,
  });
  assert.deepEqual(legendOf(stack).labels, ["Video", "Everything else"]);
});

test("a category that is large in both tests keeps its own row", () => {
  const stack = stackedBar({
    segments: [
      { key: "media", label: "Video", value: 5_000_000 },
      { key: "image", label: "Images", value: 1_000_000 },
    ],
    format: bytes,
  });
  const { labels } = legendOf(stack);
  assert.deepEqual(labels, ["Video", "Images"]);
  assert.ok(!labels.includes("Everything else"), "a remainder was invented out of nothing");
});

test("the remainder does not compete with the real categories for a colour", () => {
  const stack = stackedBar({
    segments: [
      { key: "main_frame", label: "Pages", value: 700 },
      { key: "ping", label: "Beacons", value: 68 },
      { key: "script", label: "Scripts", value: 68 },
    ],
    format: bytes,
  });
  const swatches = byClass(stack, "stack-swatch");
  assert.equal(swatches.length, 2);
  // Colour is the only thing tying a legend row to a band. The fold is the absence of
  // a category, so it is desaturated rather than given a hue of its own — at 220 it was
  // one step from `main_frame`'s 205 and the two read as the same blue.
  assert.equal(swatches[0].style.properties.get("--swatch-sat"), undefined);
  assert.ok(swatches[1].style.properties.get("--swatch-sat"));
  assert.notEqual(
    swatches[1].style.properties.get("--hue"),
    swatches[0].style.properties.get("--hue"),
  );
});

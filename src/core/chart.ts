/**
 * Two charts, built from HTML and CSS rather than SVG or a library.
 *
 * A bar chart is a row of boxes with heights, which is what flexbox does. Drawing
 * it in SVG would mean either a distorted `preserveAspectRatio="none"` viewBox or
 * measuring the container in script to lay out coordinates, and the second is how
 * a chart ends up 4px wide inside a popup that has not finished opening. Boxes
 * with percentage heights are correct at every width, before layout, for free.
 *
 * Both return elements that carry their own accessible description: a chart is an
 * image of numbers, and a screen reader should get the numbers.
 */

import { element, hueFor, type Child } from "./dom";

export interface BarPoint {
  /** Identifies the bar to a click handler. */
  key: string;
  value: number;
  /** Printed under the bar. Keep it to three characters or so. */
  tick?: string;
  /** Full description for the tooltip and the accessible summary. */
  label: string;
  /** Draws a second segment inside the bar, e.g. the part that was saved. */
  overlay?: number;
}

export interface BarChartOptions {
  points: readonly BarPoint[];
  /** Formats a value for tooltips and the accessible summary. */
  format: (value: number) => string;
  /** Called when a bar is activated. Bars are only focusable when this is set. */
  onSelect?: (key: string) => void;
  /** Key of the bar to mark as current. */
  selected?: string;
  /** Sentence in front of the accessible summary. */
  caption?: string;
  /** Show every nth tick label. Defaults to showing all of them. */
  tickEvery?: number;
}

const MIN_VISIBLE_SHARE = 0.02;

export function barChart(options: BarChartOptions): HTMLElement {
  const { points, format, onSelect, selected, caption, tickEvery = 1 } = options;
  const peak = points.reduce((max, point) => Math.max(max, point.value), 0);

  const bars = points.map((point, index) => {
    // A day with 40 kB next to a day with 4 GB would round to nothing and read as
    // "no data", which is a different claim. Anything above zero keeps 2% height.
    const share = peak > 0 ? point.value / peak : 0;
    const height = point.value > 0 ? Math.max(share, MIN_VISIBLE_SHARE) : 0;
    const overlayShare =
      point.overlay && point.value > 0 ? Math.min(1, point.overlay / point.value) : 0;

    // No element at all for an empty bucket. A 2px stub of accent colour on every
    // idle day is indistinguishable from a day with 40 kB in it, and there is a
    // real difference between "nothing happened" and "almost nothing happened".
    const fill =
      point.value > 0
        ? element(
            "span",
            {
              className: "chart-bar-fill",
              style: { height: `${(height * 100).toFixed(2)}%` },
              ariaHidden: true,
            },
            [
              overlayShare > 0 &&
                element("span", {
                  className: "chart-bar-overlay",
                  style: { height: `${(overlayShare * 100).toFixed(2)}%` },
                }),
            ],
          )
        : undefined;

    const column: Child[] = [
      element("span", { className: "chart-bar-track", ariaHidden: true }, [fill]),
      point.tick !== undefined && index % tickEvery === 0
        ? element("span", { className: "chart-bar-tick", text: point.tick, ariaHidden: true })
        : element("span", { className: "chart-bar-tick", ariaHidden: true }),
    ];

    const title = `${point.label}: ${format(point.value)}`;
    const dataset: Record<string, string> = { key: point.key };
    if (selected === point.key) dataset.selected = "true";

    if (!onSelect) {
      return element("div", { className: "chart-bar", title, dataset }, column);
    }
    const node = element("button", { className: "chart-bar", title, dataset, ariaLabel: title }, column);
    node.type = "button";
    node.addEventListener("click", () => onSelect(point.key));
    return node;
  });

  const summary = points
    .filter((point) => point.value > 0)
    .map((point) => `${point.label} ${format(point.value)}`)
    .join(", ");

  return element(
    "div",
    {
      className: "chart",
      role: "img",
      ariaLabel: `${caption ? `${caption}. ` : ""}${summary || "No usage recorded."}`,
    },
    bars,
  );
}

export interface StackSegment {
  key: string;
  label: string;
  value: number;
  /** Overrides the hash-derived hue. */
  hue?: number;
}

export interface StackedBarOptions {
  segments: readonly StackSegment[];
  format: (value: number) => string;
  /** Segments below this share of the total are folded into one "Other". */
  minShare?: number;
  caption?: string;
}

/**
 * A single horizontal bar split by category, plus a legend.
 *
 * Chosen over a donut because the popup is 420px wide and a donut spends most of
 * that on a hole. A stacked bar also stays readable at four segments and at
 * twelve, which a pie does not.
 */
export function stackedBar(options: StackedBarOptions): HTMLElement {
  const { segments, format, minShare = 0.02, caption } = options;
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  if (total <= 0) {
    return element("div", { className: "stack stack-empty" }, [
      element("p", { className: "stack-note", text: "Nothing recorded yet." }),
    ]);
  }

  const sorted = [...segments].filter((segment) => segment.value > 0).sort((a, b) => b.value - a.value);
  const kept: StackSegment[] = [];
  let folded = 0;
  for (const segment of sorted) {
    if (segment.value / total < minShare && kept.length >= 3) folded += segment.value;
    else kept.push(segment);
  }
  if (folded > 0) kept.push({ key: "other", label: "Everything else", value: folded, hue: 220 });

  const track = element(
    "div",
    { className: "stack-track", ariaHidden: true },
    kept.map((segment) =>
      element("span", {
        className: "stack-segment",
        title: `${segment.label}: ${format(segment.value)}`,
        style: {
          width: `${((segment.value / total) * 100).toFixed(3)}%`,
          "--hue": String(segment.hue ?? hueFor(segment.key)),
        },
      }),
    ),
  );

  const legend = element(
    "ul",
    { className: "stack-legend" },
    kept.map((segment) =>
      element("li", { className: "stack-legend-item" }, [
        element("span", {
          className: "stack-swatch",
          ariaHidden: true,
          style: { "--hue": String(segment.hue ?? hueFor(segment.key)) },
        }),
        element("span", { className: "stack-legend-label", text: segment.label }),
        element("span", { className: "stack-legend-value", text: format(segment.value) }),
      ]),
    ),
  );

  const summary = kept.map((segment) => `${segment.label} ${format(segment.value)}`).join(", ");
  return element(
    "div",
    { className: "stack", role: "group", ariaLabel: `${caption ?? "Breakdown"}: ${summary}` },
    [track, legend],
  );
}

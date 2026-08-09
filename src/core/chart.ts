/**
 * Two charts, built from HTML and CSS rather than SVG or a library.
 *
 * A bar chart is a row of boxes with heights, which is what flexbox does. Drawing
 * it in SVG would mean either a distorted `preserveAspectRatio="none"` viewBox or
 * measuring the container in script to lay out coordinates, and the second is how
 * a chart ends up 4px wide inside a popup that has not finished opening. Boxes
 * with percentage heights are correct at every width, before layout, for free.
 *
 * Both return elements that carry their own accessible description, because a
 * chart is an image of numbers and a screen reader should get the numbers: a
 * summary that states the shape in words, and — for the static bar chart, where
 * the bars are not reachable on their own — a visually hidden table of values.
 */

import { element, hueFor, type Child } from "./dom";
import { t } from "./i18n";

export interface BarPoint {
  /** Identifies the bar to a click handler. */
  key: string;
  value: number;
  /** Printed under the bar. Keep it to three characters or so. */
  tick?: string;
  /** Full description for the tooltip and the accessible summary. */
  label: string;
  /** Draws a second band inside the bar, e.g. the part that was saved. Name it with `overlayLabel`. */
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
  /**
   * Names the inner band in the key, the tooltips and the summary.
   *
   * A second colour inside the bar makes a claim about the first, and the chart
   * cannot know what that claim is. Whatever a caller puts in the `overlay` field
   * has to be named here in the caller's own words, including whether the figure
   * is measured or modelled.
   */
  overlayLabel?: string;
}

const MIN_VISIBLE_SHARE = 0.02;

/**
 * Columns the axis is padded out to before the bars are laid out.
 *
 * Three bars in a 400px panel drew three 46px columns hard against the left edge
 * with the baseline stopping underneath them, which reads as a chart that failed
 * to render rather than as a short series.
 */
const MIN_BUCKETS = 8;

export function barChart(options: BarChartOptions): HTMLElement {
  const {
    points,
    format,
    onSelect,
    selected,
    caption,
    tickEvery = 1,
    overlayLabel = "saved",
  } = options;
  const peak = points.reduce((max, point) => Math.max(max, point.value), 0);
  const overlayTotal = points.reduce((sum, point) => sum + Math.max(0, point.overlay ?? 0), 0);
  const hasOverlay = overlayTotal > 0;

  const bars = points.map((point, index) => {
    // A day with 40 kB next to a day with 4 GB would round to nothing and read as
    // "no data", which is a different claim. Anything above zero keeps 2% height.
    const share = peak > 0 ? point.value / peak : 0;
    const height = point.value > 0 ? Math.max(share, MIN_VISIBLE_SHARE) : 0;
    const overlay = Math.max(0, point.overlay ?? 0);
    // Gated on the whole series, not this bar: a key and a second colour that
    // appear on one column out of thirty are a legend for a thing nobody can find.
    const overlayShare = hasOverlay && point.value > 0 ? Math.min(1, overlay / point.value) : 0;

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

    // Ticks are counted back from the newest bar, not forward from the oldest.
    // On a 30-day chart at every fourth column, counting forward leaves index 29 —
    // today, the one bar anyone opens the chart to read — permanently unlabelled.
    const showTick = point.tick !== undefined && (points.length - 1 - index) % tickEvery === 0;

    const column: Child[] = [
      element("span", { className: "chart-bar-track", ariaHidden: true }, [fill]),
      showTick
        ? element("span", { className: "chart-bar-tick", text: point.tick, ariaHidden: true })
        : element("span", { className: "chart-bar-tick", ariaHidden: true }),
    ];

    const title =
      overlayShare > 0
        ? `${point.label}: ${format(point.value)}, ${format(overlay)} ${overlayLabel}`
        : `${point.label}: ${format(point.value)}`;
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

  // Padding goes on the left. Empty columns to the right of the newest bar would
  // claim buckets that have not happened yet, which is the same false reading the
  // hourly chart already gets for drawing hours that are still in the future.
  const spacers = Array.from({ length: Math.max(0, MIN_BUCKETS - points.length) }, () =>
    element("div", { className: "chart-bar", ariaHidden: true }, [
      element("span", { className: "chart-bar-track" }),
      element("span", { className: "chart-bar-tick" }),
    ]),
  );

  const description = describeSeries(points, format, caption, overlayLabel, overlayTotal);

  // `role="img"` is a leaf: anything inside it stops being exposed, so with
  // selectable bars the summary has to name a group instead or the bar buttons are
  // announced as unnamed buttons. The static case keeps the picture and puts the
  // numbers in the table below, which is the only reading a screen reader gets.
  const chart = element(
    "div",
    {
      className: "chart",
      role: onSelect ? "group" : "img",
      ariaLabel: description,
    },
    [...spacers, ...bars],
  );

  // An empty table under an empty chart says "table, 0 rows" and nothing else, so
  // the summary carries the "nothing recorded" case on its own.
  const hasData = points.some((point) => point.value > 0);

  return element("figure", { className: "chart-figure" }, [
    chart,
    hasOverlay && chartKey(overlayLabel),
    !onSelect && hasData && valueTable(points, format, caption, overlayLabel, hasOverlay),
  ]);
}

/**
 * The shape of the series in words.
 *
 * The old summary was every non-empty bucket joined with commas, which on the
 * dashboard is a thirty-item run-on that has to be heard in full before the first
 * useful fact arrives. Peak, latest and total are what the picture is read for;
 * the per-bucket numbers are below in a table that can be skipped or navigated.
 *
 * Every clause is a whole message rather than a word glued to a formatted figure.
 * This is the only reading of the primary chart a screen reader gets, and a summary
 * assembled from English fragments is text that is *correct* and read aloud in the
 * wrong language — the failure `applyDocumentLanguage` exists to prevent. The list
 * separator stays a literal comma: it is punctuation between whole clauses, not a
 * word, and every catalogue that needs a different one can carry it inside the
 * clauses themselves.
 */
function describeSeries(
  points: readonly BarPoint[],
  format: (value: number) => string,
  caption: string | undefined,
  overlayLabel: string,
  overlayTotal: number,
): string {
  const lead = caption ? `${caption}. ` : "";
  const used = points.filter((point) => point.value > 0);
  const first = points[0];
  const last = points.at(-1);
  if (used.length === 0 || !first || !last) return `${lead}${t("coreChartSummaryNone")}`;

  const total = used.reduce((sum, point) => sum + point.value, 0);
  const peak = used.reduce((best, point) => (point.value > best.value ? point : best));
  const empty = points.length - used.length;
  const overlay = t("coreChartSummaryOverlay", [format(overlayTotal), overlayLabel]);

  // The hourly chart is down to one bucket just after midnight, where "1 columns
  // from 00:00 to 00:00, highest X at 00:00, latest X at 00:00" says one number
  // four times.
  if (points.length === 1) {
    const one = [t("coreChartSummaryOne", [first.label, format(total)])];
    if (overlayTotal > 0) one.push(overlay);
    return `${lead}${one.join(", ")}.`;
  }

  const parts = [
    t("coreChartSummaryColumns", [String(points.length), first.label, last.label]),
    t("coreChartSummaryTotal", format(total)),
    t("coreChartSummaryHighest", [format(peak.value), peak.label]),
  ];
  // Usually today, and usually also the peak — saying so twice buries the one fact
  // that is not on the screen anywhere else.
  if (peak !== last) parts.push(t("coreChartSummaryLatest", [format(last.value), last.label]));
  if (empty > 0) parts.push(t("coreChartSummaryEmpty", String(empty)));
  if (overlayTotal > 0) parts.push(overlay);
  return `${lead}${parts.join(", ")}.`;
}

/**
 * The key for the two-tone bar.
 *
 * Hidden from assistive technology because `describeSeries` already names the
 * overlay in the summary, and a legend read out as two colour names adds nothing
 * to a description that has the number in it.
 */
function chartKey(overlayLabel: string): HTMLElement {
  return element("p", { className: "chart-key", ariaHidden: true }, [
    element("span", { className: "chart-key-item" }, [
      element("span", { className: "chart-key-swatch" }),
      t("coreChartKeyTotal"),
    ]),
    element("span", { className: "chart-key-item" }, [
      element("span", { className: "chart-key-swatch", dataset: { tone: "overlay" } }),
      overlayLabel,
    ]),
  ]);
}

/**
 * The numbers behind the picture, for a screen reader.
 *
 * The bars are `aria-hidden` inside a `role="img"`, so without this the primary
 * visualisation on both surfaces announces one sentence and no data at all. Empty
 * buckets are left out: the summary says how many there were, and thirty rows of
 * "0 B" is not a reading of the chart.
 */
function valueTable(
  points: readonly BarPoint[],
  format: (value: number) => string,
  caption: string | undefined,
  overlayLabel: string,
  hasOverlay: boolean,
): HTMLElement {
  // Both series shipped today are over time. A bar chart of something else would
  // need this heading to become an option rather than a literal.
  const headings = [
    t("coreChartTableColumnWhen"),
    t("coreChartTableColumnData"),
    ...(hasOverlay ? [overlayLabel] : []),
  ].map((text) => {
    const cell = element("th", { text });
    cell.scope = "col";
    return cell;
  });

  const rows = points
    .filter((point) => point.value > 0)
    .map((point) => {
      const when = element("th", { text: point.label });
      when.scope = "row";
      const cells: Child[] = [when, element("td", { text: format(point.value) })];
      if (hasOverlay) {
        cells.push(element("td", { text: format(Math.max(0, point.overlay ?? 0)) }));
      }
      return element("tr", {}, cells);
    });

  return element("table", { className: "chart-table" }, [
    element("caption", { text: caption ?? t("coreChartTableCaption") }),
    element("thead", {}, [element("tr", {}, headings)]),
    element("tbody", {}, rows),
  ]);
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
  /** Segments below this share of the total are folded into one "Everything else". */
  minShare?: number;
  /**
   * Segments below this absolute value are folded whatever their share.
   *
   * In the same unit as `value`; the default is bytes, because both callers pass
   * bytes. A share test alone cannot fold anything on a quiet day — 68 bytes out
   * of 900 is 7% and earns its own legend row next to a category a thousand times
   * its size.
   */
  minValue?: number;
  caption?: string;
}

/**
 * Reserved key for the folded remainder.
 *
 * `#`-prefixed the way the reserved site buckets are, because `other` is a real
 * `ResourceType` and both callers pass resource types straight through as keys —
 * so the obvious name collides with a genuine category in the same legend.
 */
const FOLD_KEY = "#other";

/**
 * Hue and saturation for that remainder.
 *
 * It was 220, one step from `main_frame`'s 205, so "Everything else" and "Pages"
 * were the same blue in a legend where colour is the only thing tying a row to a
 * band. Desaturated rather than moved to another hue: the fold is the absence of a
 * category, and it should not compete with the real ones for a place on the wheel.
 * Saturation is set inline, on the element that composes the colour — see
 * `.stack-segment` — so the theme still supplies the lightness.
 */
const FOLD_HUE = 214;
const FOLD_SATURATION = "10%";

/**
 * A single horizontal bar split by category, plus a legend.
 *
 * Chosen over a donut because the popup is 420px wide and a donut spends most of
 * that on a hole. A stacked bar also stays readable at four segments and at
 * twelve, which a pie does not.
 */
export function stackedBar(options: StackedBarOptions): HTMLElement {
  const { segments, format, minShare = 0.02, minValue = 50_000, caption } = options;
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  if (total <= 0) {
    return element("div", { className: "stack stack-empty" }, [
      element("p", { className: "stack-note", text: t("coreChartNothingRecorded") }),
    ]);
  }

  const sorted = [...segments].filter((segment) => segment.value > 0).sort((a, b) => b.value - a.value);
  const kept: StackSegment[] = [];
  let folded = 0;
  for (const segment of sorted) {
    // The guard was `kept.length >= 3`, so no threshold could bite until three
    // segments had already been kept — which is how a 68-byte category ended up
    // named in the legend directly above "Everything else 68 B", the same value
    // twice, separated only by where the sort had put it. One kept segment is
    // enough for a remainder to mean anything.
    const tiny = segment.value / total < minShare || segment.value < minValue;
    if (tiny && kept.length >= 1) folded += segment.value;
    else kept.push(segment);
  }

  const fold: StackSegment | null =
    folded > 0
      ? { key: FOLD_KEY, label: t("coreChartEverythingElse"), value: folded, hue: FOLD_HUE }
      : null;
  const shown = fold ? [...kept, fold] : kept;

  const swatchStyle = (segment: StackSegment): Record<string, string> => ({
    "--hue": String(segment.hue ?? hueFor(segment.key)),
    ...(segment === fold ? { "--swatch-sat": FOLD_SATURATION } : {}),
  });

  const track = element(
    "div",
    { className: "stack-track", ariaHidden: true },
    shown.map((segment) =>
      element("span", {
        className: "stack-segment",
        title: `${segment.label}: ${format(segment.value)}`,
        style: {
          width: `${((segment.value / total) * 100).toFixed(3)}%`,
          ...swatchStyle(segment),
        },
      }),
    ),
  );

  const legend = element(
    "ul",
    { className: "stack-legend" },
    shown.map((segment) =>
      element("li", { className: "stack-legend-item" }, [
        element("span", {
          className: "stack-swatch",
          ariaHidden: true,
          style: swatchStyle(segment),
        }),
        element("span", { className: "stack-legend-label", text: segment.label }),
        element("span", { className: "stack-legend-value", text: format(segment.value) }),
      ]),
    ),
  );

  const summary = shown.map((segment) => `${segment.label} ${format(segment.value)}`).join(", ");
  return element(
    "div",
    {
      className: "stack",
      role: "group",
      ariaLabel: `${caption ?? t("coreChartBreakdownLabel")}: ${summary}`,
    },
    [track, legend],
  );
}

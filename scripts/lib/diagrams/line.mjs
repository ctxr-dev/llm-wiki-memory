// Multi-series line chart: one polyline per series against a single shared y
// scale, so a reader can compare series by height without a mental unit
// conversion. Categories are evenly spaced (a band scale, not a numeric axis)
// because the x-axis is always a sequence — weeks, releases, an index — never
// a continuous quantity; a genuinely continuous x belongs on a scatter plot.

import { assemble, esc } from "./text.mjs";
import { plotArea, niceTicks, linearScale, bandScale, VIEW } from "./scale.mjs";
import { yAxis, categoryAxis, axisTitles, legend } from "./axes.mjs";

/**
 * @typedef {Object} LineSeriesSpec
 * @property {string} label
 * @property {number[]} values one value per `xLabels` entry, same length and order
 * @property {boolean} [focal] the one editorially-focal series: drawn in accent,
 *   the only one that gets vertex dots. At most one series may set this.
 * @property {boolean} [area] fill the region under the curve to the baseline;
 *   honoured only when this series is also the focal one.
 */

/**
 * @typedef {Object} LineSpec
 * @property {"line"} kind
 * @property {string} id
 * @property {string} title becomes the SVG's aria-label
 * @property {string} [xLabel]
 * @property {string} [yLabel]
 * @property {string[]} xLabels ordered x-axis categories, shared by every series
 * @property {LineSeriesSpec[]} series 1-5 series sharing one y scale; one may set `focal`
 */

// The non-focal palette is s1..s4 — four colors — so a fifth non-focal series
// would have to repeat a color a reader has already learned to mean something
// else. That is the hard ceiling on series count, not an arbitrary round number.
const MAX_NON_FOCAL = 4;
const DOT_R = 4;

/**
 * Render a multi-series line chart.
 *
 * Vertex dots are drawn as fully-rounded `<rect class="mark focal">` squares
 * rather than `<circle>` elements: `validateSvg` recognises a data mark only
 * through `<rect>` geometry, so a `<circle>` dot would be invisible to every
 * overlap and clipping check while looking identical on the page — clean
 * report, broken chart. `rx`/`ry` equal to half the side renders the rect as a
 * disc, so nothing is lost visually.
 *
 * The focal series draws its polyline and dots LAST regardless of its
 * position in `spec.series`, so the one line a reader should follow is never
 * paved over at a crossing by a muted series drawn afterward.
 * @param {LineSpec} spec
 * @returns {string}
 */
export function renderLine(spec) {
  const xLabels = spec.xLabels;
  const series = spec.series;
  if (!Array.isArray(xLabels) || xLabels.length === 0) {
    throw new Error(`line chart "${spec.id}" needs at least one x label`);
  }
  if (!Array.isArray(series) || series.length === 0) {
    throw new Error(`line chart "${spec.id}" needs at least one series`);
  }
  for (const s of series) {
    if (!Array.isArray(s.values) || s.values.length !== xLabels.length) {
      const got = Array.isArray(s.values) ? s.values.length : 0;
      throw new Error(
        `line chart "${spec.id}" series "${s.label}" has ${got} values but xLabels has ${xLabels.length} entries; a short series would draw a line that stops early with no visible reason`,
      );
    }
    for (const v of s.values) {
      if (!Number.isFinite(v)) {
        throw new Error(`line chart "${spec.id}" series "${s.label}" has a non-finite value`);
      }
    }
  }
  const focalSeries = series.filter((s) => s.focal);
  if (focalSeries.length > 1) {
    throw new Error(
      `line chart "${spec.id}" marks ${focalSeries.length} series focal (${focalSeries.map((s) => s.label).join(", ")}); at most one accent is allowed per chart`,
    );
  }
  const nonFocalCount = series.length - focalSeries.length;
  if (nonFocalCount > MAX_NON_FOCAL) {
    throw new Error(
      `line chart "${spec.id}" has ${nonFocalCount} non-focal series, more than the ${MAX_NON_FOCAL}-color s1..s4 palette can distinguish without repeating a color`,
    );
  }

  const plot = plotArea();
  const allValues = series.flatMap((s) => s.values);
  const yTicks = niceTicks(Math.min(...allValues), Math.max(...allValues));
  const y = linearScale([yTicks.min, yTicks.max], [plot.y2, plot.y]);
  const band = bandScale(xLabels.length, plot.x, plot.w);

  /** @type {string[]} */
  const nonFocalLines = [];
  /** @type {string[]} */
  const dots = [];
  let focalLine = "";
  let bandFill = "";
  let nonFocalIndex = 0;
  /** @type {{ label: string, focal?: boolean, index: number }[]} */
  const legendSeries = [];

  for (const s of series) {
    const points = s.values.map((v, i) => `${band.center(i)},${y(v)}`).join(" ");
    if (s.focal) {
      focalLine = `<polyline class="ser focal" points="${points}"/>`;
      legendSeries.push({ label: s.label, focal: true, index: 0 });
      if (s.area) {
        const left = band.center(0);
        const right = band.center(xLabels.length - 1);
        bandFill = `<polygon class="band" points="${left},${plot.y2} ${points} ${right},${plot.y2}"/>`;
      }
      s.values.forEach((v, i) => {
        const cx = band.center(i);
        const cy = y(v);
        dots.push(
          `<rect class="mark focal" x="${cx - DOT_R}" y="${cy - DOT_R}" width="${DOT_R * 2}" height="${DOT_R * 2}" rx="${DOT_R}" ry="${DOT_R}"/>`,
        );
      });
    } else {
      const cls = `ser s${(nonFocalIndex % MAX_NON_FOCAL) + 1}`;
      nonFocalLines.push(`<polyline class="${cls}" points="${points}"/>`);
      legendSeries.push({ label: s.label, focal: false, index: nonFocalIndex });
      nonFocalIndex += 1;
    }
  }

  return assemble([
    `<svg viewBox="0 0 ${VIEW.w} ${VIEW.h}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="0" y="0" width="${VIEW.w}" height="${VIEW.h}" rx="10"/>`,
    yAxis({ plot, ticks: yTicks.ticks, step: yTicks.step, y }),
    categoryAxis({ plot, band, labels: xLabels }),
    bandFill,
    nonFocalLines.join(""),
    focalLine,
    dots.join(""),
    axisTitles({ plot, xLabel: spec.xLabel, yLabel: spec.yLabel }),
    legend({ plot, series: legendSeries }),
    "</svg>",
  ]);
}

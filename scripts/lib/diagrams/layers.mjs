import { assemble, esc, snap, wrap, MONO_CH } from "./text.mjs";
import { indexTag } from "./shapes.mjs";

/** @typedef {import("./types.mjs").LayerSpec} LayerSpec */

const BAND_H = 64;
const PAD_X = 96;
const WIDTH = 880;

/**
 * Render a layer stack: full-width bands stacked vertically.
 *
 * Every band is the SAME x and width, because unequal widths imply a
 * relationship the stack does not encode. Fills alternate OR stay uniform,
 * chosen once for the whole stack — mixing the two makes the hierarchy
 * invisible, which is the failure this type exists to avoid.
 * @param {LayerSpec} spec
 * @returns {string}
 */
export function renderLayers(spec) {
  const bands = spec.layers;
  if (bands.length === 0) throw new Error("a layer stack needs at least one layer");
  const alternate = spec.fill !== "uniform";
  const top = 28;

  /** @type {string[]} */
  const parts = [];
  bands.forEach((band, i) => {
    const y = top + i * BAND_H;
    const classes = ["lay"];
    if (alternate && i % 2 === 1) classes.push("alt");
    if (band.focal) classes.push("focal");
    parts.push(
      `<rect class="${classes.join(" ")}" x="${PAD_X}" y="${y}" width="${WIDTH}" height="${BAND_H}"/>`,
    );
    if (band.tag) parts.push(indexTag(PAD_X + 18, y + BAND_H / 2 + 3, band.tag));
    parts.push(
      `<text class="lname" x="${PAD_X + 96}" y="${y + BAND_H / 2 + 5}">${esc(band.name)}</text>`,
    );
    if (band.note) {
      // The note is right-aligned against the band's inner edge, so a long note
      // grows leftward into empty space instead of overrunning the silhouette.
      const lines = wrap(band.note, Math.floor((WIDTH - 320) / MONO_CH));
      const baseline = y + BAND_H / 2 + 4 - ((lines.length - 1) * 11) / 2;
      parts.push(
        `<text class="lnote" x="${PAD_X + WIDTH - 18}" y="${baseline}" text-anchor="end">` +
          lines
            .map(
              (l, k) =>
                `<tspan x="${PAD_X + WIDTH - 18}" dy="${k === 0 ? 0 : 11}">${esc(l)}</tspan>`,
            )
            .join("") +
          "</text>",
      );
    }
  });

  const stackH = bands.length * BAND_H;
  if (spec.direction) {
    const midY = top + stackH / 2;
    const up = spec.direction.up !== false;
    const arrowTop = up ? midY - 26 : midY + 26;
    const arrowBottom = up ? midY + 26 : midY - 26;
    const labelX = PAD_X - 52;
    parts.push(
      `<path class="bus" d="M${PAD_X - 40},${arrowBottom} V${arrowTop}"/>`,
      `<path class="dot" d="M${PAD_X - 44},${arrowTop + (up ? 8 : -8)} L${PAD_X - 40},${arrowTop} L${PAD_X - 36},${arrowTop + (up ? 8 : -8)} Z"/>`,
      // Rotated to run WITH the axis it names. Horizontal, a long label
      // ("ABSTRACTION") extends past x=0 and is clipped by the viewBox — which
      // is how this shipped reading "RACTION". Vertical also matches the axis
      // the arrow describes, so it needs no width budget at all.
      `<text class="tag" x="${labelX}" y="${midY}" text-anchor="middle" transform="rotate(-90 ${labelX} ${midY})">${esc(spec.direction.label.toUpperCase())}</text>`,
    );
  }

  const vw = snap(PAD_X * 2 + WIDTH);
  const vh = snap(top * 2 + stackH);
  return assemble([
    `<svg viewBox="0 0 ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="0" y="0" width="${vw}" height="${vh}" rx="10"/>`,
    parts.join(""),
    "</svg>",
  ]);
}

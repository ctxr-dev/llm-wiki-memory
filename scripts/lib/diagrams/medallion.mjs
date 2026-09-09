// Medallion architecture: tiers laid out left-to-right by quality/access level
// of the SAME dataset (raw landing, anonymised, cleaned, aggregated, archive),
// each drawn as a card naming who writes it, with what tool, in what format,
// plus an explicit promotion arrow into every tier after the first.
//
// Card size, arc anchoring and the field-row y-offsets below are the formulas
// from `references/type-medallion.md` §2, so two renders of the same spec stay
// pixel-identical. This input contract has no bottom `paths` row, no per-tier
// `example` field and no per-tier `color` override, so those §2.5/§4 sections
// of the reference do not apply here — everything else does.

import { assemble, esc, snap, wrap, MONO_CH, NAME_CH } from "./text.mjs";
import { edgeClass, markerFor, markers } from "./parts.mjs";

/** @typedef {import("./types.mjs").EdgeKind} EdgeKind */

/**
 * @typedef {Object} MedallionTier
 * @property {string} label tier name, e.g. "Bronze"
 * @property {string} holds what the tier holds, e.g. "raw landing"
 * @property {string} writer who/what writes this tier
 * @property {string} tool the write tool
 * @property {string} format storage format
 * @property {boolean} [focal] exactly one tier across the spec must set this
 */

/**
 * @typedef {Object} MedallionSpec
 * @property {"medallion"} kind
 * @property {string} [id]
 * @property {string} title
 * @property {MedallionTier[]} tiers 3-6 tiers, ordered raw to archive
 */

// §2 constants: fixed regardless of tier count, so a 5-tier medallion is
// always 1040x476 (the reference's own worked example) and a 3-tier one is
// narrower by exactly two tier strides.
const TIER_W = 172;
const TIER_H = 380;
const TIER_GAP = 16;
const LEFT_PAD = 16;
const RIGHT_PAD = 100;
const ARC_BAND_H = 80;
const BOTTOM_PAD = 16;
const FIELD_INSET = 16;
const FIELD_W = TIER_W - FIELD_INSET * 2;

/**
 * The card border treatment from §2.3, keyed off position since this input
 * contract carries no per-tier `style` override: tier 0 defaults to `outer`,
 * the last tier to `cold`, and the focal tier always overrides either.
 * @param {number} i @param {number} last @param {boolean} focal
 * @returns {string}
 */
function cardClass(i, last, focal) {
  if (focal) return "nb focal";
  if (i === 0) return "nb store"; // outer: muted stroke, solid, white fill
  if (i === last) return "nb ghost"; // cold/archive: dashed fog
  return "nb"; // default: white fill, ink stroke
}

/**
 * A promotion arrow's style per §2.4/§4.3: an arrow landing on the focal tier
 * is always accented, an arrow landing on the (non-focal) archive tier is the
 * dashed "lifecycle" style, and every other hop is a plain solid arrow.
 * @param {boolean} intoFocal @param {boolean} intoCold
 * @returns {EdgeKind}
 */
function arcKind(intoFocal, intoCold) {
  if (intoFocal) return "focal";
  if (intoCold) return "async";
  return "sync";
}

/**
 * Render a medallion data-tier architecture to inline SVG.
 * @param {MedallionSpec} spec
 * @returns {string}
 */
export function renderMedallion(spec) {
  const tiers = spec.tiers ?? [];
  if (tiers.length < 3 || tiers.length > 6) {
    throw new Error(`a medallion needs 3-6 tiers, got ${tiers.length}`);
  }
  const focalTiers = tiers.filter((t) => t.focal);
  if (focalTiers.length !== 1) {
    const named = focalTiers.map((t) => t.label).join(", ");
    throw new Error(
      `a medallion needs exactly one focal tier, got ${focalTiers.length}${named ? ` (${named})` : ""}`,
    );
  }
  const id = spec.id ?? "medallion";
  const n = tiers.length;
  const last = n - 1;
  const focalIndex = tiers.findIndex((t) => t.focal);

  /** @param {number} i @returns {number} */
  const tierX = (i) => LEFT_PAD + i * (TIER_W + TIER_GAP);
  /** @param {number} i @returns {number} */
  const tierCx = (i) => tierX(i) + TIER_W / 2;
  const tierY = ARC_BAND_H;

  const vw = LEFT_PAD + n * TIER_W + (n - 1) * TIER_GAP + RIGHT_PAD;
  const vh = ARC_BAND_H + TIER_H + BOTTOM_PAD;

  // §3 z-order: every promotion arc draws before any tier card, so a card's
  // opaque fill masks the arc's landing stub rather than riding on top of it.
  /** @type {string[]} */
  const arcs = [];
  for (let i = 0; i < last; i += 1) {
    const kind = arcKind(i + 1 === focalIndex, i + 1 === last && focalIndex !== last);
    const x0 = tierCx(i);
    const x1 = tierCx(i + 1);
    // Cubic Bézier anchored at each tier's top-center, control points directly
    // above at y=0: the curve peaks at y=20 and never leaves the 80px arc band
    // above the tier row, so it cannot cut through an unrelated tier card.
    arcs.push(
      `<path class="${edgeClass(kind)}" d="M${x0},${tierY} C${x0},0 ${x1},0 ${x1},${tierY}" marker-end="url(#${markerFor(id, kind)})"/>`,
    );
  }

  /** @type {string[]} */
  const cards = [];
  tiers.forEach((tier, i) => {
    const x = tierX(i);
    const cx = tierCx(i);
    const focal = i === focalIndex;
    cards.push(
      `<rect class="${cardClass(i, last, focal)}" x="${x}" y="${tierY}" width="${TIER_W}" height="${TIER_H}" rx="6"/>`,
    );

    const titleLines = wrap(tier.label, Math.floor((TIER_W - 32) / NAME_CH));
    cards.push(
      `<text class="nn" x="${cx}" y="106" text-anchor="middle">` +
        titleLines
          .map((l, k) => `<tspan x="${cx}" dy="${k === 0 ? 0 : 13}">${esc(l)}</tspan>`)
          .join("") +
        "</text>",
    );

    // The focal tier's accent treatment cascades to its bucket/holds text
    // only — field values below stay muted regardless of focal (§2.3 note).
    const holdsLines = wrap(tier.holds, Math.floor(FIELD_W / MONO_CH));
    cards.push(
      `<text class="${focal ? "vlab focal" : "vlab"}" x="${cx}" y="144" text-anchor="middle">` +
        holdsLines
          .map((l, k) => `<tspan x="${cx}" dy="${k === 0 ? 0 : 11}">${esc(l)}</tspan>`)
          .join("") +
        "</text>",
    );

    // Field rows in the order §2.2 fixes: tool, then format, then writer,
    // each 40px apart starting at y=180 — independent of key order in `tier`.
    const fields = [
      { caption: "Tool", y: 180, value: tier.tool },
      { caption: "Format", y: 220, value: tier.format },
      { caption: "Writer", y: 260, value: tier.writer },
    ];
    for (const field of fields) {
      cards.push(
        `<text class="clab" x="${x + FIELD_INSET}" y="${field.y}">${field.caption}</text>`,
      );
      const lines = wrap(field.value, Math.floor(FIELD_W / MONO_CH));
      cards.push(
        `<text class="ns" x="${x + FIELD_INSET}" y="${field.y + 16}">` +
          lines
            .map(
              (l, k) => `<tspan x="${x + FIELD_INSET}" dy="${k === 0 ? 0 : 11}">${esc(l)}</tspan>`,
            )
            .join("") +
          "</text>",
      );
    }
  });

  return assemble([
    `<svg viewBox="0 0 ${snap(vw)} ${snap(vh)}" role="img" aria-label="${esc(spec.title)}">`,
    markers(id),
    `<rect class="bg" x="0" y="0" width="${snap(vw)}" height="${snap(vh)}" rx="10"/>`,
    arcs.join(""),
    cards.join(""),
    "</svg>",
  ]);
}

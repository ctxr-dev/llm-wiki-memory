// Ishikawa (fishbone) root-cause diagram: a spine ending in an effect box, with
// angled category bones alternating above and below it, each carrying its
// causes as short ticks along its length.
//
// Bones are plain structural connectors (`bus`), not directed edges: nothing
// "flows" along a bone the way it does along the spine into the effect, so an
// arrowhead there would claim a causal direction the diagram does not intend.
// Cause ticks sit a computed distance short of the category tag at the bone's
// tip — using the box/ray exit-distance idea from the loop-diagram reference,
// `min(halfW / |ux|, halfH / |uy|)` — so no tick or its label can ever land on
// top of that tag, regardless of how long the category label makes it.

import { assemble, esc, snap, wrap, NAME_CH, MONO_CH } from "./text.mjs";
import { markers, markerFor, edgeClass } from "./parts.mjs";

/**
 * @typedef {Object} FishboneCategory
 * @property {string} label
 * @property {string[]} causes
 * @property {boolean} [focal]
 */

/**
 * @typedef {Object} FishboneSpec
 * @property {"fishbone"} kind
 * @property {string} [id]
 * @property {string} title
 * @property {string} effect
 * @property {FishboneCategory[]} categories
 */

const BONE_ANGLE = Math.PI / 3; // 60 degrees off the spine, per the type reference
const BONE_LEN = 160;
const BONE_DX = -BONE_LEN * Math.cos(BONE_ANGLE);
const BONE_DY = BONE_LEN * Math.sin(BONE_ANGLE);
const BONE_PITCH = 170;
const TAIL_STUB = 50;
const EFFECT_GAP = 70;
const EFFECT_W = 210;
const TICK_LEN = 32;
const TICK_GAP = 4;
const TAG_PAD_X = 12;
const TAG_LINE_H = 14;
const TAG_BASE_H = 26;
const MIN_FRAC = 0.18;
const TICK_MARGIN = 12;

/**
 * Distance from a box's center to its edge along a direction, so a point
 * placed that far out along `(ux,uy)` sits exactly on the box's boundary.
 * @param {number} halfW @param {number} halfH @param {number} ux @param {number} uy
 * @returns {number}
 */
function boxExitDistance(halfW, halfH, ux, uy) {
  const dx = Math.abs(ux) > 1e-6 ? halfW / Math.abs(ux) : Infinity;
  const dy = Math.abs(uy) > 1e-6 ? halfH / Math.abs(uy) : Infinity;
  return Math.min(dx, dy);
}

/**
 * Evenly spaced fractions along a bone, clear of the spine at 0 and the
 * category tag at 1.
 * @param {number} k @param {number} maxFrac
 * @returns {number[]}
 */
function tickFractions(k, maxFrac) {
  /** @type {number[]} */
  const out = [];
  for (let j = 0; j < k; j += 1) {
    out.push(MIN_FRAC + ((j + 1) / (k + 1)) * (maxFrac - MIN_FRAC));
  }
  return out;
}

/**
 * Render an Ishikawa root-cause diagram to inline SVG.
 * @param {FishboneSpec} spec
 * @returns {string}
 */
export function renderFishbone(spec) {
  const id = spec.id ?? "fishbone";
  const categories = spec.categories ?? [];
  if (categories.length < 2 || categories.length > 6) {
    throw new Error(`a fishbone needs 2-6 categories, got ${categories.length}`);
  }
  for (const cat of categories) {
    const count = cat.causes?.length ?? 0;
    if (count < 1 || count > 3) {
      throw new Error(`category "${cat.label}" has ${count} causes, expected 1-3`);
    }
  }
  const focalCats = categories.filter((c) => c.focal);
  if (focalCats.length > 1) {
    throw new Error(
      `a fishbone allows one focal category, got ${focalCats.length}: ${focalCats.map((c) => c.label).join(", ")}`,
    );
  }

  const tags = categories.map((cat) => {
    const lines = wrap(cat.label, 16);
    const w = snap(Math.max(...lines.map((l) => l.length)) * NAME_CH + TAG_PAD_X * 2);
    const h = snap(TAG_BASE_H + (lines.length - 1) * TAG_LINE_H);
    return { lines, w, h };
  });
  // The largest tag governs clearance for every bone uniformly: a smaller tag
  // elsewhere is then merely more conservative than it strictly needs to be,
  // never at risk of a tick landing on it.
  const maxHalfW = Math.max(...tags.map((t) => t.w)) / 2;
  const maxHalfH = Math.max(...tags.map((t) => t.h)) / 2;
  const clearance =
    boxExitDistance(maxHalfW, maxHalfH, BONE_DX / BONE_LEN, BONE_DY / BONE_LEN) + TICK_MARGIN;
  const maxFrac = 1 - clearance / BONE_LEN;
  if (maxFrac <= MIN_FRAC + 0.05) {
    throw new Error("a fishbone category label is too wide for its bone to carry any causes");
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  /** @param {number} x @param {number} y @param {number} [w] @param {number} [h] */
  const track = (x, y, w = 0, h = 0) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };

  /** @type {string[]} */
  const bones = [];
  /** @type {string[]} */
  const tagMarks = [];
  /** @type {string[]} */
  const causeMarks = [];

  categories.forEach((cat, i) => {
    const above = i % 2 === 0;
    const ax = i * BONE_PITCH;
    const dy = above ? -BONE_DY : BONE_DY;
    const tipX = ax + BONE_DX;
    const { lines, w: tagW, h: tagH } = tags[i];

    bones.push(
      `<line class="bus" x1="${ax}" y1="0" x2="${Math.round(tipX)}" y2="${Math.round(dy)}"/>`,
    );

    const tagX = tipX - tagW / 2;
    const tagY = dy - tagH / 2;
    track(tagX, tagY, tagW, tagH);
    const cx = Math.round(tipX);
    const textTop = tagY + (tagH - lines.length * TAG_LINE_H) / 2 + 10;
    const cls = cat.focal ? "nb focal" : "nb";
    const name = lines
      .map((l, k) => `<tspan x="${cx}" dy="${k === 0 ? 0 : TAG_LINE_H}">${esc(l)}</tspan>`)
      .join("");
    tagMarks.push(
      `<rect class="${cls}" x="${Math.round(tagX)}" y="${Math.round(tagY)}" width="${tagW}" height="${tagH}" rx="4"/>` +
        `<text class="nn" x="${cx}" y="${Math.round(textTop)}" text-anchor="middle">${name}</text>`,
    );

    const causes = cat.causes ?? [];
    const fracs = tickFractions(causes.length, maxFrac);
    causes.forEach((cause, ci) => {
      const frac = fracs[ci];
      const px = ax + BONE_DX * frac;
      const py = dy * frac;
      const tickEndX = px - TICK_LEN;
      track(tickEndX, py - 5, TICK_LEN, 10);
      const labelX = tickEndX - TICK_GAP;
      const labelW = String(cause).length * MONO_CH;
      track(labelX - labelW, py - 6, labelW, 10);
      causeMarks.push(
        `<line class="hair" x1="${Math.round(px)}" y1="${Math.round(py)}" x2="${Math.round(tickEndX)}" y2="${Math.round(py)}"/>` +
          `<text class="ns" x="${Math.round(labelX)}" y="${Math.round(py + 3)}" text-anchor="end">${esc(cause)}</text>`,
      );
    });
  });

  const lastX = (categories.length - 1) * BONE_PITCH;
  const effectLines = wrap(spec.effect, Math.floor((EFFECT_W - 28) / NAME_CH));
  const effectH = snap(24 + effectLines.length * 15);
  const effectX = lastX + EFFECT_GAP;
  const effectY = -effectH / 2;
  track(effectX, effectY, EFFECT_W, effectH);

  const spineStart = -TAIL_STUB;
  track(spineStart, 0);

  const spine = `<path class="${edgeClass("sync")}" d="M${spineStart},0 H${effectX}" marker-end="url(#${markerFor(id, "sync")})"/>`;

  const effectCx = effectX + EFFECT_W / 2;
  const effectTextTop = effectY + (effectH - effectLines.length * 15) / 2 + 11;
  const effectName = effectLines
    .map((l, k) => `<tspan x="${effectCx}" dy="${k === 0 ? 0 : 15}">${esc(l)}</tspan>`)
    .join("");
  const effectBox =
    `<rect class="nb focal" x="${effectX}" y="${Math.round(effectY)}" width="${EFFECT_W}" height="${effectH}" rx="6"/>` +
    `<text class="nn" x="${effectCx}" y="${Math.round(effectTextTop)}" text-anchor="middle">${effectName}</text>`;

  const pad = 40;
  const vx = snap(minX - pad);
  const vy = snap(minY - pad);
  const vw = snap(maxX + pad - vx);
  const vh = snap(maxY + pad - vy);

  return assemble([
    `<svg viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    markers(id),
    `<rect class="bg" x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="10"/>`,
    bones.join(""),
    spine,
    tagMarks.join(""),
    causeMarks.join(""),
    effectBox,
    "</svg>",
  ]);
}

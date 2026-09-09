// A Wardley map: a value chain plotted by visibility to the user (y) against
// evolution from genesis to commodity (x), with straight dependency links
// between components. Built on the shared cartesian plot area and
// `bandScale` for the four evolution bands, rather than re-deriving "divide a
// span into four" by hand.
//
// Components are drawn as fully-rounded `<rect>` marks, the same trick
// `scatter.mjs` uses for its points: a `<rect>` is the only shape
// `validate.mjs` checks for overlap and label collision. Links are plain
// `<line>`, never `<path>`: `validate.mjs` only understands the `M`/`H`/`V`/
// `Q`/`C` commands its own renderers emit, and a diagonal `L` segment parses
// into a single point, silently vanishing from every path-based check instead
// of failing loudly. `<line>` sidesteps that trap and is the honest primitive
// for a straight run anyway.

import { assemble, esc, snap, wrap, MONO_CH, NAME_CH } from "./text.mjs";
import { plotArea, linearScale, bandScale, VIEW } from "./scale.mjs";
import { place } from "./geometry.mjs";

/** @typedef {import("./types.mjs").Rect} Rect */

/**
 * @typedef {Object} WardleyComponent
 * @property {string} id referenced by `links`
 * @property {string} label
 * @property {number} visibility 0 (invisible) .. 1 (visible to the user)
 * @property {number} evolution 0 (genesis) .. 1 (commodity)
 * @property {boolean} [focal] at most one component per map may set this
 */

/**
 * @typedef {Object} WardleyLink
 * @property {string} from component id
 * @property {string} to component id
 */

/**
 * @typedef {Object} WardleySpec
 * @property {"wardley"} kind
 * @property {string} id
 * @property {string} title
 * @property {WardleyComponent[]} components 1-9 components
 * @property {WardleyLink[]} links 1-12 links; every component needs at least one
 */

/** @typedef {{ c: WardleyComponent, cx: number, cy: number, r: number }} LaidComponent */

const R = 6;
const R_FOCAL = 8;
const MAX_COMPONENTS = 9;
const MAX_LINKS = 12;
const LABEL_GAP = 12;
const LABEL_MAX_CHARS = 18;
const PAD = 16;
const EVOLUTION_BANDS = ["genesis", "custom-built", "product", "commodity"];
const VISIBLE_LABEL_LINES = ["visible to", "the user"];
const INVISIBLE_LABEL = "invisible";

/**
 * Validate the component list and return an id lookup.
 * @param {WardleySpec} spec
 * @returns {Map<string, WardleyComponent>}
 */
function validateComponents(spec) {
  const components = spec.components;
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error(`wardley map "${spec.id}" has no components`);
  }
  if (components.length > MAX_COMPONENTS) {
    throw new Error(
      `wardley map "${spec.id}" has ${components.length} components; at most ${MAX_COMPONENTS} keeps the chain legible`,
    );
  }
  /** @type {Map<string, WardleyComponent>} */
  const byId = new Map();
  for (const c of components) {
    if (byId.has(c.id))
      throw new Error(`wardley map "${spec.id}" has a duplicate component id "${c.id}"`);
    if (!Number.isFinite(c.visibility) || c.visibility < 0 || c.visibility > 1) {
      throw new Error(`wardley component "${c.id}" needs visibility in 0..1, got ${c.visibility}`);
    }
    if (!Number.isFinite(c.evolution) || c.evolution < 0 || c.evolution > 1) {
      throw new Error(`wardley component "${c.id}" needs evolution in 0..1, got ${c.evolution}`);
    }
    byId.set(c.id, c);
  }
  const focalCount = components.filter((c) => c.focal).length;
  if (focalCount > 1) {
    throw new Error(
      `wardley map "${spec.id}" has ${focalCount} focal components; at most one is allowed`,
    );
  }
  return byId;
}

/**
 * Validate the link list against the known component ids, and require every
 * component to be wired into the chain: an unlinked component "isn't part of
 * the chain" per the type's own anti-pattern, so it fails loudly here rather
 * than rendering a silently-disconnected dot.
 * @param {WardleySpec} spec
 * @param {Map<string, WardleyComponent>} byId
 * @returns {void}
 */
function validateLinks(spec, byId) {
  const links = spec.links;
  if (!Array.isArray(links) || links.length === 0) {
    throw new Error(`wardley map "${spec.id}" has no dependency links`);
  }
  if (links.length > MAX_LINKS) {
    throw new Error(
      `wardley map "${spec.id}" has ${links.length} links; at most ${MAX_LINKS} keeps the chain legible`,
    );
  }
  /** @type {Set<string>} */
  const linked = new Set();
  links.forEach((link, i) => {
    if (!byId.has(link.from)) {
      throw new Error(
        `wardley map "${spec.id}" link ${i} references unknown component "${link.from}"`,
      );
    }
    if (!byId.has(link.to)) {
      throw new Error(
        `wardley map "${spec.id}" link ${i} references unknown component "${link.to}"`,
      );
    }
    if (link.from === link.to) {
      throw new Error(`wardley map "${spec.id}" link ${i} connects "${link.from}" to itself`);
    }
    linked.add(link.from);
    linked.add(link.to);
  });
  for (const c of spec.components) {
    if (!linked.has(c.id)) {
      throw new Error(
        `wardley component "${c.id}" has no dependency link; wire it in or remove it`,
      );
    }
  }
}

/**
 * Render a Wardley map: components positioned by visibility and evolution,
 * connected by straight dependency links drawn before the components so
 * every dot sits on top of the lines meeting it.
 * @param {WardleySpec} spec
 * @returns {string}
 */
export function renderWardley(spec) {
  const byId = validateComponents(spec);
  validateLinks(spec, byId);

  const plot = plotArea();
  const evoX = linearScale([0, 1], [plot.x, plot.x2]);
  const visY = linearScale([0, 1], [plot.y2, plot.y]);
  const band = bandScale(EVOLUTION_BANDS.length, plot.x, plot.w);

  /** @type {{ minX: number, minY: number, maxX: number, maxY: number }} */
  const bounds = { minX: plot.x, minY: plot.y, maxX: plot.x2, maxY: plot.y2 };
  /** @param {number} tx @param {number} ty @param {number} tw @param {number} th @returns {void} */
  const track = (tx, ty, tw, th) => {
    bounds.minX = Math.min(bounds.minX, tx);
    bounds.minY = Math.min(bounds.minY, ty);
    bounds.maxX = Math.max(bounds.maxX, tx + tw);
    bounds.maxY = Math.max(bounds.maxY, ty + th);
  };

  /** @type {string[]} */
  const furniture = [
    `<line class="axis" x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y2}"/>`,
    `<line class="axis" x1="${plot.x}" y1="${plot.y2}" x2="${plot.x2}" y2="${plot.y2}"/>`,
  ];
  for (let i = 1; i < EVOLUTION_BANDS.length; i += 1) {
    const sx = plot.x + (plot.w * i) / EVOLUTION_BANDS.length;
    furniture.push(
      `<line class="grid" x1="${sx}" y1="${plot.y}" x2="${sx}" y2="${plot.y2}" stroke-dasharray="4 4"/>`,
    );
  }
  EVOLUTION_BANDS.forEach((name, i) => {
    const bx = band.center(i);
    const word = name.toUpperCase();
    furniture.push(
      `<text class="tick" x="${bx}" y="${plot.y2 + 16}" text-anchor="middle">${esc(word)}</text>`,
    );
    track(bx - (word.length * MONO_CH) / 2, plot.y2 + 7, word.length * MONO_CH, 10);
  });
  // Stacked, unrotated lines flanking the axis endpoints: the type's own
  // anti-pattern forbids `writing-mode` to rotate this label vertically.
  VISIBLE_LABEL_LINES.forEach((line, i) => {
    const ty = plot.y - 4 - (VISIBLE_LABEL_LINES.length - 1 - i) * 12;
    const word = line.toUpperCase();
    furniture.push(
      `<text class="atitle" x="${plot.x - 8}" y="${ty}" text-anchor="end">${esc(word)}</text>`,
    );
    track(plot.x - 8 - word.length * MONO_CH, ty - 9, word.length * MONO_CH, 11);
  });
  const invisibleWord = INVISIBLE_LABEL.toUpperCase();
  furniture.push(
    `<text class="atitle" x="${plot.x - 8}" y="${plot.y2 + 12}" text-anchor="end">${esc(invisibleWord)}</text>`,
  );
  track(
    plot.x - 8 - invisibleWord.length * MONO_CH,
    plot.y2 + 3,
    invisibleWord.length * MONO_CH,
    11,
  );

  /** @type {LaidComponent[]} */
  const laid = spec.components.map((c) => ({
    c,
    cx: evoX(c.evolution),
    cy: visY(c.visibility),
    r: c.focal ? R_FOCAL : R,
  }));
  /** @type {Map<string, LaidComponent>} */
  const laidById = new Map(laid.map((p) => [p.c.id, p]));

  /** @type {string[]} */
  const linkLines = spec.links
    .map((link) => {
      const a = laidById.get(link.from);
      const b = laidById.get(link.to);
      if (!a || !b) return undefined;
      return `<line class="e" x1="${a.cx}" y1="${a.cy}" x2="${b.cx}" y2="${b.cy}"/>`;
    })
    .filter((line) => line !== undefined);

  /** @type {Rect[]} occupied boxes for label placement */
  const occupied = laid.map((p) => ({ x: p.cx - p.r, y: p.cy - p.r, w: p.r * 2, h: p.r * 2 }));
  for (const p of laid) track(p.cx - p.r, p.cy - p.r, p.r * 2, p.r * 2);

  /** @type {string[]} */
  const dots = laid.map(
    (p) =>
      `<rect class="${p.c.focal ? "mark focal" : "mark"}" x="${p.cx - p.r}" y="${p.cy - p.r}" width="${p.r * 2}" height="${p.r * 2}" rx="${p.r}" ry="${p.r}"/>`,
  );

  /** @type {string[]} */
  const labels = [];
  for (const p of laid) {
    const lines = wrap(p.c.label, LABEL_MAX_CHARS);
    const w = Math.max(...lines.map((l) => l.length)) * NAME_CH + 10;
    const h = lines.length * 13 + 6;
    // Anchored above the dot; `place` slides it (vertically first) off any
    // box it would otherwise sit on.
    const rect = place(p.cx, p.cy - p.r - LABEL_GAP - h / 2, w, h, occupied, "y");
    occupied.push(rect);
    const tx = rect.x + w / 2;
    const tspans = lines
      .map((l, i) => `<tspan x="${tx}" dy="${i === 0 ? 0 : 13}">${esc(l)}</tspan>`)
      .join("");
    labels.push(
      `<rect class="emask" x="${rect.x}" y="${rect.y}" width="${w}" height="${h}" rx="3"/>`,
      `<text class="nn" x="${tx}" y="${rect.y + 10}" text-anchor="middle">${tspans}</text>`,
    );
    track(rect.x, rect.y, w, h);
  }

  const vx = snap(Math.min(0, bounds.minX - PAD));
  const vy = snap(Math.min(0, bounds.minY - PAD));
  const vw = snap(Math.max(VIEW.w, bounds.maxX + PAD) - vx);
  const vh = snap(Math.max(VIEW.h, bounds.maxY + PAD) - vy);

  return assemble([
    `<svg viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="10"/>`,
    furniture.join(""),
    linkLines.join(""),
    dots.join(""),
    labels.join(""),
    "</svg>",
  ]);
}

// The entity box: its measured size, its grid placement, and its field rows.
// Split from `er.mjs` purely to keep both files under the 300-line gate; the
// seam is the natural one, since nothing here knows about relationships.

import { esc, snap, wrap, MONO_CH, NAME_CH } from "./text.mjs";
import { indexTag, silhouette } from "./shapes.mjs";

/**
 * @typedef {Object} ErField
 * @property {string} name
 * @property {string} [type]
 * @property {"pk" | "fk"} [key]
 */

/**
 * @typedef {Object} ErEntity
 * @property {string} id
 * @property {string} label
 * @property {number} col
 * @property {number} row
 * @property {import("./types.mjs").NodeKind} [kind]
 * @property {ErField[]} [fields]
 */

/**
 * @typedef {Object} EntityBox
 * A measured and placed entity. Deliberately shaped like the shared `Box` so the
 * routing helpers in `geometry.mjs` and `routing.mjs` apply unmodified.
 * @property {ErEntity} node
 * @property {string[]} lines
 * @property {string[]} subLines
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {number} cx
 * @property {number} cy
 * @property {number} headerH
 */

const BOX = { w: 220, padX: 12 };
const GRID = { colGap: 100, rowGap: 56, pad: 30 };
const HEADER = { eyebrowDy: 13, nameDy: 29, lineH: 15, gap: 11 };
const ROW = { h: 17, baseline: 12, topPad: 8, bottomPad: 9, emptyPad: 10 };
const FIELD = { markerW: 15, typeGap: 10, typeMax: 14 };
const LANE_MARGIN = 26;
const FIT_PAD = 18;

/** @param {number} nameLineCount @returns {number} */
function headerHeight(nameLineCount) {
  return snap(HEADER.nameDy + (nameLineCount - 1) * HEADER.lineH + HEADER.gap);
}

/**
 * Clip text to `maxChars` with a trailing ellipsis — a field row is one
 * fixed-height line, so unlike `wrap` it cannot absorb overflow with a second line.
 * @param {string} value @param {number} maxChars
 * @returns {string}
 */
function truncate(value, maxChars) {
  if (value.length <= maxChars) return value;
  return maxChars <= 1 ? value.slice(0, 1) : `${value.slice(0, maxChars - 1)}\u2026`;
}

/**
 * Measure and place every entity on its col/row grid, two passes as in
 * `layout()`. Entities keep their own natural height — sharing a row aligns
 * tops, it never pads a shorter entity up to match a taller sibling.
 * @param {ErEntity[]} entities
 * @returns {Map<string, EntityBox>}
 */
export function layoutEntities(entities) {
  /** @type {Map<string, { lines: string[], headerH: number, h: number }>} */
  const measured = new Map();
  /** @type {number[]} */
  const rowHeights = [];
  for (const entity of entities) {
    const lines = wrap(entity.label, Math.floor((BOX.w - BOX.padX * 2) / NAME_CH));
    const headerH = headerHeight(lines.length);
    const rows = (entity.fields ?? []).length;
    const bodyH = rows > 0 ? ROW.topPad + rows * ROW.h + ROW.bottomPad : ROW.emptyPad;
    const h = snap(headerH + bodyH);
    measured.set(entity.id, { lines, headerH, h });
    rowHeights[entity.row] = Math.max(rowHeights[entity.row] ?? 0, h);
  }

  /** @type {number[]} */
  const rowTops = [];
  let cursor = GRID.pad;
  for (let r = 0; r < rowHeights.length; r += 1) {
    rowTops[r] = cursor;
    cursor += (rowHeights[r] ?? 0) + GRID.rowGap;
  }

  /** @type {Map<string, EntityBox>} */
  const boxes = new Map();
  for (const entity of entities) {
    const m = measured.get(entity.id);
    if (!m) continue;
    const x = GRID.pad + entity.col * (BOX.w + GRID.colGap);
    const y = rowTops[entity.row] ?? GRID.pad;
    boxes.set(entity.id, {
      node: entity,
      lines: m.lines,
      subLines: [],
      headerH: m.headerH,
      x,
      y,
      w: BOX.w,
      h: m.h,
      cx: x + BOX.w / 2,
      cy: y + m.h / 2,
    });
  }
  return boxes;
}

/**
 * One field row: an optional PK/FK marker, the name, and its right-aligned
 * type — both truncated to fit so a long identifier clips, not overruns.
 * @param {EntityBox} box @param {ErField} field @param {number} i row index
 * @returns {string}
 */
function renderField(box, field, i) {
  const baseline = box.y + box.headerH + ROW.topPad + i * ROW.h + ROW.baseline;
  const hasKey = field.key !== undefined;
  const markerX = box.x + BOX.padX;
  const nameX = markerX + (hasKey ? FIELD.markerW : 0);
  const typeText = field.type ? truncate(field.type, FIELD.typeMax) : "";
  const typeW = typeText ? typeText.length * MONO_CH + FIELD.typeGap : 0;
  const nameBudget = box.w - BOX.padX * 2 - (hasKey ? FIELD.markerW : 0) - typeW;
  const nameText = truncate(field.name, Math.max(3, Math.floor(nameBudget / MONO_CH)));
  const marker = hasKey ? indexTag(markerX, baseline, field.key === "pk" ? "#" : "\u2192") : "";
  const name = `<text class="ns" x="${nameX}" y="${baseline}">${esc(nameText)}</text>`;
  const type = typeText
    ? `<text class="ns" x="${box.x + box.w - BOX.padX}" y="${baseline}" text-anchor="end">${esc(typeText)}</text>`
    : "";
  return marker + name + type;
}

/**
 * @param {EntityBox} box
 * @returns {string}
 */
export function renderEntity(box) {
  const { node: entity, lines, headerH } = box;
  const kind = entity.kind ?? "backend";
  const nameX = box.x + BOX.padX;
  const nameTspans = lines
    .map((line, i) => `<tspan x="${nameX}" dy="${i === 0 ? 0 : HEADER.lineH}">${esc(line)}</tspan>`)
    .join("");
  const parts = [
    silhouette(box, `nb ${kind}`),
    indexTag(nameX, box.y + HEADER.eyebrowDy, "entity"),
    `<text class="nn" x="${nameX}" y="${box.y + HEADER.nameDy}">${nameTspans}</text>`,
  ];
  const fields = entity.fields ?? [];
  if (fields.length > 0) {
    const hairY = box.y + headerH;
    parts.push(
      `<line class="hair" x1="${box.x}" y1="${hairY}" x2="${box.x + box.w}" y2="${hairY}"/>`,
    );
    fields.forEach((field, i) => parts.push(renderField(box, field, i)));
  }
  return parts.join("");
}

export { LANE_MARGIN, FIT_PAD };

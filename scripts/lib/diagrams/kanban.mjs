import { assemble, esc, snap, wrap, NAME_CH, MONO_CH } from "./text.mjs";

/**
 * @typedef {"focal" | "store" | "external" | "ghost"} KanbanCardKind
 * Reuses the shared node-treatment vocabulary rather than inventing board-only
 * states: `focal` calls out one card worth a reader's attention, `store` reads
 * as settled/archival work, `external` reads as blocked on something outside
 * the team, `ghost` reads as a placeholder slot. Omit for the default card.
 */

/**
 * @typedef {Object} KanbanCard
 * @property {string} label
 * @property {string} [sub] mono sub-line, e.g. "TICKET-42 · nadia"
 * @property {KanbanCardKind} [kind]
 */

/**
 * @typedef {Object} KanbanColumn
 * @property {string} id
 * @property {string} label
 * @property {number} [wip] WIP limit shown as "n/limit"; omit for a queue or
 *   terminal column, which carries no limit and shows a bare count instead
 * @property {KanbanCard[]} cards
 */

/**
 * @typedef {Object} KanbanSpec
 * @property {"kanban"} kind
 * @property {string} id
 * @property {string} title
 * @property {KanbanColumn[]} columns
 */

/** @typedef {{ card: KanbanCard, lines: string[], subLines: string[], h: number }} LaidCard */

const PAD = 28;
const COL_W = 224;
const GUTTER = 28;
const HEADER_H = 28;
const HEADER_GAP = 14;
const CARD_PAD_X = 16;
const CARD_W = COL_W - CARD_PAD_X * 2;
const TEXT_PAD_X = 10;
const CARD_GAP = 12;
const CARD_INNER_Y = 12;
const CARD_MIN_H = 44;
const NAME_LINE_H = 14;
const SUB_LINE_H = 11;
const BOTTOM_PAD = 16;

const ALLOWED_KINDS = new Set(["focal", "store", "external", "ghost"]);

/**
 * Render a kanban board: a state census with no connectors at all. Adding an
 * edge here is always a sign the diagram wants swimlane or process instead.
 * @param {KanbanSpec} spec
 * @returns {string}
 */
export function renderKanban(spec) {
  const columns = spec.columns;
  if (columns.length === 0) throw new Error("a kanban board needs at least one column");
  const seenIds = new Set();
  for (const column of columns) {
    if (seenIds.has(column.id)) throw new Error(`duplicate kanban column id: ${column.id}`);
    seenIds.add(column.id);
    for (const card of column.cards) {
      if (card.kind !== undefined && !ALLOWED_KINDS.has(card.kind)) {
        throw new Error(
          `unknown card kind "${card.kind}" on card "${card.label}" in column "${column.id}"`,
        );
      }
    }
  }

  const nameMax = Math.floor((CARD_W - TEXT_PAD_X * 2) / NAME_CH);
  const subMax = Math.floor((CARD_W - TEXT_PAD_X * 2) / MONO_CH);

  /**
   * Card height derives from wrapped content, so a two-line title with a sub
   * line and a bare one-word title never share a height by coincidence.
   * @param {KanbanCard} card
   * @returns {LaidCard}
   */
  const layCard = (card) => {
    const lines = wrap(card.label, nameMax);
    const subLines = card.sub ? wrap(card.sub, subMax) : [];
    const blockH = lines.length * NAME_LINE_H + subLines.length * SUB_LINE_H;
    const h = Math.max(CARD_MIN_H, CARD_INNER_Y * 2 + blockH);
    return { card, lines, subLines, h };
  };

  const laidColumns = columns.map((column) => column.cards.map(layCard));
  const stackHeights = laidColumns.map(
    (cards) => cards.reduce((sum, c) => sum + c.h, 0) + Math.max(0, cards.length - 1) * CARD_GAP,
  );
  // Every column shares the tallest column's height: a short column ending at
  // the same baseline as its neighbours reads as "empty for now", not as a
  // rendering accident that forgot to draw the rest of its frame.
  const maxStack = Math.max(0, ...stackHeights);
  const contentTop = PAD + HEADER_H + HEADER_GAP;
  const frameBottom = contentTop + maxStack + BOTTOM_PAD;

  let boundRight = PAD;
  let boundBottom = frameBottom;
  /** @param {number} x @param {number} y @param {number} w @param {number} h */
  const track = (x, y, w, h) => {
    boundRight = Math.max(boundRight, x + w);
    boundBottom = Math.max(boundBottom, y + h);
  };

  /** @type {string[]} */
  const parts = [];
  columns.forEach((column, i) => {
    const x = PAD + i * (COL_W + GUTTER);
    const headerY = PAD;
    track(x, headerY, COL_W, frameBottom - headerY);
    parts.push(
      `<rect class="zone" x="${x}" y="${headerY}" width="${COL_W}" height="${frameBottom - headerY}" rx="8"/>`,
      `<text class="nn" x="${x + TEXT_PAD_X}" y="${headerY + 18}">${esc(column.label)}</text>`,
    );
    const wipLabel =
      column.wip !== undefined ? `${column.cards.length}/${column.wip}` : `${column.cards.length}`;
    parts.push(
      `<text class="tag" x="${x + COL_W - TEXT_PAD_X}" y="${headerY + 17}" text-anchor="end">${esc(wipLabel)}</text>`,
      `<line class="hair" x1="${x + TEXT_PAD_X}" y1="${headerY + HEADER_H}" x2="${x + COL_W - TEXT_PAD_X}" y2="${headerY + HEADER_H}"/>`,
    );

    let y = contentTop;
    for (const laid of laidColumns[i]) {
      const cx = x + CARD_PAD_X;
      const tx = cx + TEXT_PAD_X;
      const classes = laid.card.kind ? `nb ${laid.card.kind}` : "nb";
      track(cx, y, CARD_W, laid.h);
      const blockH = laid.lines.length * NAME_LINE_H + laid.subLines.length * SUB_LINE_H;
      const nameTop = y + (laid.h - blockH) / 2 + 11;
      parts.push(
        `<rect class="${classes}" x="${cx}" y="${y}" width="${CARD_W}" height="${laid.h}" rx="6"/>`,
        `<text class="nn" x="${tx}" y="${nameTop}">` +
          laid.lines
            .map((l, k) => `<tspan x="${tx}" dy="${k === 0 ? 0 : NAME_LINE_H}">${esc(l)}</tspan>`)
            .join("") +
          "</text>",
      );
      if (laid.subLines.length) {
        const subTop = nameTop + (laid.lines.length - 1) * NAME_LINE_H + 12;
        parts.push(
          `<text class="ns" x="${tx}" y="${subTop}">` +
            laid.subLines
              .map((l, k) => `<tspan x="${tx}" dy="${k === 0 ? 0 : SUB_LINE_H}">${esc(l)}</tspan>`)
              .join("") +
            "</text>",
        );
      }
      y += laid.h + CARD_GAP;
    }
  });

  const vw = snap(boundRight + PAD);
  const vh = snap(boundBottom + PAD);
  return assemble([
    `<svg viewBox="0 0 ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="0" y="0" width="${vw}" height="${vh}" rx="10"/>`,
    parts.join(""),
    "</svg>",
  ]);
}

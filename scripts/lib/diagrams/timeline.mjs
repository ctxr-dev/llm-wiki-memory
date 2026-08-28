// A horizontal timeline: a spine with dated events alternating above and below
// it. Alternation is what lets cards sit close together along the spine without
// ever fighting for the same band above or below it — no collision search is
// needed, only picking a side by parity.
//
// Spacing is honest when the dates are real: every event date is run through
// `Date.parse` and, when all of them parse to a genuine (non-zero) span, events
// land on a linear time scale via `linearScale` rather than being spread out
// evenly regardless of how close together they actually happened. A roadmap
// whose "dates" are phase names ("Kickoff", "Beta") is not chronological data,
// so that case falls back to even spacing instead of feeding `Date.parse`
// garbage into a scale.

import { assemble, esc, snap, wrap, NAME_CH, MONO_CH } from "./text.mjs";
import { linearScale } from "./scale.mjs";

/**
 * @typedef {Object} TimelineEvent
 * @property {string} date
 * @property {string} label
 * @property {string} [sub]
 * @property {boolean} [focal]
 */

/**
 * @typedef {Object} TimelineSpec
 * @property {"timeline"} kind
 * @property {string} [id]
 * @property {string} title
 * @property {TimelineEvent[]} events
 */

const CARD_W = 168;
const PAD_IN_X = 14;
const PAD = 40;
// The minimum pixel distance between two consecutive events, in EITHER spacing
// mode. In index mode every step equals this exactly. In proportional mode it
// is a floor: a real gap that would otherwise map to less than this is pulled
// out to it, because a card cannot shrink to fit an arbitrarily small gap. Two
// same-side cards are always two steps apart, so this floor is also what keeps
// alternating cards from ever colliding.
const BASE_PITCH = 160;
// How much nominal room a genuinely time-scaled axis gets beyond the plain
// index layout, so real elapsed time still reads as visually different gaps
// before the minimum-pitch floor evens out only the crowded ones.
const PROPORTIONAL_STRETCH = 1.5;
const LEAD = 22;
const DOT_R = 4;
const DOT_R_FOCAL = 6;
const TAG_OFFSET = 14;
const LABEL_GAP = 16;
const LINE_H = 15;
const SUB_GAP = 13;
const SUB_LINE_H = 11;
const BOTTOM_PAD = 12;

/**
 * `Date.parse` is far more lenient than a calendar date: V8 happily parses
 * "Phase 1" into a real, increasing timestamp. Gating it behind an explicit
 * ISO shape is what actually distinguishes a calendar date from a roadmap
 * label, rather than trusting whatever a permissive parser accepts.
 * @param {string} date
 * @returns {boolean}
 */
const ISO_DATE = /^\d{4}-\d{2}(-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?)?$/;

/**
 * Position events along the spine. Honest to elapsed time when every date is
 * a real ISO calendar date with a non-degenerate span; evenly spaced by
 * index otherwise (a roadmap phase name is not a point in time).
 * @param {TimelineEvent[]} events
 * @returns {number[]}
 */
function eventPositions(events) {
  const epochs = events.map((e) => (ISO_DATE.test(e.date) ? Date.parse(e.date) : NaN));
  const chronological = epochs.every(Number.isFinite) && epochs[epochs.length - 1] > epochs[0];

  /** @type {number[]} */
  const nominal = [];
  if (chronological) {
    for (let i = 1; i < epochs.length; i += 1) {
      if (epochs[i] < epochs[i - 1]) {
        throw new Error(
          `timeline events must be in chronological order: "${events[i].date}" precedes "${events[i - 1].date}"`,
        );
      }
    }
    const span = (events.length - 1) * BASE_PITCH * PROPORTIONAL_STRETCH;
    const toX = linearScale([epochs[0], epochs[epochs.length - 1]], [0, span]);
    for (const t of epochs) nominal.push(toX(t));
  } else {
    events.forEach((_, i) => nominal.push(i * BASE_PITCH));
  }

  // Walk forward and floor every gap at BASE_PITCH. In index mode this is a
  // no-op (every gap already equals it). In proportional mode it declutters a
  // dense cluster while leaving genuinely larger gaps alone, so relative
  // timing still reads correctly beyond the floor.
  const x = [nominal[0]];
  for (let i = 1; i < nominal.length; i += 1) {
    x.push(Math.max(nominal[i], x[i - 1] + BASE_PITCH));
  }
  return x;
}

/**
 * Render a horizontal timeline to inline SVG.
 * @param {TimelineSpec} spec
 * @returns {string}
 */
export function renderTimeline(spec) {
  const events = spec.events ?? [];
  if (events.length < 2) {
    throw new Error(`a timeline needs at least 2 events, got ${events.length}`);
  }
  const focal = events.filter((e) => e.focal);
  if (focal.length > 1) {
    throw new Error(
      `a timeline allows one focal event, got ${focal.length}: ${focal.map((e) => e.label).join(", ")}`,
    );
  }

  const xs = eventPositions(events);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  /** @param {number} x @param {number} y @param {number} w @param {number} h */
  const track = (x, y, w, h) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };

  /** @type {string[]} */
  const leaders = [];
  /** @type {string[]} */
  const dots = [];
  /** @type {string[]} */
  const cards = [];

  events.forEach((event, i) => {
    const above = i % 2 === 0;
    const cx = xs[i];
    const lines = wrap(event.label, Math.floor((CARD_W - PAD_IN_X * 2) / NAME_CH));
    const subLines = event.sub
      ? wrap(event.sub, Math.floor((CARD_W - PAD_IN_X * 2) / MONO_CH))
      : [];
    const labelBottom = TAG_OFFSET + LABEL_GAP + (lines.length - 1) * LINE_H;
    const contentBottom = subLines.length
      ? labelBottom + SUB_GAP + (subLines.length - 1) * SUB_LINE_H
      : labelBottom;
    const cardH = snap(contentBottom + BOTTOM_PAD);
    const cardTop = above ? -LEAD - cardH : LEAD;
    const cardBottom = cardTop + cardH;
    const r = event.focal ? DOT_R_FOCAL : DOT_R;

    track(cx - r, -r, r * 2, r * 2);
    track(cx - CARD_W / 2, cardTop, CARD_W, cardH);

    leaders.push(
      `<line class="hair" x1="${cx}" y1="0" x2="${cx}" y2="${above ? cardBottom : cardTop}"/>`,
    );
    dots.push(`<circle class="dot" cx="${cx}" cy="0" r="${r}"/>`);

    const cls = event.focal ? "nb focal" : "nb";
    const tagY = cardTop + TAG_OFFSET;
    const labelY = cardTop + TAG_OFFSET + LABEL_GAP;
    const subY = labelY + (lines.length - 1) * LINE_H + SUB_GAP;
    const name = lines
      .map((l, k) => `<tspan x="${cx}" dy="${k === 0 ? 0 : LINE_H}">${esc(l)}</tspan>`)
      .join("");
    const sub = subLines
      .map((l, k) => `<tspan x="${cx}" dy="${k === 0 ? 0 : SUB_LINE_H}">${esc(l)}</tspan>`)
      .join("");
    cards.push(
      `<rect class="${cls}" x="${cx - CARD_W / 2}" y="${cardTop}" width="${CARD_W}" height="${cardH}" rx="6"/>` +
        `<text class="tag" x="${cx}" y="${tagY}" text-anchor="middle">${esc(event.date.toUpperCase())}</text>` +
        `<text class="nn" x="${cx}" y="${labelY}" text-anchor="middle">${name}</text>` +
        (sub ? `<text class="ns" x="${cx}" y="${subY}" text-anchor="middle">${sub}</text>` : ""),
    );
  });

  const spine = `<line class="bus" x1="${xs[0]}" y1="0" x2="${xs[xs.length - 1]}" y2="0"/>`;

  const vx = snap(minX - PAD);
  const vy = snap(minY - PAD);
  const vw = snap(maxX + PAD - vx);
  const vh = snap(maxY + PAD - vy);

  return assemble([
    `<svg viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="10"/>`,
    spine,
    leaders.join(""),
    dots.join(""),
    cards.join(""),
    "</svg>",
  ]);
}

// Gantt: one row per task, a bar spanning start..end on a shared numeric time
// axis. Task labels live in the same 80px gutter every cartesian chart reserves
// for its y-axis, so a gantt lines up with a bar or line chart placed beside it
// in the same document. The price of that alignment is that a long task label
// wraps onto more than one line; the row height absorbs that instead of fighting
// it, which is also why the viewBox height is computed from the tasks rather
// than fixed at the usual 500.

import { plotArea, niceTicks, linearScale, MARGIN, VIEW } from "./scale.mjs";
import { xAxis, axisTitles } from "./axes.mjs";
import { assemble, esc, snap, wrap, NAME_CH } from "./text.mjs";

/** @typedef {import("./scale.mjs").Plot} Plot */

/**
 * @typedef {Object} GanttScale
 * @property {number} start left edge of the time axis
 * @property {number} end right edge of the time axis
 * @property {string} [unit] axis title, e.g. "week"
 */

/**
 * @typedef {Object} GanttTask
 * @property {string} label
 * @property {number} start
 * @property {number} end a task with `end === start` renders as a milestone diamond
 * @property {string} [lane] tasks sharing a lane are grouped with a divider and a tag
 * @property {boolean} [focal] the one accent bar/diamond in the chart
 * @property {boolean} [milestone] optional authoring hint; the actual test is `end === start`
 */

/**
 * @typedef {Object} GanttSpec
 * @property {string} id
 * @property {string} title
 * @property {GanttScale} scale
 * @property {GanttTask[]} tasks
 */

/**
 * @typedef {Object} GanttRow
 * @property {GanttTask} task
 * @property {string[]} lines wrapped task label
 * @property {number} h row height, sized to fit the wrapped label
 * @property {boolean} milestone
 * @property {boolean} divider a lane boundary starts above this row
 * @property {string} [tag] lane eyebrow to draw above this row
 */

const ROW_MIN_H = 30;
const BAR_H = 22;
const GROUP_GAP = 16;
const LINE_H = 11;
const DIAMOND_R = 7;
const GUTTER_GAP = 8; // px between the longest label line and the axis line

/**
 * Lay out one row per task: wrap its label to the shared y-axis gutter width,
 * and size the row to whichever is taller, the wrapped label or the bar. Lane
 * boundaries are detected between ADJACENT tasks only — a spec authors its
 * lanes in the visual order it wants, the same way `layers.mjs` bands are
 * already in stack order.
 * @param {GanttTask[]} tasks @param {number} maxChars
 * @returns {GanttRow[]}
 */
function layoutRows(tasks, maxChars) {
  /** @type {GanttRow[]} */
  const rows = [];
  /** @type {string | undefined} */
  let prevLane;
  tasks.forEach((task, i) => {
    if (!Number.isFinite(task.start) || !Number.isFinite(task.end)) {
      throw new Error(`task "${task.label}" has a non-finite start or end`);
    }
    if (task.end < task.start) {
      throw new Error(`task "${task.label}" ends (${task.end}) before it starts (${task.start})`);
    }
    const lines = wrap(task.label, maxChars);
    const h = Math.max(ROW_MIN_H, BAR_H + 10, lines.length * LINE_H + 10);
    const divider = i > 0 && task.lane !== prevLane;
    const tag =
      task.lane !== undefined && (i === 0 || task.lane !== prevLane) ? task.lane : undefined;
    rows.push({ task, lines, h, milestone: task.end === task.start, divider, tag });
    prevLane = task.lane;
  });
  return rows;
}

/**
 * Render a Gantt chart: horizontal rows on a shared numeric time axis, each
 * holding a task bar or, when `end === start`, a milestone diamond.
 * @param {GanttSpec} spec
 * @returns {string}
 */
export function renderGantt(spec) {
  if (spec.tasks.length === 0) throw new Error("a gantt chart needs at least one task");
  const { start, end } = spec.scale;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error(`gantt scale is degenerate: start=${start} end=${end}`);
  }

  // The gutter budget mirrors `yAxis`'s tick-label gutter exactly, so a task
  // label and a y-axis value sit at the same right edge across chart kinds.
  const maxChars = Math.max(4, Math.floor((MARGIN.left - GUTTER_GAP) / NAME_CH));
  const rows = layoutRows(spec.tasks, maxChars);
  const groupGaps = rows.filter((r) => r.divider).length * GROUP_GAP;
  const contentH = rows.reduce((sum, r) => sum + r.h, 0) + groupGaps;

  const viewH = MARGIN.top + contentH + MARGIN.bottom;
  const plot = plotArea({ height: viewH, margin: MARGIN });
  const { min, max, step, ticks } = niceTicks(start, end, 6);
  const x = linearScale([min, max], [plot.x, plot.x2]);

  /** @type {string[]} */
  const furniture = [];
  /** @type {string[]} */
  const marks = [];
  let cursorY = plot.y;
  for (const row of rows) {
    if (row.divider) {
      const dividerY = cursorY + GROUP_GAP / 2;
      furniture.push(
        `<line class="hair" x1="${plot.x}" y1="${dividerY}" x2="${plot.x2}" y2="${dividerY}"/>`,
      );
      cursorY += GROUP_GAP;
    }
    const rowTop = cursorY;
    const cy = rowTop + row.h / 2;
    if (row.tag !== undefined) {
      furniture.push(
        `<text class="tag" x="8" y="${rowTop - 3}">${esc(row.tag.toUpperCase())}</text>`,
      );
    }
    const labelX = plot.x - GUTTER_GAP;
    const startY = cy - ((row.lines.length - 1) * LINE_H) / 2 + 4;
    furniture.push(
      `<text class="clab" x="${labelX}" y="${startY}" text-anchor="end">` +
        row.lines
          .map((l, k) => `<tspan x="${labelX}" dy="${k === 0 ? 0 : LINE_H}">${esc(l)}</tspan>`)
          .join("") +
        "</text>",
    );
    const focalCls = row.task.focal ? " focal" : "";
    if (row.milestone) {
      // Non-rect mark: a diamond, not a zero-width bar. `validateSvg` only
      // inspects `<rect>` geometry, so this polygon is invisible to its
      // overlap/clip checks — acceptable here because a milestone occupies a
      // single point, not an area a reader needs collision-checked.
      const cx = x(row.task.start);
      const pts = `${cx},${cy - DIAMOND_R} ${cx + DIAMOND_R},${cy} ${cx},${cy + DIAMOND_R} ${cx - DIAMOND_R},${cy}`;
      marks.push(`<polygon class="mark${focalCls}" points="${pts}"/>`);
    } else {
      const bx = x(row.task.start);
      const bw = Math.max(2, x(row.task.end) - bx);
      const by = cy - BAR_H / 2;
      marks.push(
        `<rect class="mark${focalCls}" x="${bx}" y="${by}" width="${bw}" height="${BAR_H}" rx="4"/>`,
      );
    }
    cursorY += row.h;
  }

  const vw = snap(VIEW.w);
  const vh = snap(viewH);
  return assemble([
    `<svg viewBox="0 0 ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="0" y="0" width="${vw}" height="${vh}" rx="10"/>`,
    xAxis({ plot, ticks, step, x }),
    furniture.join(""),
    marks.join(""),
    axisTitles({ plot, xLabel: spec.scale.unit }),
    "</svg>",
  ]);
}

import { registerRenderer, rendererFor, knownKinds } from "./registry.mjs";
import { validateSvg } from "./validate.mjs";
import { render } from "./flow.mjs";
import { renderSequence } from "./sequence.mjs";
import { renderLayers } from "./layers.mjs";
import { renderTree } from "./tree.mjs";
import { renderSwimlane } from "./swimlane.mjs";
import { renderEr } from "./er.mjs";
import { renderKanban } from "./kanban.mjs";
import { renderNested } from "./nested.mjs";
import { renderBar } from "./bar.mjs";
import { renderLine } from "./line.mjs";
import { renderScatter } from "./scatter.mjs";
import { renderGantt } from "./gantt.mjs";
import { renderRadar } from "./radar.mjs";
import { renderPolar } from "./polar.mjs";
import { renderPyramid } from "./pyramid.mjs";
import { renderTreemap } from "./treemap.mjs";
import { renderQuadrant } from "./quadrant.mjs";
import { renderWardley } from "./wardley.mjs";
import { renderTimeline } from "./timeline.mjs";
import { renderLoop } from "./loop.mjs";
import { renderFishbone } from "./fishbone.mjs";
import { renderVenn } from "./venn.mjs";
import { renderSankey } from "./sankey.mjs";
import { renderMedallion } from "./medallion.mjs";
import { renderHighLevel } from "./highlevel.mjs";

export { knownKinds };

/** @typedef {import("./types.mjs").DiagramSpec} DiagramSpec */
/** @typedef {import("./types.mjs").FlowSpec} FlowSpec */

/**
 * Apply a default silhouette to every node that does not choose one, so a kind
 * can carry a shape vocabulary without every spec restating it.
 * @param {FlowSpec} spec @param {import("./types.mjs").NodeShape} shape
 * @returns {FlowSpec}
 */
function withDefaultShape(spec, shape) {
  return { ...spec, nodes: spec.nodes.map((n) => ({ ...n, shape: n.shape ?? shape })) };
}

// `flow` is the default kind, so a spec may omit `kind` entirely. `flowchart`
// and `state` are the same box-and-edge renderer with a different default
// silhouette: they inherit its port selection, lane routing and label collision
// handling rather than reimplementing them and re-earning the same bugs.
//
// The `use`/`pick` lines are the catalogue an agent reads to CHOOSE a type; they
// are the reason a new kind cannot be added without documenting itself.
registerRenderer("flow", render, {
  use: "services and stores exchanging messages",
  pick: "the edges carry a payload worth naming",
});
registerRenderer("sequence", renderSequence, {
  use: "an ordered exchange between a few actors",
  pick: "the ORDER of the steps is the point",
});
registerRenderer("flowchart", (spec) => render(withDefaultShape(spec, "box")), {
  use: "branching logic with decisions",
  pick: "a reader has to answer a question to know where they go next",
});
registerRenderer("state", (spec) => render(withDefaultShape(spec, "state")), {
  use: "a lifecycle: the states a thing can be in",
  pick: "the same entity changes status over time",
});
registerRenderer("layers", renderLayers, {
  use: "a strict hierarchy of abstraction levels",
  pick: "each band sits ON the one below and nothing skips",
});
registerRenderer("tree", renderTree, {
  use: "parent-to-child hierarchy, one parent each",
  pick: "no node has two parents; otherwise use flow",
});
// Two kinds below are the SAME renderer as a sibling, registered under their own
// name because the choice cue differs and that is what the catalogue exists to
// answer. `architecture` is flow plus the existing `zones` boundary frames;
// `org-chart` is a tree whose nodes are owners, where the `sub` line carries how
// to reach them. Registering an alias is only honest when the reference's layout
// really is the sibling's: `medallion` and `high-level` are NOT aliases (both
// specify their own parametric geometry) and are deliberately absent until built.
registerRenderer("architecture", render, {
  use: "a system overview grouped into tiers or trust boundaries",
  pick: "you need boundary frames drawn around groups of components",
});
registerRenderer("org-chart", renderTree, {
  use: "who owns what: people, teams, or agents",
  pick: "the nodes are owners and the reader needs the invocation path",
});
registerRenderer("swimlane", renderSwimlane, {
  use: "one process crossing several owners",
  pick: "WHO does each step matters as much as the order",
});
registerRenderer("er", renderEr, {
  use: "entities, their fields, and how they relate",
  pick: "the reader needs the field names, not just the boxes",
});
registerRenderer("kanban", renderKanban, {
  use: "work items grouped by state",
  pick: "a census of what sits where, with no flow between items",
});
registerRenderer("nested", renderNested, {
  use: "containment: what runs inside what",
  pick: "the relationship is inside, not talks-to",
});
registerRenderer("bar", renderBar, {
  use: "comparing a magnitude across a few named things",
  pick: "the categories have no order and you are ranking them",
});
registerRenderer("line", renderLine, {
  use: "how one or more measures move over an ordered axis",
  pick: "the x axis has a direction, usually time",
});
registerRenderer("scatter", renderScatter, {
  use: "whether two measures relate",
  pick: "you are looking for correlation, not comparing categories",
});
registerRenderer("gantt", renderGantt, {
  use: "work items across a time axis",
  pick: "each item has a start and an end, and overlap matters",
});
registerRenderer("radar", renderRadar, {
  use: "one or two options scored on the same few criteria",
  pick: "the SHAPE of a trade-off is the point, not exact values",
});
registerRenderer("polar", renderPolar, {
  use: "magnitude around a cycle",
  pick: "the axis wraps: hours, months, compass headings",
});
registerRenderer("pyramid", renderPyramid, {
  use: "stages that shed volume, or a layered hierarchy",
  pick: "each stage is a subset of the one above",
});
registerRenderer("treemap", renderTreemap, {
  use: "how a total divides into parts, by area",
  pick: "the relative SIZE of the parts is the message",
});

registerRenderer("quadrant", renderQuadrant, {
  use: "placing options on two judgement axes",
  pick: "you are prioritising and the four corners have names",
});
registerRenderer("wardley", renderWardley, {
  use: "a value chain against how evolved each part is",
  pick: "you are arguing about build versus buy",
});
registerRenderer("timeline", renderTimeline, {
  use: "dated events along one axis",
  pick: "WHEN each thing happened is the point",
});
registerRenderer("loop", renderLoop, {
  use: "a cycle where each stage feeds the next",
  pick: "the last stage returns to the first",
});
registerRenderer("fishbone", renderFishbone, {
  use: "candidate causes of one effect, grouped",
  pick: "you are still diagnosing and the causes group naturally",
});
registerRenderer("venn", renderVenn, {
  use: "two or three sets and what they share",
  pick: "the OVERLAP is the thing you are describing",
});
registerRenderer("sankey", renderSankey, {
  use: "quantities flowing and splitting between stages",
  pick: "you need to see where the volume goes, not just the path",
});
registerRenderer("medallion", renderMedallion, {
  use: "data tiers of the same dataset by quality level",
  pick: "each tier is a refined copy, with a writer and a format",
});
registerRenderer("high-level", renderHighLevel, {
  use: "an end-to-end stack across named phases",
  pick: "you need the whole platform on one page, phase by phase",
});

/**
 * Render a spec to inline SVG, dispatching on its kind.
 * @param {DiagramSpec} spec
 * @returns {string}
 */
export function draw(spec) {
  return rendererFor(spec.kind ?? "flow")(spec);
}

/**
 * `draw` wrapped in the `.dd` container the theme block is scoped to.
 *
 * The newlines around the SVG are safe (a single newline does not close an HTML
 * block) and keep the markup readable in the raw leaf; `assemble` has already
 * refused any BLANK line inside it.
 * @param {DiagramSpec} spec
 * @returns {string}
 */
export function block(spec) {
  return `<div class="dd">\n${draw(spec)}\n</div>`;
}

/**
 * Render, then geometrically self-check, so a caller can refuse to save an
 * illegible diagram rather than discovering it in review.
 * @param {DiagramSpec} spec
 * @returns {{ svg: string, findings: import("./validate.mjs").Finding[] }}
 */
export function drawChecked(spec) {
  const svg = draw(spec);
  return { svg, findings: validateSvg(svg) };
}

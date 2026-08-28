import { graphExamples } from "./graph.mjs";
import { graphStructureExamples } from "./graph-structure.mjs";
import { chartsExamples } from "./charts.mjs";
import { positionalExamples } from "./positional.mjs";

/** @typedef {import("./page.mjs").Example} Example */

// The gallery is grouped into three modules only to stay under the file-size
// gate; the order below is the order the docs page presents, so it is chosen for
// READING: the graph-shaped types first (most people arrive wanting one of
// those), then the charts, then the positional and parametric layouts.

/**
 * Every gallery example, in presentation order.
 * @returns {Example[]}
 */
export function allExamples() {
  const all = [
    ...graphExamples,
    ...graphStructureExamples,
    ...chartsExamples,
    ...positionalExamples,
  ];
  const seen = new Set();
  for (const e of all) {
    if (seen.has(e.name)) {
      throw new Error(`duplicate gallery slug ${e.name}: slugs are anchors and PNG filenames`);
    }
    seen.add(e.name);
  }
  return all;
}

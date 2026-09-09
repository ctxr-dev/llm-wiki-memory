// Sankey geometry: value formatting, the vertical stacking of a node's flows,
// and the ribbon path. Split from `sankey.mjs` only to keep both files under the
// 300-line gate; nothing here knows about the spec or the SVG frame.

/** @param {number} n @returns {string} */
export function formatCount(n) {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Cumulative pixel boundaries for a stack of values sharing one node edge -
 * exact floats, so adjacent segments always meet with no gap.
 * @param {number[]} values @param {number} height
 * @returns {number[]} one more entry than `values`; bounds[i]..bounds[i+1] is value i's span
 */
export function stackBounds(values, height) {
  const total = values.reduce((a, v) => a + v, 0);
  const bounds = [0];
  let cum = 0;
  for (const v of values) {
    cum += v;
    bounds.push(total > 0 ? (height * cum) / total : 0);
  }
  return bounds;
}

/**
 * The closed ribbon path between a source's [sy0,sy1] offset and a target's
 * [ty0,ty1] offset, meeting both bars square-on rather than at a slant.
 * @param {number} sx @param {number} sy0 @param {number} sy1
 * @param {number} tx @param {number} ty0 @param {number} ty1 @returns {string}
 */
export function ribbonPath(sx, sy0, sy1, tx, ty0, ty1) {
  const [mx, x0, x1, a, b, c, d] = [(sx + tx) / 2, sx, tx, sy0, ty0, ty1, sy1].map((v) =>
    Math.round(v),
  );
  return `M${x0},${a} C${mx},${a} ${mx},${b} ${x1},${b} L${x1},${c} C${mx},${c} ${mx},${d} ${x0},${d} Z`;
}

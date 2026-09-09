// Reading shapes back out of emitted SVG. Kept apart from `validate.mjs` so
// neither file outgrows the 300-line gate; the seam is clean because nothing
// here knows what counts as a defect.

/** @typedef {import("./types.mjs").Rect} Rect */

/** @param {string} svg @param {string} cls @returns {Rect[]} */
export function rectsOfClass(svg, cls) {
  /** @type {Rect[]} */
  const out = [];
  for (const m of svg.matchAll(/<rect\b([^>]*)\/>/g)) {
    const attrs = m[1];
    const classMatch = /class="([^"]*)"/.exec(attrs);
    if (!classMatch) continue;
    const classes = classMatch[1].split(/\s+/);
    if (!classes.includes(cls)) continue;
    /** @param {string} name @returns {number} */
    const num = (name) => {
      const v = new RegExp(`${name}="(-?[\\d.]+)"`).exec(attrs);
      return v ? Number(v[1]) : NaN;
    };
    const rect = { x: num("x"), y: num("y"), w: num("width"), h: num("height") };
    if (Object.values(rect).every((n) => Number.isFinite(n))) out.push(rect);
  }
  return out;
}

/**
 * Bounding boxes of the NON-rect marks: circles and polygons.
 *
 * These are collected separately, and only the `empty` and `clipped` checks use
 * them. That split is deliberate. A circle-only chart (a scatter, a polar) has
 * zero rects, so without this it reported `empty` — a whole chart scoring as
 * broken while being fine. But feeding these into the node-OVERLAP check would be
 * wrong in the other direction: a Venn diagram's circles are supposed to overlap,
 * and a radar's series polygons sit on top of one another by design.
 * @param {string} svg @param {string} cls
 * @returns {Rect[]}
 */
export function nonRectMarks(svg, cls) {
  /** @type {Rect[]} */
  const out = [];
  for (const m of svg.matchAll(/<circle\b([^>]*)\/>/g)) {
    const attrs = m[1];
    if (!/class="([^"]*)"/.exec(attrs)?.[1].split(/\s+/).includes(cls)) continue;
    const num = (/** @type {string} */ name) => {
      const v = new RegExp(`${name}="(-?[\\d.]+)"`).exec(attrs);
      return v ? Number(v[1]) : NaN;
    };
    const [cx, cy, r] = [num("cx"), num("cy"), num("r")];
    if ([cx, cy, r].every((n) => Number.isFinite(n))) {
      out.push({ x: cx - r, y: cy - r, w: r * 2, h: r * 2 });
    }
  }
  for (const m of svg.matchAll(/<polygon\b([^>]*)\/>/g)) {
    const attrs = m[1];
    if (!/class="([^"]*)"/.exec(attrs)?.[1].split(/\s+/).includes(cls)) continue;
    const pts = /points="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const nums = (pts.match(/-?[\d.]+/g) ?? []).map(Number).filter((n) => Number.isFinite(n));
    if (nums.length < 4) continue;
    /** @type {number[]} */
    const xs = [];
    /** @type {number[]} */
    const ys = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      xs.push(nums[i]);
      ys.push(nums[i + 1]);
    }
    out.push({
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    });
  }
  return out;
}

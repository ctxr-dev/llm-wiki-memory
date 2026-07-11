// Single source of truth for "does this placement-override path land in <category>?"
// Shared by the L3 server gate (mcp-server/index.mjs `targetsGatedCategory`) and
// the L2 Claude Code hook (`isGatedSelfImprovementCall`) so the two surfaces can
// never silently diverge on which writes are gated / counted (e.g. the
// dataset:"knowledge" + path:"self_improvement/..." bypass). Pure, no deps.
//
// A path's category is its FIRST segment after stripping leading slashes and
// splitting on both slash kinds (the same form the wiki placement override uses).
/**
 * @param {unknown} placementOverride
 * @param {string} category
 * @returns {boolean}
 */
export function placementTargetsCategory(placementOverride, category) {
  if (typeof placementOverride !== "string" || !placementOverride.trim()) return false;
  const segs = placementOverride
    .replace(/^\/+/, "")
    .split(/[\\/]+/)
    .filter(Boolean);
  return segs[0] === category;
}

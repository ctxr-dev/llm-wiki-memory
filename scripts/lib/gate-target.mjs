// Single source of truth for "does this placement-override path land in <category>?"
// Shared by the L3 server gate (targetsGatedCategory / isGatedWrite) and the L2
// Claude Code hook (`isGatedSelfImprovementCall`) so the two surfaces can never
// silently diverge on which writes are gated (e.g. the dataset:"knowledge" +
// path:"self_improvement/..." bypass).
//
// A path's category is its FIRST meaningful segment. Segmentation is delegated to
// the shared `pathSegments` helper so this predicate and the placement normaliser
// drop the SAME empty/`.` segments — otherwise `./self_improvement/x` reads as
// category `.` here while landing in `self_improvement` at placement.
import { pathSegments } from "./path-segments.mjs";

/**
 * @param {unknown} placementOverride
 * @param {string} category
 * @returns {boolean}
 */
export function placementTargetsCategory(placementOverride, category) {
  if (typeof placementOverride !== "string" || !placementOverride.trim()) return false;
  return pathSegments(placementOverride)[0] === category;
}

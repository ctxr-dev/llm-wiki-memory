// The SINGLE source of "how a wiki-relative override path splits into segments",
// shared by the write-gate predicate (gate-target.mjs) and the placement
// normaliser (wiki-placement.mjs). Both must agree on the FIRST segment (the
// landing category), or a consent-gate bypass opens: previously the gate kept
// `.` segments while placement dropped them, so `./self_improvement/x` read as
// category `.` at the gate (not gated) but landed in `self_improvement` at
// placement. Dropping empty and `.` segments here — exactly as placement does —
// keeps the two surfaces in lockstep.
/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function pathSegments(raw) {
  if (typeof raw !== "string") return [];
  return raw.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
}

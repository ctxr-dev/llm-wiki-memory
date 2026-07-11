// ─── cluster dedup keys ──────────────────────────────────────────────────────
//
// Keeper selection and grouping keys shared by the deterministic dedup passes
// (2B/2C/2D). Kept separate from the passes so the tie-break + lesson-key
// semantics have one home.

/** @typedef {import("./consolidate-report.mjs").RunLeaf} RunLeaf */

// Keeper selection: newer `frontmatter.updated` wins. Tiebreak by
// lex-ascending documentId so two runs on the same fixture pick identically.
/**
 * @param {RunLeaf} a
 * @param {RunLeaf} b
 * @returns {RunLeaf}
 */
export function pickKeeper(a, b) {
  const au = String(a.frontmatter?.updated || "");
  const bu = String(b.frontmatter?.updated || "");
  if (au > bu) return a;
  if (bu > au) return b;
  return a.documentId < b.documentId ? a : b;
}

/**
 * @param {{ documentId: string }} keeper
 * @param {{ documentId: string }} loser
 * @returns {string}
 */
export function loserKey(keeper, loser) {
  return `${keeper.documentId}|${loser.documentId}`;
}

/**
 * @param {RunLeaf} leaf
 * @returns {string}
 */
export function lessonKey(leaf) {
  const m = leaf.memory || {};
  const ep = String(m.error_pattern || "")
    .trim()
    .toLowerCase();
  if (!ep) return ""; // sentinel: skip
  const pm = String(m.project_module || "")
    .trim()
    .toLowerCase();
  const ar = String(m.area || "")
    .trim()
    .toLowerCase();
  const tt = String(m.task_type || "")
    .trim()
    .toLowerCase();
  return `${pm}|${ar}|${tt}|${ep}`;
}

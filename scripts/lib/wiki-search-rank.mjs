import { priorityRank } from "./datasets.mjs";

/** @typedef {Record<string, unknown>} SearchFilters */

// The PURE ranking helpers for a single-tree search: does a leaf's frontmatter
// satisfy the caller's filters, and the priority-band rerank applied to an
// already-score-sorted list. No filesystem, no embedding, no wiki root.

/**
 * @param {Record<string, unknown>} memoryMeta
 * @param {SearchFilters | null | undefined} filters
 * @returns {boolean}
 */
export function metaMatchesFilters(memoryMeta, filters) {
  if (!filters) return true;
  for (const [key, val] of Object.entries(filters)) {
    if (val == null || val === "") continue;
    // `subject` is stored as a slug ARRAY; `tags` as a comma string. Both are
    // membership filters (every wanted value must be present), not exact match.
    if (key === "tags" || key === "subject") {
      const raw = memoryMeta[key];
      const haveList = (Array.isArray(raw) ? raw : String(raw || "").split(","))
        .map((t) => String(t).trim().toLowerCase())
        .filter(Boolean);
      const wantList = (Array.isArray(val) ? val : String(val).split(","))
        .map((t) => String(t).trim().toLowerCase())
        .filter(Boolean);
      if (!wantList.every((wt) => haveList.includes(wt))) return false;
      continue;
    }
    if (key === "project_module") {
      const chain = String(memoryMeta[key] || "").toLowerCase();
      const want = String(val).toLowerCase();
      if (chain !== want && !chain.endsWith(`//${want}`)) return false;
      continue;
    }
    const have = String(memoryMeta[key] || "").toLowerCase();
    const want = String(val).toLowerCase();
    if (have !== want) return false;
  }
  return true;
}

// Stable within-band priority tie-break over a cosine-descending list. Cosine
// stays dominant: a hit more than `band` below its group leader keeps its rank;
// only hits within `band` reorder P0 > P1 > P2 (stable sort keeps cosine order
// for equal priority). band <= 0 disables it. `scoreOf` selects the metric the
// band walks (default cosine `score`; fan-out passes adjustedConfidence).
/**
 * @template {{ score: number, priority: string }} T
 * @param {T[]} sortedDesc
 * @param {number} band
 * @param {(r: T) => number} [scoreOf]
 * @returns {T[]}
 */
export function rerankWithinBands(sortedDesc, band, scoreOf = (r) => r.score) {
  if (!(band > 0) || sortedDesc.length < 2) return sortedDesc;
  /** @type {T[]} */
  const out = [];
  let i = 0;
  while (i < sortedDesc.length) {
    const lead = scoreOf(sortedDesc[i]);
    let j = i + 1;
    while (j < sortedDesc.length && lead - scoreOf(sortedDesc[j]) <= band) j += 1;
    const group = sortedDesc.slice(i, j);
    group.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
    out.push(...group);
    i = j;
  }
  return out;
}

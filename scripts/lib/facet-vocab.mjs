// Known-facet vocabulary for the distiller/compile prompts. The 2026-06-04
// corpus audit traced most duplicate twins to facet drift: re-captures of the
// same fact invented a NEW area or error_pattern slug, so upsert-by-facet
// never collapsed them. Feeding the prompts the existing vocabulary (with a
// reuse-before-invent instruction) attacks that at the source.
//
// Best-effort by design: any failure yields an empty vocabulary and a neutral
// prompt — a vocab problem must never break distillation.

import { getCategories, listActiveLeavesForConsolidate } from "./wiki-store.mjs";

/** @typedef {import("./types.mjs").MemoryMetadata} MemoryMetadata */

const VOCAB_SENTINELS = new Set(["", "unknown", "unscoped", "untyped", "general"]);

/**
 * @typedef {{ areas: string[], errorPatternsByArea: Record<string, string[]> }} FacetVocab
 */

/** @type {FacetVocab | null} */
let memoized = null;

/**
 * @param {{ maxAreas?: number, maxPatternsPerArea?: number }} [args]
 * @returns {FacetVocab}
 */
export function collectFacetVocab({ maxAreas = 30, maxPatternsPerArea = 20 } = {}) {
  if (memoized) return memoized;
  /** @type {Map<string, number>} */
  const areaCounts = new Map();
  /** @type {Map<string, Map<string, number>>} */
  const patternCounts = new Map();
  try {
    for (const category of getCategories()) {
      if (category === "daily") continue;
      let leaves;
      try {
        leaves = listActiveLeavesForConsolidate({ category });
      } catch {
        continue;
      }
      for (const leaf of leaves) {
        const m = /** @type {Partial<MemoryMetadata>} */ (leaf?.memory || {});
        const area = String(m.area || "")
          .trim()
          .toLowerCase();
        if (!area || VOCAB_SENTINELS.has(area)) continue;
        areaCounts.set(area, (areaCounts.get(area) || 0) + 1);
        const ep = String(m.error_pattern || "")
          .trim()
          .toLowerCase();
        if (!ep) continue;
        if (!patternCounts.has(area)) patternCounts.set(area, new Map());
        const per = /** @type {Map<string, number>} */ (patternCounts.get(area));
        per.set(ep, (per.get(ep) || 0) + 1);
      }
    }
  } catch {
    memoized = { areas: [], errorPatternsByArea: {} };
    return memoized;
  }
  /** @param {[string, number]} a @param {[string, number]} b @returns {number} */
  const byCountThenName = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
  const areas = [...areaCounts.entries()]
    .sort(byCountThenName)
    .slice(0, maxAreas)
    .map(([a]) => a);
  /** @type {Record<string, string[]>} */
  const errorPatternsByArea = {};
  for (const area of areas) {
    const per = patternCounts.get(area);
    if (!per || per.size === 0) continue;
    errorPatternsByArea[area] = [...per.entries()]
      .sort(byCountThenName)
      .slice(0, maxPatternsPerArea)
      .map(([p]) => p);
  }
  memoized = { areas, errorPatternsByArea };
  return memoized;
}

/**
 * @param {FacetVocab | null} [vocab]
 * @returns {{ KNOWN_AREAS: string, KNOWN_ERROR_PATTERNS: string }}
 */
export function renderVocabVars(vocab) {
  const v = vocab || { areas: [], errorPatternsByArea: {} };
  const KNOWN_AREAS = v.areas.length ? v.areas.join(", ") : "(none yet)";
  const lines = Object.entries(v.errorPatternsByArea || {}).map(
    ([area, patterns]) => `${area}: ${patterns.join(", ")}`,
  );
  const KNOWN_ERROR_PATTERNS = lines.length ? lines.join("\n") : "(none yet)";
  return { KNOWN_AREAS, KNOWN_ERROR_PATTERNS };
}

export function __resetFacetVocabForTest() {
  memoized = null;
}

// Federated read fan-out (Phase E). `searchMemoryFiltered` is the public search
// door: when a multi-level WikiContext is active it runs the single-tree scorer
// (searchOneTree) once per level inside that level's `withWikiRoot` frame, tags
// every hit with the additive depth ranking, merges across levels with a
// tree-namespaced dedupe, and sorts by adjustedConfidence so a DEEPER / more-local
// level's hits outrank a shallower one's.
//
// The ranking is deliberately additive and level-locked:
//   adjustedConfidence = cosine + depth * depthBoostPerLevel
// With the default boost (>= 1 per level, exceeding the [0,1] cosine spread) the
// depth term dominates, so per-repo memory beats the global brain. `score` stays
// the honest cosine; `cosine`/`depth`/`depthBoost`/`adjustedConfidence` are
// separate fields.
//
// With NO active context OR a single level the door is byte-identical to the
// pre-fan-out single tree: it returns `searchOneTree` unchanged (no depth fields,
// same order, same slice). That is the regression guard the whole existing suite
// runs under.

import fs from "node:fs";
import { getActiveWikiContext } from "./wiki-context.mjs";
import { withWikiRoot } from "./env.mjs";
import { recallDepthBoostPerLevel, recallSearchPerLevelCap } from "./settings.mjs";
import { searchOneTree } from "./wiki-search.mjs";

/** @typedef {import("./types.mjs").SearchHit} SearchHit */
/** @typedef {import("./wiki-context.mjs").WikiLevel} WikiLevel */
/** @typedef {Record<string, unknown>} SearchFilters */
/**
 * @typedef {Object} SearchOneTreeOpts
 * @property {string} [query]
 * @property {string} [datasetId]
 * @property {number} [limit]
 * @property {SearchFilters} [filters]
 * @property {number} [scoreThreshold]
 * @property {boolean} [withGlance]
 */

/**
 * @param {string} p
 * @returns {string} the symlink-resolved path, or `p` unchanged if unresolvable
 */
function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Scope a level's search to that level's OWN module. The read doors auto-inject
// the BRAIN's default module into `filters.project_module`; left untouched, a
// mount whose leaves are tagged with a different module would be filtered out.
// So when the incoming module IS the brain's default (i.e. it was auto-injected),
// swap in the level's module; an explicit non-default module the caller chose is
// preserved across every level.
/**
 * @param {SearchFilters | undefined} filters
 * @param {WikiLevel} level
 * @param {string} brainModule
 * @returns {SearchFilters | undefined}
 */
function perLevelFilters(filters, level, brainModule) {
  if (!filters || typeof filters !== "object") return filters;
  if (!("project_module" in filters)) return filters;
  if (filters.project_module !== brainModule) return filters;
  return { ...filters, project_module: level.projectModule };
}

/**
 * @param {SearchOneTreeOpts} opts
 * @param {WikiLevel[]} levels
 * @returns {Promise<{ records: SearchHit[] }>}
 */
async function fanOutSearch(opts, levels) {
  const perLevelCap = recallSearchPerLevelCap();
  const boostPerLevel = recallDepthBoostPerLevel();
  const brainModule = levels[0].projectModule;
  /** @type {Map<string, SearchHit>} */
  const merged = new Map();
  for (const level of levels) {
    const filters = perLevelFilters(opts.filters, level, brainModule);
    const { records } = /** @type {{ records: SearchHit[] }} */ (
      await withWikiRoot(level.root, () => searchOneTree({ ...opts, limit: perLevelCap, filters }))
    );
    const resolvedRoot = realpathOr(level.root);
    const depthBoost = level.depth * boostPerLevel;
    for (const r of records) {
      const cosine = r.score;
      const adjustedConfidence = cosine + depthBoost;
      /** @type {SearchHit} */
      const tagged = {
        ...r,
        score: cosine,
        cosine,
        depth: level.depth,
        depthBoost,
        adjustedConfidence,
        projectModule: level.projectModule,
        resolvedRoot,
      };
      // Collapse only the SAME FILE ON DISK (same tree + same rel path); two
      // DIFFERENT trees sharing a rel path key differently and both survive.
      const key = `${resolvedRoot}\0${r.documentId}`;
      const prev = merged.get(key);
      if (!prev || adjustedConfidence > (prev.adjustedConfidence ?? -1)) {
        merged.set(key, tagged);
      }
    }
  }
  const records = [...merged.values()].sort(
    (a, b) => (b.adjustedConfidence ?? -1) - (a.adjustedConfidence ?? -1),
  );
  return { records };
}

/**
 * Search wiki memory, fanning out over the active WikiContext's levels when
 * there is more than one. With no context or a single level this is exactly
 * `searchOneTree`.
 * @param {SearchOneTreeOpts} [opts]
 * @returns {Promise<{ records: SearchHit[] }>}
 */
export async function searchMemoryFiltered(opts = {}) {
  const ctx = getActiveWikiContext();
  const levels = ctx && Array.isArray(ctx.levels) ? ctx.levels : [];
  if (levels.length <= 1) return searchOneTree(opts);
  return fanOutSearch(opts, levels);
}

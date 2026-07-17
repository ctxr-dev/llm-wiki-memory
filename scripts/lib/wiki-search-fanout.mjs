// Federated read fan-out (Phase E). `searchMemoryFiltered` is the public search
// door: when a multi-level WikiContext is active it runs the single-tree scorer
// (searchOneTree) once per level inside that level's `withWikiRoot` frame, tags
// every hit with the additive depth ranking, merges across levels with a
// tree-namespaced dedupe, and sorts by adjustedConfidence so a DEEPER / more-local
// level's hits outrank a shallower one's.
//
// The ranking is additive, BANDED, and level-locked:
//   adjustedConfidence = cosine + (cosine within recall.depthBoostBand of the
//                                  top hit ? depth * depthBoostPerLevel : 0)
// So a COMPARABLY-relevant deeper hit outranks the brain (per-repo memory is
// preferred), but a clearly-less-relevant deeper hit does NOT bury a
// strongly-relevant shallower one. `score` stays the honest cosine;
// `cosine`/`depth`/`depthBoost`/`adjustedConfidence` are separate fields.
//
// With NO active context OR a single level the door is byte-identical to the
// pre-fan-out single tree: it returns `searchOneTree` unchanged (no depth fields,
// same order, same slice). That is the regression guard the whole existing suite
// runs under.

import fs from "node:fs";
import { getActiveWikiContext } from "./wiki-context.mjs";
import { withWikiRoot } from "./env.mjs";
import {
  recallDepthBoostPerLevel,
  recallDepthBoostBand,
  recallSearchPerLevelCap,
} from "./settings.mjs";
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
 * @property {boolean} [chunkAware] score long leaves by best chunk (recall only)
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
// preserved across every level. (The brain's module equals what the doors inject
// AND what normaliseMeta stamps onto brain leaves — defaultProjectModule() — since
// the brain never adopts a layout project_id; see wiki-context.levelProjectModule.)
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
  const band = recallDepthBoostBand();
  const brainModule = levels[0].projectModule;
  // Pass 1: pull each level's hits and track the best cosine seen across ALL levels.
  /** @type {{ r: SearchHit, level: WikiLevel, resolvedRoot: string, cosine: number }[]} */
  const collected = [];
  let topCosine = -1;
  for (const level of levels) {
    const filters = perLevelFilters(opts.filters, level, brainModule);
    const resolvedRoot = realpathOr(level.root);
    /** @type {SearchHit[]} */
    let records = [];
    try {
      ({ records } = /** @type {{ records: SearchHit[] }} */ (
        await withWikiRoot(level.root, () =>
          searchOneTree({ ...opts, limit: perLevelCap, filters }),
        )
      ));
    } catch (err) {
      // Defense-in-depth: a single broken/unwritable LEVEL degrades to "contributes
      // nothing" rather than aborting the whole fan-out — the other levels (the
      // brain included) still return. Mirrors resolveWikiContext skipping a broken
      // repo sibling.
      console.error(
        `[search] level ${resolvedRoot} contributed nothing (${err instanceof Error ? err.message : String(err)})`,
      );
      records = [];
    }
    for (const r of records) {
      const cosine = r.score;
      if (cosine > topCosine) topCosine = cosine;
      collected.push({ r, level, resolvedRoot, cosine });
    }
  }
  // Pass 2: apply the BANDED depth boost. A hit earns its per-level boost ONLY when
  // its cosine is within `band` of the best hit for this query — so a comparably-
  // relevant DEEPER (repo) hit still outranks the brain, but a clearly-less-relevant
  // deeper hit can no longer bury a strongly-relevant shallower one. Merge collapses
  // only the SAME FILE ON DISK (same tree + rel path); two DIFFERENT trees sharing a
  // rel path key differently and both survive.
  /** @type {Map<string, SearchHit>} */
  const merged = new Map();
  for (const { r, level, resolvedRoot, cosine } of collected) {
    const boostEligible = cosine >= topCosine - band;
    const depthBoost = boostEligible ? level.depth * boostPerLevel : 0;
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
    const key = `${resolvedRoot}\0${r.documentId}`;
    const prev = merged.get(key);
    if (!prev || adjustedConfidence > (prev.adjustedConfidence ?? -1)) {
      merged.set(key, tagged);
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

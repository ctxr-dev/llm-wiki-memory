// topology-cache — path-keyed cache of compiled topologies with mtime-based
// revalidation. Internals are shared with the loader; the barrel re-exports
// only resetTopologyCache / _resetCacheForTests.

import fs from "node:fs";

// topology cache keyed by wikiRoot + categoryPath

// cacheKey -> { topo, deps:[absPaths], sig }. `deps` are the files the compiled
// topology was built from (layout.yaml + every referenced to_path_file /
// from_path_file); `sig` is their combined mtime. A cached entry is reused only
// while `sig` is unchanged, so a long-running MCP server picks up edits to the
// layout OR its sibling .mjs helpers without a restart.
export const _topologyCache = new Map();

// Combined mtime signature of a dep-path list (0 for an absent/unreadable file).
/**
 * @param {string[]} paths
 * @returns {string}
 */
export function sigOf(paths) {
  return paths
    .map((/** @type {string} */ p) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    })
    .join(":");
}

// Force the next loadTopology to rebuild. The mtime check already auto-reloads
// on edit; this is the explicit escape hatch (the `reload_layout` MCP tool) and
// the test reset.
export function resetTopologyCache() {
  _topologyCache.clear();
}

// Back-compat alias used by the test suite.
export function _resetCacheForTests() {
  resetTopologyCache();
}

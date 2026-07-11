import fs from "node:fs";
import path from "node:path";
import { embedCachePath, GC_STATE_PATH } from "./env.mjs";
import { gcIntervalDays } from "./settings.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { contentHash, loadCache, saveCache, removeFromCache } from "./embed.mjs";
import { root, walkLeaves } from "./wiki-core.mjs";
import { toRel } from "./wiki-identity.mjs";
import { ensureLayoutLoaded, getCategories } from "./wiki-layout-state.mjs";

/**
 * @typedef {Object} GcState
 * @property {string} [last_run_utc]
 * @property {number} [removed]
 */

/**
 * @param {string} id
 * @param {string} text
 * @returns {void}
 */
export function upsertEmbedding(id, text) {
  try {
    const cachePath = embedCachePath();
    const cache = loadCache(cachePath);
    const hash = contentHash(text);
    // Defer the (possibly async) vector compute to search time; we only mark
    // the entry stale here by removing any outdated vector. This keeps the
    // synchronous write path fast and avoids blocking hooks on model load.
    if (cache.entries[id] && cache.entries[id].hash !== hash) {
      delete cache.entries[id];
      saveCache(cachePath, cache);
    }
  } catch {
    /* cache is best-effort */
  }
}

/**
 * @param {string} id
 * @returns {void}
 */
export function removeEmbedding(id) {
  try {
    const cachePath = embedCachePath();
    const cache = loadCache(cachePath);
    if (cache.entries[id]) {
      removeFromCache(cache, id);
      saveCache(cachePath, cache);
    }
  } catch {
    /* best effort */
  }
}

// Move a cache entry from one id to another when a leaf is relocated but its
// content is unchanged (e.g. migrate-nest moving a flat leaf into a facet
// folder). The cached vector stays valid since the content hash is unchanged,
// so this avoids a cold re-embed of the whole moved corpus on the next search.
/**
 * @param {string} oldId
 * @param {string} newId
 * @returns {void}
 */
export function renameEmbedding(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  try {
    const cachePath = embedCachePath();
    const cache = loadCache(cachePath);
    if (cache.entries[oldId]) {
      cache.entries[newId] = cache.entries[oldId];
      delete cache.entries[oldId];
      saveCache(cachePath, cache);
    }
  } catch {
    /* best effort */
  }
}

// On-demand garbage collection for the embedding cache. The write path keeps
// the cache in sync for API-driven deletes/moves (removeEmbedding /
// renameEmbedding), but a leaf removed OUT OF BAND — a manual `rm`, a `git`
// checkout, a wiki wipe+re-migrate, or the skill's own balance/flatten moves —
// strands its cache entry forever (search only ever scores LIVE candidates, so
// orphans are never re-touched). This sweep drops every entry whose id is not a
// live leaf on disk. NOT wired into any background job — run it explicitly.
//
// Returns { ok, before, after, removed, removedIds } (removedIds capped at 50
// for reporting). A `dryRun` reports what WOULD be removed without writing.
//
// `ifDue` throttles the sweep: it runs only when at least MEMORY_GC_INTERVAL_DAYS
// have elapsed since the last recorded sweep (state/.embed-gc.json). When the
// interval is 0/off the sweep is disabled; when not yet due it is skipped. This
// is the path the SessionEnd embed-gc hook (and hook-less agents, per the rule)
// take so the cache self-cleans roughly weekly without running every session.
// A real (non-dry) sweep always rewrites the last-run timestamp — including a
// plain unconditional run — so the next due-check is measured from it.
export function pruneEmbeddingCache({ dryRun = false, ifDue = false } = {}) {
  if (ifDue) {
    const intervalDays = gcIntervalDays();
    if (intervalDays <= 0) {
      return { ok: true, skipped: "disabled", reason: "settings.gc.intervalDays is 0" };
    }
    const state = readGcState();
    const lastMs = state?.last_run_utc ? Date.parse(state.last_run_utc) : NaN;
    if (Number.isFinite(lastMs)) {
      const dueMs = lastMs + intervalDays * 86_400_000;
      if (Date.now() < dueMs) {
        return {
          ok: true,
          skipped: "not-due",
          intervalDays,
          last_run_utc: state?.last_run_utc,
          next_due_utc: new Date(dueMs).toISOString(),
        };
      }
    }
  }

  const cachePath = embedCachePath();
  const cache = loadCache(cachePath);
  const ids = Object.keys(cache.entries);
  const before = ids.length;

  // Live-leaf id set: toRel of every leaf under every category (all categories,
  // so we never wrongly prune a live leaf's entry — daily/issues included).
  ensureLayoutLoaded();
  const live = new Set();
  for (const cat of getCategories()) {
    for (const leaf of walkLeaves(path.join(root(), cat))) live.add(toRel(leaf));
  }

  const removedIds = ids.filter((id) => !live.has(id));
  if (!dryRun) {
    if (removedIds.length > 0) {
      for (const id of removedIds) delete cache.entries[id];
      saveCache(cachePath, cache);
    }
    // Stamp the last-run timestamp even when nothing was removed, so the
    // throttle clock advances on every actual sweep.
    writeGcState({ last_run_utc: new Date().toISOString(), removed: removedIds.length });
  }
  return {
    ok: true,
    cachePath,
    dryRun,
    before,
    after: before - (dryRun ? 0 : removedIds.length),
    removed: removedIds.length,
    removedIds: removedIds.slice(0, 50),
  };
}

// Throttle state for the embedding GC. Best-effort: a missing/corrupt file
// reads as "never run" (so the next --if-due sweep proceeds).
/**
 * @returns {GcState | null}
 */
function readGcState() {
  try {
    return /** @type {GcState} */ (JSON.parse(fs.readFileSync(GC_STATE_PATH, "utf8")));
  } catch {
    return null;
  }
}
/**
 * @param {GcState} state
 * @returns {void}
 */
function writeGcState(state) {
  try {
    fs.mkdirSync(path.dirname(GC_STATE_PATH), { recursive: true });
    writeFileAtomic(GC_STATE_PATH, JSON.stringify(state));
  } catch {
    /* best effort */
  }
}

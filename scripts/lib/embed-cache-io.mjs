import fs from "node:fs";
import path from "node:path";
import { embedModel, embedDtype, DEFAULT_EMBED_MODEL } from "./settings.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { defaultDtypeFor } from "./embed-inference.mjs";
import {
  warnBackendDiscard,
  stampStillDescribes,
  warnStampDrift,
  persistBlockReason,
} from "./embed-cache-guards.mjs";
import { enforceOneDim } from "./embed-cache-dims.mjs";
import { activeBackend, warnDowngradeOnce } from "./embed-backend-state.mjs";

// The on-disk cache format is THIS module's contract, so the types live here and
// the facade re-exports them. Sourcing them from embed.mjs would be a back-edge to
// a module that imports us — harmless while it is JSDoc-only, but it would read as
// permission to make it a real import later, which would be a genuine cycle.
/**
 * @typedef {Object} EmbedChunkVec
 * @property {string} hash
 * @property {number[]} vector
 */
/**
 * @typedef {Object} EmbedCacheEntry
 * @property {string} hash
 * @property {number[]} vector
 * @property {EmbedChunkVec[]} [chunks] chunk vectors for a long (truncated) leaf; recall-only
 */
/**
 * @typedef {Object} EmbedCache
 * @property {string} [model]
 * @property {string} [backend]
 * @property {string} [dtype]
 * @property {number} [dim]
 * @property {Record<string, EmbedCacheEntry>} entries
 * @property {boolean} [_dirty] in-memory only: set when a scoring pass embedded NEW vectors, so
 *   the search path can skip a no-op re-persist. Never serialized (saveCache writes entries only).
 */

// Persistence for the recall vector store: stamping, the in-process memo, and the
// guards that stop a degraded run from overwriting good vectors.
//
// Depends on embed-backend-state.mjs because a cache is only comparable within one
// model + backend, so it must know which backend actually resolved. That is the one
// legitimate direction; nothing here is imported back by the state machine.

// embedding cache keyed by leaf id + content hash

// The signature a cache is stamped with: the embed model AND the resolved
// backend. Vectors from a different model OR a different backend are not
// comparable (a lexical-256 vector and a transformer vector share neither
// dimension nor geometry), so a change in either invalidates the cache. The
// backend must be resolved (call after the first embed) for the comparison to
// be meaningful; before then it is the optimistic default.
/**
 * @returns {{ model: string, backend: string, dtype: string }}
 */
function cacheStamp() {
  const model = embedModel() || DEFAULT_EMBED_MODEL;
  return { model, backend: activeBackend(), dtype: embedDtype() || defaultDtypeFor(model) };
}

// The dimension of the first cached vector, or 0 when the cache is empty. Used
// to stamp the cache's `dim` at save time; a per-entry dim mismatch at score
// time is caught by `cosine`.
/**
 * @param {EmbedCache} cache
 * @returns {number}
 */
function cacheDim(cache) {
  for (const e of Object.values(cache.entries || {})) {
    if (Array.isArray(e?.vector)) return e.vector.length;
  }
  return 0;
}

// In-memory memo of the parsed cache per path, invalidated by the file's
// mtime+size. A long-running server (webapp/MCP) otherwise re-reads and
// re-parses megabytes of JSON on every search, blocking the event loop; the
// memo keeps ONE parsed copy resident (less churn than re-allocating it each
// call) and an external writer (cron/consolidate) is picked up via the mtime
// change. saveCache refreshes this entry so our own write is a memo hit, not a
// re-read.
/** @type {Map<string, { mtimeMs: number, size: number, cache: EmbedCache }>} */
const cacheByPath = new Map();

// Load the cache, invalidating (returning an empty cache) when it was built by
// a different model, a different backend, or — when the caller passes the dim
// it is about to score against — a different vector dimension. Invalidation is
// safe: lazy-embed rebuilds a dropped cache on first use (m7 self-heal).
/**
 * @param {string} cachePath
 * @param {number} [expectedDim] the current query/scoring dim; 0/omitted skips the dim check
 * @returns {EmbedCache}
 */
export function loadCache(cachePath, expectedDim = 0) {
  const { model, backend, dtype } = cacheStamp();
  let stat;
  try {
    stat = fs.statSync(cachePath);
  } catch {
    return { model, backend, dtype, dim: 0, entries: {} };
  }
  // A cache written before dtype stamping (c.dtype undefined) matches any dtype;
  // a stamped cache must match, so a q4<->q8 flip re-embeds instead of scoring a
  // mixed-precision pair.
  /** @param {EmbedCache} c @returns {boolean} */
  const valid = (c) =>
    c.model === model &&
    c.backend === backend &&
    (c.dtype === undefined || c.dtype === dtype) &&
    (!(expectedDim > 0) || c.dim === expectedDim);
  const memo = cacheByPath.get(cachePath);
  if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size && valid(memo.cache)) {
    // Also on the HIT path: the memoized object is SHARED with whoever is still filling it, so
    // a reader could otherwise score a writer's mid-run degraded vectors. Costs ~0.8ms on a
    // 5000-entry cache against a 281ms parse, so it is not worth skipping.
    enforceOneDim(cachePath, memo.cache, expectedDim || stampedDim(memo.cache), "load");
    return memo.cache;
  }
  try {
    const raw = /** @type {EmbedCache} */ (JSON.parse(fs.readFileSync(cachePath, "utf8")));
    if (raw && typeof raw === "object" && raw.entries && valid(raw)) {
      // Repair on read, so a cache poisoned before this check heals itself: a dropped entry
      // reads as a MISS, and the next warm recomputes it. Nine of ten callers pass no
      // expectedDim, and `sliceIsWarm` would otherwise call a mismatched entry warm forever.
      enforceOneDim(cachePath, raw, expectedDim || stampedDim(raw), "load");
      cacheByPath.set(cachePath, { mtimeMs: stat.mtimeMs, size: stat.size, cache: raw });
      return raw;
    }
    warnBackendDiscard(cachePath, raw, backend);
  } catch {
    /* fresh cache */
  }
  return { model, backend, dtype, dim: 0, entries: {} };
}

// The dimension a cache file claims for itself, or 0. Used as the repair authority when the
// caller has no live dimension to offer — which is 10 of the 11 loadCache call sites, `warm`
// (the primary heal path) among them. It is trustworthy for the shape that actually occurs: the
// entries loaded from the clean file are inserted first, so `cacheDim` sampled a healthy vector
// and the stamp records the healthy dimension. Using it also keeps the two doors coherent —
// otherwise `save` trusted the stamp that `load` distrusted, and one run kept both dimensions
// in turn.
/**
 * @param {EmbedCache} cache
 * @returns {number}
 */
function stampedDim(cache) {
  return typeof cache?.dim === "number" && cache.dim > 0 ? cache.dim : 0;
}

// Why persisting would corrupt the cache at `cachePath`, or "" when safe.
// The reasons live in embed-cache-guards.mjs; see .agents/rules/defensive-invariants.md
// for why there are TWO of them and why the second one stays even though a derivation
// says it cannot fire.
/**
 * @param {string} cachePath
 * @param {EmbedCache} cache
 * @returns {void}
 */
export function saveCache(cachePath, cache) {
  const blockReason = persistBlockReason(cachePath);
  if (blockReason) {
    // `cache` IS the memoized object, mutated in place with vectors we are not
    // persisting; evict it or the next memo hit serves wrong-dimension entries.
    cacheByPath.delete(cachePath);
    warnDowngradeOnce(
      `embed.mjs: cache persistence suspended (${blockReason}) for ${cachePath} by ${process.argv[1] || "process"}; on-disk cache left authoritative\n`,
    );
    return;
  }
  // This is the ONLY persistence path for the recall vector store, and it is
  // written off-lock by BOTH the long-running MCP server (every search +
  // every save) and the hourly cron (compile / consolidate / detached flush
  // workers). A fixed shared `.tmp` name guarantees those writer populations
  // collide and rename a byte-interleaved (invalid-JSON) file into place;
  // loadCache then silently swallows the parse error and resets to an empty
  // cache, forcing a full-corpus cold re-embed. writeFileAtomic's unique
  // pid+uuid temp + data fsync eliminates both the collision and the torn
  // write — the same discipline every other durable write here already uses.
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  // Re-stamp from the current (resolved) signature so the persisted file
  // records the model/backend/dim that actually produced its vectors — a
  // mid-run transformer→lexical fallback thus self-heals on the next load.
  const { model, backend, dtype } = cacheStamp();
  // A cache object is held open across a whole warm run (loaded once per category,
  // then filled slice-by-slice with a deliberate duty-cycle pause between slices),
  // so a settings edit lands INSIDE that window by design. Re-stamping the map
  // wholesale would then assert that vectors from the previous model/dtype were
  // produced by the current one — and a q4->q8 flip preserves the vector dimension,
  // so loadCache's file-level check could never detect the lie afterwards. Drop
  // those vectors instead, and re-stamp the object so the remainder of the run
  // accumulates against the new config cleanly rather than drifting on every save.
  if (!stampStillDescribes(cache, { model, backend, dtype })) {
    warnStampDrift(cachePath, cache, { model, backend, dtype });
    // Re-stamp the in-memory object and drop what the old signature produced, then RETURN
    // without writing. Writing an empty map would destroy on-disk vectors that are valid
    // under the now-live signature (a concurrent writer's work included); loadCache rejects
    // a stale stamp on its own, and the re-stamped object lets the rest of this run
    // accumulate correctly so the next save persists the new vectors.
    cache.entries = {};
    cache.model = model;
    cache.backend = backend;
    cache.dtype = dtype;
    cacheByPath.delete(cachePath);
    return;
  }
  // A mix must never reach the file, whatever produced it — the drift check above only
  // catches a changed SIGNATURE, and this map can be mixed while the signature is unchanged
  // (a fallback that recovered mid-run leaves the stamp matching).
  enforceOneDim(cachePath, cache, stampedDim(cache), "save");
  const stamped = { model, backend, dtype, dim: cacheDim(cache), entries: cache.entries || {} };
  writeFileAtomic(cachePath, JSON.stringify(stamped));
  // Refresh the memo so the next loadCache in this process is a hit against the
  // bytes we just wrote (not a re-read), and so an mtime-based external-write
  // check still fires for OTHER writers.
  try {
    const stat = fs.statSync(cachePath);
    cacheByPath.set(cachePath, { mtimeMs: stat.mtimeMs, size: stat.size, cache: stamped });
  } catch {
    /* memo refresh is best-effort */
  }
}

/**
 * @param {EmbedCache} cache
 * @param {string} id
 * @returns {void}
 */
export function removeFromCache(cache, id) {
  if (cache.entries[id]) delete cache.entries[id];
}

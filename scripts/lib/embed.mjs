import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { envValue } from "./env.mjs";
import {
  embedBackend,
  embedModel,
  embedDtype,
  embedThreads,
  DEFAULT_EMBED_MODEL,
} from "./settings.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { lexicalVector } from "./embed-lexical.mjs";
import {
  createEmbedder,
  applyPrompt,
  embedWindowFor,
  defaultDtypeFor,
} from "./embed-inference.mjs";

export { cosine, tensorRows } from "./embed-lexical.mjs";

// Local recall engine: ranks a free-text query against wiki leaves by cosine over
// transformer embeddings (DEFAULT_EMBED_MODEL via @huggingface/transformers, model
// families + prompts resolved in embed-inference.mjs), with a deterministic
// lexical fallback so the system never hard-fails on a missing model download.
// A model change invalidates the vector cache (loadCache stamps + checks it), so
// vectors recompute on the next search/warm; see the README model table.

/**
 * @typedef {Object} Tokenizer
 * @property {(t: string, opts?: unknown) => unknown[]} encode
 * @property {(ids: unknown[], opts?: unknown) => string} decode
 */

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

/** @type {Promise<(texts: string[]) => Promise<number[][]>> | null} */
let _inProcessEmbedder = null;
/** @type {string | null} */
let _backend = null; // "transformers" | "lexical"
// Model-load failures fall back to lexical only until this instant, then retry —
// a permanent latch once let a degraded process re-stamp real caches lexical/256.
let _fallbackUntil = 0;
let _warnedDowngrade = false;
const FALLBACK_RETRY_MS = 30_000;

function configuredBackend() {
  return (embedBackend() || "").toLowerCase();
}

/**
 * @param {string | null} active @param {number} fallbackUntil @param {number} now @returns {boolean}
 */
export function fallbackActive(active, fallbackUntil, now) {
  return active === "lexical" && fallbackUntil > now;
}

// Degraded = a model backend was configured but recall resolved to lexical.
// Keyed on `!== "lexical"` so a misspelled backend value can't slip the guard.
/**
 * @param {string} configured @param {string | null} active @returns {boolean}
 */
export function persistSuspended(configured, active) {
  return configured !== "lexical" && active === "lexical";
}

function inFallbackWindow() {
  return fallbackActive(_backend, _fallbackUntil, Date.now());
}

function noteTransformerSuccess() {
  _backend = "transformers";
  _fallbackUntil = 0;
  _warnedDowngrade = false;
  _warnedWorkerFallback = false;
}

// Inference runs in a worker thread (opt out: LWM_EMBED_NO_WORKER=1) because the
// onnxruntime forward pass is a synchronous native call that would otherwise block
// the event loop. A worker failure routes to the same lexical-fallback window as a
// model failure — retrying in-process here would reintroduce the block.
/** @typedef {{ postMessage: (m: unknown) => void, on: (e: string, cb: (arg: any) => void) => void, ref?: () => void, unref?: () => void, terminate?: () => void }} EmbedWorker */
/** @typedef {{ worker: EmbedWorker, pending: Map<number, { resolve: (v: number[][]) => void, reject: (e: Error) => void }> }} WorkerHandle */
/** @type {WorkerHandle | null} */
let _workerHandle = null;
let _workerSeq = 0;
let _warnedWorkerFallback = false;

/** @returns {EmbedWorker} */
function defaultWorkerFactory() {
  // execArgv: [] — inherited parent flags (--test, --input-type, --import guards)
  // are meaningless or fatal for the worker's plain file entry.
  return /** @type {EmbedWorker} */ (
    /** @type {unknown} */ (
      new Worker(new URL("./embed-worker.mjs", import.meta.url), { execArgv: [] })
    )
  );
}
/** @type {() => EmbedWorker} */
let _workerFactory = defaultWorkerFactory;

/** @param {WorkerHandle | null} handle @param {Error} error */
function rejectAllPending(handle, error) {
  if (!handle) return;
  for (const pending of handle.pending.values()) pending.reject(error);
  handle.pending.clear();
}

/**
 * @param {(() => EmbedWorker) | null} [factory]
 * @returns {void}
 */
export function __setWorkerFactoryForTest(factory) {
  const old = _workerHandle;
  _workerHandle = null;
  rejectAllPending(old, new Error("embed worker replaced for test"));
  if (old && typeof old.worker.terminate === "function") {
    try {
      old.worker.terminate();
    } catch {
      /* best effort */
    }
  }
  _warnedWorkerFallback = false;
  _workerFactory = factory || defaultWorkerFactory;
}

function workerEnabled() {
  return process.env.LWM_EMBED_NO_WORKER !== "1";
}

/** @returns {WorkerHandle} */
function getWorkerHandle() {
  if (_workerHandle) return _workerHandle;
  /** @type {WorkerHandle} */
  const handle = { worker: _workerFactory(), pending: new Map() };
  // Per-handle pending map: a dead worker fires both `error` and `exit`, and must
  // never reject a successor worker's requests.
  const failAll = (/** @type {unknown} */ err) => {
    if (_workerHandle === handle) _workerHandle = null;
    rejectAllPending(handle, err instanceof Error ? err : new Error(String(err)));
  };
  handle.worker.on("message", (m) => {
    const pending = handle.pending.get(m?.id);
    if (!pending) return;
    handle.pending.delete(m.id);
    syncWorkerRef(handle);
    if (m.ok) pending.resolve(m.vectors);
    else pending.reject(new Error(m.error || "embed worker error"));
  });
  handle.worker.on("error", failAll);
  handle.worker.on("exit", (code) => failAll(new Error(`embed worker exited (code ${code})`)));
  syncWorkerRef(handle);
  _workerHandle = handle;
  return handle;
}

// An unref'd worker cannot hold the process open, and a pending promise alone
// never does — so a one-shot CLI would exit mid-inference without the ref.
/** @param {WorkerHandle} handle */
function syncWorkerRef(handle) {
  if (handle.pending.size > 0) handle.worker.ref?.();
  else handle.worker.unref?.();
}

/**
 * @param {string[]} texts @param {number} batchSize
 * @returns {Promise<number[][]>}
 */
function runInWorker(texts, batchSize) {
  const handle = getWorkerHandle();
  const id = (_workerSeq += 1);
  const { model, dtype, threads, cacheDir } = inferenceConfig();
  return new Promise((resolve, reject) => {
    handle.pending.set(id, { resolve, reject });
    syncWorkerRef(handle);
    try {
      handle.worker.postMessage({ id, texts, batchSize, model, dtype, threads, cacheDir });
    } catch (err) {
      handle.pending.delete(id);
      syncWorkerRef(handle);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * @param {string[]} list @param {number} batchSize
 * @returns {Promise<number[][]>}
 */
async function embedBatch(list, batchSize) {
  if (!workerEnabled()) return embedManyInProcess(list, batchSize);
  try {
    return await runInWorker(list, batchSize);
  } catch (err) {
    if (!_warnedWorkerFallback) {
      process.stderr.write(
        `embed.mjs: inference worker unavailable (${err instanceof Error ? err.message : err})\n`,
      );
      _warnedWorkerFallback = true;
    }
    throw err;
  }
}

// Shared config for the worker message AND the in-process fallback, so both
// construct the identical embedder. MEMORY_EMBED_CACHE_DIR is read via envValue
// (not process.env) so a value set only in settings/.env is still honoured.
/**
 * @returns {{ model: string, dtype: string | undefined, threads: number, cacheDir: string | undefined }}
 */
function inferenceConfig() {
  return {
    model: embedModel() || DEFAULT_EMBED_MODEL,
    dtype: embedDtype() || undefined,
    threads: embedThreads(),
    cacheDir: envValue("MEMORY_EMBED_CACHE_DIR") || undefined,
  };
}

/**
 * @param {string[]} list @param {number} batchSize
 * @returns {Promise<number[][]>}
 */
async function embedManyInProcess(list, batchSize) {
  if (!_inProcessEmbedder) _inProcessEmbedder = createEmbedder(inferenceConfig());
  const embedder = await _inProcessEmbedder;
  const size = batchSize > 0 ? batchSize : list.length;
  /** @type {number[][]} */
  const vectors = [];
  for (let i = 0; i < list.length; i += size) {
    vectors.push(...(await embedder(list.slice(i, i + size))));
  }
  return vectors;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function contentHash(text) {
  return crypto
    .createHash("sha256")
    .update(String(text || ""))
    .digest("hex");
}

/**
 * @param {unknown} err
 * @returns {void}
 */
function noteLexicalFallback(err) {
  if (!inFallbackWindow()) {
    process.stderr.write(
      `embed.mjs: transformer backend unavailable (${err instanceof Error ? err.message : err}); serving lexical similarity in-memory, cache persistence suspended, retrying the model in ${FALLBACK_RETRY_MS / 1000}s\n`,
    );
  }
  _backend = "lexical";
  _fallbackUntil = Date.now() + FALLBACK_RETRY_MS;
  _inProcessEmbedder = null; // drop the rejected embedder so the retry re-loads the model
}

/**
 * @param {string} text
 * @param {"query" | "document"} [kind]
 * @returns {Promise<number[]>}
 */
export async function embed(text, kind = "query") {
  const [vector] = await embedMany([String(text || "")], { kind });
  return vector || lexicalVector(text);
}

// Batch-embed many strings through ONE model, returning vectors aligned to input
// order. `kind` selects the model's retrieval prompt (query vs document) — the
// prefix is applied at inference time only, never in cache hashes, so leaf
// identity stays content-based. Lexical vectors always use the raw text.
const EMBED_BATCH_SIZE = 32;
/**
 * @param {string[]} texts
 * @param {number | { batchSize?: number, kind?: "query" | "document" }} [opts]
 * @returns {Promise<number[][]>}
 */
export async function embedMany(texts, opts = {}) {
  const { batchSize = EMBED_BATCH_SIZE, kind = "document" } =
    typeof opts === "number" ? { batchSize: opts } : opts;
  const list = Array.isArray(texts) ? texts.map((t) => String(t || "")) : [];
  if (list.length === 0) return [];
  const forced = configuredBackend();
  if (forced === "lexical") {
    _backend = "lexical";
    return list.map(lexicalVector);
  }
  if (inFallbackWindow()) return list.map(lexicalVector);
  try {
    const prompted = applyPrompt(embedModel() || DEFAULT_EMBED_MODEL, kind, list);
    const vectors = await embedBatch(prompted, batchSize);
    noteTransformerSuccess();
    return vectors;
  } catch (err) {
    noteLexicalFallback(err);
    return list.map(lexicalVector);
  }
}

export function activeBackend() {
  return _backend || configuredBackend() || "transformers";
}

// The configured model's input window, for length-aware chunking.
/** @returns {number} */
export function embedWindow() {
  return embedWindowFor(embedModel() || DEFAULT_EMBED_MODEL);
}

// AutoTokenizer standalone (vocab only, no ONNX weights) — inference lives in the
// worker, so loading the full pipeline here would double the model in memory.
/** @type {Promise<Tokenizer> | null} */
let _tokenizerPromise = null;
/**
 * @returns {Promise<Tokenizer | null>}
 */
export async function getTokenizer() {
  if (configuredBackend() === "lexical" || inFallbackWindow()) return null;
  try {
    if (!_tokenizerPromise) {
      _tokenizerPromise = (async () => {
        const model = embedModel() || DEFAULT_EMBED_MODEL;
        const { AutoTokenizer, env } = await import("@huggingface/transformers");
        const cacheDir = envValue("MEMORY_EMBED_CACHE_DIR");
        if (cacheDir) env.cacheDir = cacheDir;
        return /** @type {Tokenizer} */ (
          /** @type {unknown} */ (await AutoTokenizer.from_pretrained(model))
        );
      })();
    }
    return await _tokenizerPromise;
  } catch {
    _tokenizerPromise = null;
    return null;
  }
}

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
    return { model, backend, dim: 0, entries: {} };
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
    return memo.cache;
  }
  try {
    const raw = /** @type {EmbedCache} */ (JSON.parse(fs.readFileSync(cachePath, "utf8")));
    if (raw && typeof raw === "object" && raw.entries && valid(raw)) {
      cacheByPath.set(cachePath, { mtimeMs: stat.mtimeMs, size: stat.size, cache: raw });
      return raw;
    }
  } catch {
    /* fresh cache */
  }
  return { model, backend, dim: 0, entries: {} };
}

// Reads disk, not the memo: a stale memo (external heal upgraded the file) would
// wrongly permit the downgrade this guards against; only the cold lexical-save
// path reaches here, so the read is off the hot path.
/**
 * @param {string} cachePath
 * @returns {string}
 */
function existingCacheBackend(cachePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return typeof raw?.backend === "string" ? raw.backend.toLowerCase() : "";
  } catch {
    return "";
  }
}

// Why persisting would corrupt the cache at `cachePath`, or "" when safe. Never
// downgrade transformers→lexical; the reverse (the reconcile/heal) is allowed.
/**
 * @param {string} cachePath
 * @returns {string}
 */
function persistBlockReason(cachePath) {
  if (persistSuspended(configuredBackend(), _backend)) return "degraded-fallback";
  const resolved = (activeBackend() || "").toLowerCase();
  if (resolved === "lexical" && existingCacheBackend(cachePath) === "transformers") {
    return "lexical-over-transformers";
  }
  return "";
}

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
    if (!_warnedDowngrade) {
      process.stderr.write(
        `embed.mjs: cache persistence suspended (${blockReason}) for ${cachePath} by ${process.argv[1] || "process"}; on-disk cache left authoritative\n`,
      );
      _warnedDowngrade = true;
    }
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

/**
 * @param {{ backend?: string | null, fallbackUntil?: number }} [state]
 * @returns {void}
 */
export function __setBackendStateForTest({ backend = null, fallbackUntil = 0 } = {}) {
  _backend = backend;
  _fallbackUntil = fallbackUntil;
  _warnedDowngrade = false;
}

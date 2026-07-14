import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { envValue } from "./env.mjs";
import { embedBackend, embedModel, DEFAULT_EMBED_MODEL } from "./settings.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { lexicalVector } from "./embed-lexical.mjs";

export { cosine } from "./embed-lexical.mjs";

// Local recall engine. The skill-llm-wiki package has NO query/search command
// (retrieval is "walk the index tree" by design), so ranking a free-text query
// against existing leaves is our job. Primary backend is transformer embeddings
// (DEFAULT_EMBED_MODEL, from settings.mjs) via @xenova/transformers (already a transitive dep of the
// skill); we fall back to a deterministic lexical cosine if the model can't load,
// so the system never hard-fails on a missing model download.

// bge-large-en-v1.5 is the strongest drop-in retrieval model for this engine
// (mean-pooled, no query prefix); quantized ONNX via @xenova/transformers, ~340MB on
// first download. Override with MEMORY_EMBED_MODEL (e.g. a lighter
// Xenova/bge-small-en-v1.5 for a smaller footprint; see the README model table). A model
// change invalidates the vector cache (loadCache stamps + checks the model), so vectors
// recompute on next search. The default value (DEFAULT_EMBED_MODEL) is imported from
// settings.mjs so the fallback model name lives in exactly one place.

/** @typedef {import("@xenova/transformers").FeatureExtractionPipeline} FeatureExtractionPipeline */

/**
 * @typedef {Object} EmbedCacheEntry
 * @property {string} hash
 * @property {number[]} vector
 */

/**
 * @typedef {Object} EmbedCache
 * @property {string} [model]
 * @property {string} [backend]
 * @property {number} [dim]
 * @property {Record<string, EmbedCacheEntry>} entries
 */

/** @type {Promise<FeatureExtractionPipeline> | null} */
let _extractorPromise = null;
/** @type {string | null} */
let _backend = null; // "transformers" | "lexical"

function configuredBackend() {
  return (embedBackend() || "").toLowerCase();
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
 * @returns {Promise<FeatureExtractionPipeline>}
 */
async function getExtractor() {
  if (_extractorPromise) return _extractorPromise;
  _extractorPromise = (async () => {
    const model = embedModel() || DEFAULT_EMBED_MODEL;
    const { pipeline, env } = await import("@xenova/transformers");
    // Keep model cache local + offline-friendly once downloaded. Read via
    // envValue (not process.env) so a value set only in settings/.env — not the
    // live shell — is still honoured, consistent with every other strict key.
    const embedCacheDir = envValue("MEMORY_EMBED_CACHE_DIR");
    if (embedCacheDir) {
      env.cacheDir = embedCacheDir;
    }
    return pipeline("feature-extraction", model);
  })();
  return _extractorPromise;
}

// Model download / load failed: degrade to lexical for the rest of the process.
// Surface once on stderr for forensics, then latch the backend.
/**
 * @param {unknown} err
 * @returns {void}
 */
function noteLexicalFallback(err) {
  if (_backend !== "lexical") {
    process.stderr.write(
      `embed.mjs: transformer backend unavailable (${err instanceof Error ? err.message : err}); falling back to lexical similarity\n`,
    );
  }
  _backend = "lexical";
}

// Embed a single string. Resolves the backend once and sticks with it.
/**
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embed(text) {
  const forced = configuredBackend();
  if (forced === "lexical") {
    _backend = "lexical";
    return lexicalVector(text);
  }
  if (_backend === "lexical") return lexicalVector(text);
  try {
    const extractor = await getExtractor();
    const out = await extractor(String(text || ""), { pooling: "mean", normalize: true });
    _backend = "transformers";
    return Array.from(out.data);
  } catch (err) {
    noteLexicalFallback(err);
    return lexicalVector(text);
  }
}

// Batch-embed many strings through ONE model, returning vectors aligned to input
// order. The transformer pipeline takes an array and runs each chunk as a single
// padded forward pass — one model in memory, never duplicated (a worker pool
// would load the ~340MB model once PER worker; see docs/embeddings.md). Chunking
// bounds the working-set tensor; the batch is a throughput win of ~10% on
// bge-large (the model dominates), larger on lighter models. Same backend
// resolution + lexical fallback as embed().
const EMBED_BATCH_SIZE = 32;
/**
 * @param {string[]} texts
 * @param {number} [batchSize]
 * @returns {Promise<number[][]>}
 */
export async function embedMany(texts, batchSize = EMBED_BATCH_SIZE) {
  const list = Array.isArray(texts) ? texts.map((t) => String(t || "")) : [];
  if (list.length === 0) return [];
  const forced = configuredBackend();
  if (forced === "lexical" || _backend === "lexical") {
    _backend = "lexical";
    return list.map(lexicalVector);
  }
  try {
    const extractor = await getExtractor();
    const size = batchSize > 0 ? batchSize : list.length;
    /** @type {number[][]} */
    const vectors = [];
    for (let i = 0; i < list.length; i += size) {
      const chunk = list.slice(i, i + size);
      const out = await extractor(chunk, { pooling: "mean", normalize: true });
      const dim = out.dims[out.dims.length - 1];
      for (let r = 0; r < chunk.length; r += 1) {
        vectors.push(Array.from(out.data.slice(r * dim, (r + 1) * dim)));
      }
    }
    _backend = "transformers";
    return vectors;
  } catch (err) {
    noteLexicalFallback(err);
    return list.map(lexicalVector);
  }
}

export function activeBackend() {
  return _backend || configuredBackend() || "transformers";
}

// embedding cache keyed by leaf id + content hash

// The signature a cache is stamped with: the embed model AND the resolved
// backend. Vectors from a different model OR a different backend are not
// comparable (a lexical-256 vector and a transformer vector share neither
// dimension nor geometry), so a change in either invalidates the cache. The
// backend must be resolved (call after the first embed) for the comparison to
// be meaningful; before then it is the optimistic default.
/**
 * @returns {{ model: string, backend: string }}
 */
function cacheStamp() {
  return { model: embedModel() || DEFAULT_EMBED_MODEL, backend: activeBackend() };
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
  const { model, backend } = cacheStamp();
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const stampOk =
      raw &&
      typeof raw === "object" &&
      raw.entries &&
      raw.model === model &&
      raw.backend === backend;
    const dimOk = !(expectedDim > 0) || raw.dim === expectedDim;
    if (stampOk && dimOk) return raw;
  } catch {
    /* fresh cache */
  }
  return { model, backend, dim: 0, entries: {} };
}

/**
 * @param {string} cachePath
 * @param {EmbedCache} cache
 * @returns {void}
 */
export function saveCache(cachePath, cache) {
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
  const { model, backend } = cacheStamp();
  const stamped = { model, backend, dim: cacheDim(cache), entries: cache.entries || {} };
  writeFileAtomic(cachePath, JSON.stringify(stamped));
}

// Batched cache fill for ONE cache: reuse entries whose content hash is
// unchanged, embed the MISSES in a single batched call (embedMany), store them,
// and return vectors aligned to `items` order. Mutates `cache` in memory; the
// caller persists. Batching the misses is what turns a cold N-leaf category warm
// (or first search) from N serial model calls into ceil(N/batch) forward passes.
/**
 * @param {EmbedCache} cache
 * @param {{ id: string, text: string }[]} items
 * @returns {Promise<number[][]>}
 */
export async function cachedEmbeddings(cache, items) {
  const list = Array.isArray(items) ? items : [];
  /** @type {number[][]} */
  const out = new Array(list.length);
  /** @type {{ idx: number, id: string, hash: string }[]} */
  const misses = [];
  /** @type {string[]} */
  const missTexts = [];
  for (let i = 0; i < list.length; i += 1) {
    const { id, text } = list[i];
    const hash = contentHash(text);
    const existing = cache.entries[id];
    if (existing && existing.hash === hash && Array.isArray(existing.vector)) {
      out[i] = existing.vector;
    } else {
      misses.push({ idx: i, id, hash });
      missTexts.push(text);
    }
  }
  if (missTexts.length > 0) {
    const vecs = await embedMany(missTexts);
    for (let k = 0; k < misses.length; k += 1) {
      const { idx, id, hash } = misses[k];
      cache.entries[id] = { hash, vector: vecs[k] };
      out[idx] = vecs[k];
    }
  }
  return out;
}

/**
 * @param {EmbedCache} cache
 * @param {string} id
 * @returns {void}
 */
export function removeFromCache(cache, id) {
  if (cache.entries[id]) delete cache.entries[id];
}

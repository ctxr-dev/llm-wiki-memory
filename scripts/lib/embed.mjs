import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { envValue } from "./env.mjs";
import { embedBackend, embedModel, DEFAULT_EMBED_MODEL } from "./settings.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";

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

// Deterministic lexical embedding: hashed bag-of-tokens into a fixed-width
// vector. Not semantic, but stable and dependency-free; used only when the
// transformer backend is unavailable.
const LEXICAL_DIM = 256;
/**
 * @param {string} text
 * @returns {number[]}
 */
function lexicalVector(text) {
  const vec = new Array(LEXICAL_DIM).fill(0);
  const tokens = String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  for (const tok of tokens) {
    const h = crypto.createHash("md5").update(tok).digest();
    const idx = h.readUInt16BE(0) % LEXICAL_DIM;
    vec[idx] += 1;
  }
  return l2normalize(vec);
}

/**
 * @param {number[]} vec
 * @returns {number[]}
 */
function l2normalize(vec) {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
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
    // Model download / load failed: degrade to lexical for the rest of the
    // process. Surface once on stderr for forensics.
    if (_backend !== "lexical") {
      process.stderr.write(
        `embed.mjs: transformer backend unavailable (${err instanceof Error ? err.message : err}); falling back to lexical similarity\n`,
      );
    }
    _backend = "lexical";
    return lexicalVector(text);
  }
}

export function activeBackend() {
  return _backend || configuredBackend() || "transformers";
}

// embedding cache keyed by leaf id + content hash

/**
 * @param {string} cachePath
 * @returns {EmbedCache}
 */
export function loadCache(cachePath) {
  const currentModel = embedModel() || DEFAULT_EMBED_MODEL;
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    // Drop the cache when the embedding model changed: vectors from a different
    // model are not comparable, so reusing them would corrupt similarity ranking.
    if (raw && typeof raw === "object" && raw.entries && raw.model === currentModel) return raw;
  } catch {
    /* fresh cache */
  }
  return { model: currentModel, entries: {} };
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
  writeFileAtomic(cachePath, JSON.stringify(cache));
}

// Return the embedding for `id`, recomputing only when the content hash
// changed. Mutates `cache` in memory; caller persists.
/**
 * @param {EmbedCache} cache
 * @param {string} id
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function cachedEmbedding(cache, id, text) {
  const hash = contentHash(text);
  const existing = cache.entries[id];
  if (existing && existing.hash === hash && Array.isArray(existing.vector)) {
    return existing.vector;
  }
  const vector = await embed(text);
  cache.entries[id] = { hash, vector };
  return vector;
}

/**
 * @param {EmbedCache} cache
 * @param {string} id
 * @returns {void}
 */
export function removeFromCache(cache, id) {
  if (cache.entries[id]) delete cache.entries[id];
}

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { envValue } from "./env.mjs";

// Local recall engine. The skill-llm-wiki package has NO query/search command
// (retrieval is "walk the index tree" by design), so ranking a free-text query
// against existing leaves is our job. Primary backend is transformer embeddings
// (DEFAULT_MODEL below) via @xenova/transformers (already a transitive dep of the
// skill); we fall back to a deterministic lexical cosine if the model can't load,
// so the system never hard-fails on a missing model download.

// bge-large-en-v1.5 is the strongest drop-in retrieval model for this engine
// (mean-pooled, no query prefix); quantized ONNX via @xenova/transformers, ~340MB on
// first download. Override with MEMORY_EMBED_MODEL (e.g. a lighter
// Xenova/bge-small-en-v1.5 for a smaller footprint; see the README model table). A model
// change invalidates the vector cache (loadCache stamps + checks the model), so vectors
// recompute on next search.
const DEFAULT_MODEL = "Xenova/bge-large-en-v1.5";

let _extractorPromise = null;
let _backend = null; // "transformers" | "lexical"

function configuredBackend() {
  return (envValue("MEMORY_EMBED_BACKEND", "") || "").toLowerCase();
}

export function contentHash(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

async function getExtractor() {
  if (_extractorPromise) return _extractorPromise;
  _extractorPromise = (async () => {
    const model = envValue("MEMORY_EMBED_MODEL", DEFAULT_MODEL);
    const { pipeline, env } = await import("@xenova/transformers");
    // Keep model cache local + offline-friendly once downloaded.
    if (process.env.MEMORY_EMBED_CACHE_DIR) {
      env.cacheDir = process.env.MEMORY_EMBED_CACHE_DIR;
    }
    return pipeline("feature-extraction", model);
  })();
  return _extractorPromise;
}

// Deterministic lexical embedding: hashed bag-of-tokens into a fixed-width
// vector. Not semantic, but stable and dependency-free; used only when the
// transformer backend is unavailable.
const LEXICAL_DIM = 256;
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

function l2normalize(vec) {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

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

// ---- embedding cache (keyed by leaf id + content hash) ----

export function loadCache(cachePath) {
  const currentModel = envValue("MEMORY_EMBED_MODEL", DEFAULT_MODEL);
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

export function saveCache(cachePath, cache) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, cachePath);
}

// Return the embedding for `id`, recomputing only when the content hash
// changed. Mutates `cache` in memory; caller persists.
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

export function removeFromCache(cache, id) {
  if (cache.entries[id]) delete cache.entries[id];
}

// Rank candidates ({id, text}) against a query. Returns [{id, score}] sorted
// desc. Uses (and updates) the on-disk cache so repeated ranks recompute only
// changed leaves.
export async function rank({ query, candidates, cachePath }) {
  const cache = cachePath ? loadCache(cachePath) : { entries: {} };
  const queryVec = await embed(query);
  const scored = [];
  for (const c of candidates) {
    const vec = await cachedEmbedding(cache, c.id, c.text);
    scored.push({ id: c.id, score: cosine(queryVec, vec) });
  }
  if (cachePath) saveCache(cachePath, cache);
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

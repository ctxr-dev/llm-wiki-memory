import crypto from "node:crypto";
import { envValue } from "./env.mjs";
import { embedModel, DEFAULT_EMBED_MODEL } from "./settings.mjs";
import { lexicalVector } from "./embed-lexical.mjs";
import { embedBatch, dropInProcessEmbedder, resetWorkerWarning } from "./embed-runner.mjs";
import {
  configuredBackend,
  inFallbackWindow,
  activeBackend,
  noteSuccess,
  noteForcedLexical,
  noteFallback,
} from "./embed-backend-state.mjs";
import { applyPrompt, embedWindowFor, applyCacheDir } from "./embed-inference.mjs";
import { keyedMemo, inferenceKey } from "./keyed-memo.mjs";
import { makeDownloadReporter } from "./model-download-progress.mjs";

export { cosine, tensorRows } from "./embed-lexical.mjs";
// Facade: the embedding subsystem's public surface stays here, so no importer
// cares that the implementation now lives in focused modules. Everything below is
// consumed by production code — nothing is exported solely for a test. The state
// machines' own reset/inspect helpers belong to their modules, where tests reach
// them directly.
export { activeBackend };
export { loadCache, saveCache, removeFromCache } from "./embed-cache-io.mjs";

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

// Re-exported so embed.mjs stays the single type surface for the subsystem; the
// cache format itself is owned by embed-cache-io.mjs.
/** @typedef {import("./embed-cache-io.mjs").EmbedChunkVec} EmbedChunkVec */
/** @typedef {import("./embed-cache-io.mjs").EmbedCacheEntry} EmbedCacheEntry */
/** @typedef {import("./embed-cache-io.mjs").EmbedCache} EmbedCache */

// The two state machines are reset TOGETHER here rather than reaching into each
// other: backend recovery clears the fallback window, and separately re-arms the
// runner's one-shot warning so a later outage is still reported.
function noteTransformerSuccess() {
  noteSuccess();
  resetWorkerWarning();
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
  noteFallback(err);
  dropInProcessEmbedder(); // the rejected embedder must not be reused on retry
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
    noteForcedLexical();
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

// The configured model's input window, for length-aware chunking.
/** @returns {number} */
export function embedWindow() {
  return embedWindowFor(embedModel() || DEFAULT_EMBED_MODEL);
}

// AutoTokenizer standalone (vocab only, no ONNX weights) — inference lives in the
// worker, so loading the full pipeline here would double the model in memory.
// KEYED on the model. embedWindow() re-reads embedModel() on every call, so an
// unkeyed tokenizer meant that after a live model change the window and the vocab
// came from DIFFERENT models — chunk boundaries computed against the wrong
// tokenizer, silently truncating.
const _tokenizerMemo = keyedMemo(
  /** @param {string} model @returns {Promise<Tokenizer>} */
  async (model) => {
    const { AutoTokenizer, env } = await import("@huggingface/transformers");
    applyCacheDir(env, envValue("MEMORY_EMBED_CACHE_DIR") || undefined);
    // A SECOND fetch, on this thread: tokenizer.json is ~20MB and is unaccounted for in every
    // documented model size. Labelled distinctly because it streams concurrently with the
    // worker's weights, onto the same stderr.
    return /** @type {Tokenizer} */ (
      /** @type {unknown} */ (
        await AutoTokenizer.from_pretrained(model, {
          progress_callback: makeDownloadReporter({ label: "tokenizer" }),
        })
      )
    );
  },
);
/**
 * @returns {Promise<Tokenizer | null>}
 */
export async function getTokenizer() {
  if (configuredBackend() === "lexical" || inFallbackWindow()) return null;
  const model = embedModel() || DEFAULT_EMBED_MODEL;
  try {
    // Keyed on cacheDir too: the build reads it, so it is part of this artefact's
    // identity, exactly as it is for the embedders.
    return await _tokenizerMemo.get(
      inferenceKey({ model, cacheDir: envValue("MEMORY_EMBED_CACHE_DIR") || undefined }),
      model,
    );
  } catch {
    return null;
  }
}

// Downloads the model and immediately releases it, so the first recall does not pay ~219MB inside
// an MCP call where the wait is invisible and indistinguishable from a hang. Run by `init`.
//
// Fails SOFT by contract: an offline or air-gapped install must still be able to initialise, so a
// download failure is reported, never thrown. Skipped entirely unless the backend is transformers —
// a lexical install has no model, and the e2e harness runs lexical.
/**
 * @param {{ onProgress?: (info: unknown) => void }} [opts]
 * @returns {Promise<{ ok?: boolean, skipped?: string, model?: string, dtype?: string, error?: string }>}
 */
export async function prefetchEmbedModel({ onProgress } = {}) {
  if (configuredBackend() === "lexical") return { skipped: "lexical" };
  try {
    const { inferenceConfig } = await import("./embed-runner.mjs");
    const { createEmbedder } = await import("./embed-inference.mjs");
    const cfg = inferenceConfig();
    const embedder = await createEmbedder({ ...cfg, onProgress });
    // The weights are on disk now; the native session is not wanted here.
    embedder.dispose?.();
    // tokenizer.json is a SECOND fetch (~20MB) that the first recall would otherwise pay for
    // separately, on a different thread. getTokenizer swallows its own failures.
    await getTokenizer();
    return { ok: true, model: cfg.model, dtype: cfg.dtype };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

import { cosine } from "./embed-lexical.mjs";
import { embedMany, contentHash } from "./embed.mjs";

/** @typedef {import("./embed.mjs").EmbedCache} EmbedCache */
/** @typedef {import("./embed.mjs").EmbedCacheEntry} EmbedCacheEntry */

// Length-aware chunking for the recall read path. The transformer model reads
// only WINDOW tokens of a leaf's embed text; a long leaf loses the rest. We
// split its body into <=maxChunks windows (each carrying the title.tags.subject
// header so a chunk keeps the leaf's identity signal) and, at recall, score the
// leaf by its best chunk minus a per-extra-chunk penalty so a long leaf can't
// out-rank atomic leaves just by having more chances. Short leaves are one
// chunk and score exactly as before.

export const EMBED_WINDOW = 512;

/**
 * Token count as the model sees it (special tokens included) — matches where
 * the model truncates, so the chunk trigger fires exactly when text is lost.
 * @param {{ encode: (t: string) => unknown[] }} tokenizer @param {string} text @returns {number}
 */
export function tokenCount(tokenizer, text) {
  return tokenizer.encode(String(text || "")).length;
}

/**
 * Split a leaf's embed text into chunk texts. Returns `[embedText]` (one chunk,
 * unchanged behavior) when there is no tokenizer (lexical backend), the text
 * fits the window, or the header alone leaves no body budget. Otherwise: the
 * header + successive body-token windows sized so each chunk stays within the
 * window after the header + special tokens, capped at maxChunks.
 * @param {string} embedText the full title.tags.subject header + body
 * @param {string} body the raw body (embedText ends with it)
 * @param {{ encode: (t: string, pair?: unknown, opts?: unknown) => unknown[], decode: (ids: unknown[], opts?: unknown) => string } | null} tokenizer
 * @param {{ window?: number, maxChunks?: number, margin?: number }} [opts]
 * @returns {string[]}
 */
export function chunkTexts(embedText, body, tokenizer, opts = {}) {
  const window = opts.window ?? EMBED_WINDOW;
  const maxChunks = opts.maxChunks ?? 6;
  const margin = opts.margin ?? 8;
  if (!tokenizer) return [embedText];
  if (tokenCount(tokenizer, embedText) <= window) return [embedText];

  const text = String(body || "");
  const header = embedText.slice(0, embedText.length - text.length);
  const headerTokens = tokenizer.encode(header, null, { add_special_tokens: false }).length;
  const budget = window - headerTokens - margin;
  if (budget <= 0) return [embedText];

  const bodyIds = tokenizer.encode(text, null, { add_special_tokens: false });
  /** @type {string[]} */
  const chunks = [];
  for (let i = 0; i < bodyIds.length && chunks.length < maxChunks; i += budget) {
    chunks.push(
      header + tokenizer.decode(bodyIds.slice(i, i + budget), { skip_special_tokens: true }),
    );
  }
  return chunks.length ? chunks : [embedText];
}

/**
 * Recall score for a leaf: its best chunk's cosine, minus a small penalty per
 * extra chunk. A single-chunk (short) leaf scores exactly `cosine(q, vec)` —
 * penalty is 0 — so short-leaf ranking is unchanged.
 * @param {number[]} queryVec
 * @param {number[][]} vecList the leaf's chunk vectors (>=1)
 * @param {number} penalty
 * @param {(a: number[], b: number[]) => number} [cos]
 * @returns {number}
 */
export function scoreLeaf(queryVec, vecList, penalty, cos = cosine) {
  if (!vecList || vecList.length === 0) return 0;
  let best = -Infinity;
  for (const v of vecList) {
    const s = cos(queryVec, v);
    if (s > best) best = s;
  }
  return best - penalty * (vecList.length - 1);
}

/**
 * Group candidates by category, batch-fill each category's cache via
 * cachedLeafVectors, and return `${datasetId}\0${id}` -> recall score.
 * chunkAware picks penalized-max-over-chunks (recall) vs plain whole-leaf cosine
 * (consolidate/compile). `text` is the candidate's raw body.
 * @param {{ id: string, datasetId: string, embedText: string, text: string }[]} candidates
 * @param {(cat: string) => EmbedCache} cacheFor
 * @param {number[]} queryVec
 * @param {{ chunkAware: boolean, tokenizer: import("./embed.mjs").Tokenizer | null, penalty: number, maxChunks: number }} opts
 * @returns {Promise<Map<string, number>>}
 */
export async function scoreTree(candidates, cacheFor, queryVec, opts) {
  const { chunkAware, tokenizer, penalty, maxChunks } = opts;
  /** @type {Map<string, { id: string, embedText: string, body: string }[]>} */
  const byCat = new Map();
  for (const c of candidates) {
    const it = { id: c.id, embedText: c.embedText, body: c.text };
    const arr = byCat.get(c.datasetId);
    if (arr) arr.push(it);
    else byCat.set(c.datasetId, [it]);
  }
  /** @type {Map<string, number>} */
  const scoreByKey = new Map();
  for (const [cat, items] of byCat) {
    const perLeaf = await cachedLeafVectors(cacheFor(cat), items, {
      tokenizer,
      needChunks: chunkAware,
      maxChunks,
    });
    items.forEach((it, i) => {
      const v = perLeaf[i];
      const score = chunkAware
        ? scoreLeaf(queryVec, v.chunks ?? [v.vector], penalty)
        : cosine(queryVec, v.vector);
      scoreByKey.set(`${cat}\0${it.id}`, score);
    });
  }
  return scoreByKey;
}

/**
 * Fill/reuse per-leaf vectors for the recall or warm path, batching every cache
 * miss into ONE embedMany. Every entry keeps its whole-leaf `vector` (the legacy
 * single vector, byte-identical), so cacheDim / consolidate / older engines are
 * unaffected. When `needChunks` and a leaf is truncated, its body is chunked and
 * the chunk vectors are stored under `entry.chunks` and returned for scoring; a
 * `needChunks:false` (consolidate/compile) call never chunks and preserves any
 * existing chunks so a maintenance pass can't strip them.
 * @param {EmbedCache} cache
 * @param {{ id: string, embedText: string, body: string }[]} items
 * @param {{ tokenizer: import("./embed.mjs").Tokenizer | null, needChunks: boolean, window?: number, maxChunks?: number, margin?: number }} opts
 * @returns {Promise<{ vector: number[], chunks?: number[][] }[]>}
 */
export async function cachedLeafVectors(cache, items, opts) {
  const list = Array.isArray(items) ? items : [];
  const { tokenizer = null, needChunks = false } = opts || {};
  const chunkOpts = { window: opts?.window, maxChunks: opts?.maxChunks, margin: opts?.margin };
  /** @type {string[]} */
  const missTexts = [];
  /** @type {{ kind: "vector" | "chunk", i: number, k?: number }[]} */
  const missRefs = [];
  /** @typedef {{ id: string, hash: string, vector?: number[], chunkHashes?: string[], chunkVecs?: number[][], preserve?: import("./embed.mjs").EmbedChunkVec[] }} LeafStage */
  /** @type {LeafStage[]} */
  const staged = new Array(list.length);

  for (let i = 0; i < list.length; i += 1) {
    const { id, embedText, body } = list[i];
    const hash = contentHash(embedText);
    const existing = cache.entries[id];
    const vectorHit =
      existing && existing.hash === hash && Array.isArray(existing.vector) ? existing.vector : null;
    /** @type {LeafStage} */
    const stage = { id, hash };
    staged[i] = stage;
    if (vectorHit) stage.vector = vectorHit;
    else {
      missRefs.push({ kind: "vector", i });
      missTexts.push(embedText);
    }

    const texts =
      needChunks && tokenizer ? chunkTexts(embedText, body, tokenizer, chunkOpts) : null;
    if (texts && texts.length > 1) {
      const chunkHashes = texts.map(contentHash);
      const prev = existing && Array.isArray(existing.chunks) ? existing.chunks : null;
      const hit =
        prev &&
        prev.length === chunkHashes.length &&
        chunkHashes.every((h, k) => prev[k]?.hash === h && Array.isArray(prev[k]?.vector));
      stage.chunkHashes = chunkHashes;
      if (hit) stage.chunkVecs = prev.map((c) => c.vector);
      else {
        stage.chunkVecs = new Array(texts.length);
        texts.forEach((t, k) => {
          missRefs.push({ kind: "chunk", i, k });
          missTexts.push(t);
        });
      }
    } else if (vectorHit && existing.chunks) {
      // Not chunking this call (consolidate/compile, or not truncated) but the
      // body is unchanged (vector hit) — keep the chunks a prior recall built.
      stage.preserve = existing.chunks;
    }
  }

  if (missTexts.length > 0) {
    const vecs = await embedMany(missTexts);
    missRefs.forEach((ref, m) => {
      if (ref.kind === "vector") staged[ref.i].vector = vecs[m];
      else
        /** @type {number[][]} */ (staged[ref.i].chunkVecs)[/** @type {number} */ (ref.k)] =
          vecs[m];
    });
  }

  /** @type {{ vector: number[], chunks?: number[][] }[]} */
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const s = staged[i];
    const vector = /** @type {number[]} */ (s.vector);
    const chunkVecs = s.chunkVecs;
    /** @type {EmbedCacheEntry} */
    const entry = { hash: s.hash, vector };
    if (chunkVecs && s.chunkHashes)
      entry.chunks = s.chunkHashes.map((h, k) => ({ hash: h, vector: chunkVecs[k] }));
    else if (s.preserve) entry.chunks = s.preserve;
    cache.entries[s.id] = entry;
    out[i] = s.chunkVecs ? { vector, chunks: s.chunkVecs } : { vector };
  }
  return out;
}

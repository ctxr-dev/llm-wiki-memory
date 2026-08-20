import { cosine } from "./embed-lexical.mjs";
import { embedWindow } from "./embed.mjs";

// Length-aware chunking for the recall read path. The transformer model reads
// only WINDOW tokens of a leaf's embed text; a long leaf loses the rest. We
// split its body into <=maxChunks windows (each carrying the title.tags.subject
// header so a chunk keeps the leaf's identity signal) and, at recall, score the
// leaf by its best chunk minus a per-extra-chunk penalty so a long leaf can't
// out-rank atomic leaves just by having more chances. Short leaves are one
// chunk and score exactly as before.
//
// Pure text/geometry only — no cache, no settings, no inference. The cache-filling
// and budget side lives in embed-chunk.mjs.

// Legacy fixed window, kept as the fallback when no model is resolvable; the
// live default comes from embedWindow() (model-aware: EmbeddingGemma reads 2048).
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
 * @param {{ encode: (t: string, opts?: unknown) => unknown[], decode: (ids: unknown[], opts?: unknown) => string } | null} tokenizer
 * @param {{ window?: number, maxChunks?: number, margin?: number }} [opts]
 * @returns {string[]}
 */
export function chunkTexts(embedText, body, tokenizer, opts = {}) {
  const window = opts.window ?? embedWindow();
  const maxChunks = opts.maxChunks ?? 6;
  // 12 leaves headroom for the model's special tokens PLUS the retrieval prompt
  // applyPrompt prepends at inference (~6 tokens for the Gemma document prefix).
  const margin = opts.margin ?? 12;
  if (!tokenizer) return [embedText];
  if (tokenCount(tokenizer, embedText) <= window) return [embedText];

  const text = String(body || "");
  const header = embedText.slice(0, embedText.length - text.length);
  const headerTokens = tokenizer.encode(header, { add_special_tokens: false }).length;
  const budget = window - headerTokens - margin;
  if (budget <= 0) return [embedText];

  const bodyIds = tokenizer.encode(text, { add_special_tokens: false });
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

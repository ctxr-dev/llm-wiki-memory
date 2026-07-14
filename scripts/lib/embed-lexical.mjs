import crypto from "node:crypto";

// Vector primitives for the recall engine: the deterministic LEXICAL fallback
// embedding (used only when the transformer backend can't load) and cosine
// similarity. Kept dependency-light and separate from the model/pipeline code
// in embed.mjs so that file stays focused on the transformer path + cache fill.

// Deterministic lexical embedding: hashed bag-of-tokens into a fixed-width
// vector. Not semantic, but stable and dependency-free.
const LEXICAL_DIM = 256;

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
 * @param {string} text
 * @returns {number[]}
 */
export function lexicalVector(text) {
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
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosine(a, b) {
  // A length mismatch means the two vectors came from different backends/dims
  // (e.g. a stale lexical-256 cache vector scored against a transformer query).
  // Treat it as no-match rather than computing a bogus partial dot product.
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

// Reshape a batched feature-extraction tensor ([count, dim], row-major) into one
// vector per input, in order. Isolated + exported so the transformer batch path's
// row assembly is unit-testable with a synthetic tensor — the lexical test harness
// short-circuits before the real pipeline, so this slice logic would otherwise be
// untested and a row-transpose/offset bug would corrupt every vector silently.
/**
 * @param {{ dims: number[], data: ArrayLike<number> | ArrayLike<bigint> }} out
 * @param {number} count
 * @returns {number[][]}
 */
export function tensorRows(out, count) {
  const dim = out.dims[out.dims.length - 1];
  const flat = Array.from(out.data, Number);
  /** @type {number[][]} */
  const rows = [];
  for (let r = 0; r < count; r += 1) rows.push(flat.slice(r * dim, (r + 1) * dim));
  return rows;
}

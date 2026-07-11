// Map-reduce chunker for the flush worker.
//
// Splits a redacted transcript into chunks whose individual LLM-call latency
// is bounded by chunkSize, so a single oversize session can no longer time
// out the whole distillation. Chunk boundaries fall on TURN headers so each
// chunk stays semantically coherent.
//
// The transcript format produced by flush.mjs::transcriptToMarkdown is a
// sequence of `### User`/`### Assistant`/`### summary`/`### system` blocks
// separated by blank lines. The chunker walks forward from each target cut
// point until it finds the next header line (`^### `), then cuts BEFORE
// that header. Fallbacks: paragraph break → hard cut.

// Headers at line-start ONLY. The raw-fallback path indents every body line
// with 4 leading spaces, so an embedded `### User` becomes `    ### User`
// which must NOT match this anchor.
const HEADER_LINE_RE = /^### (User|Assistant|summary|system)\b/m;
const MIN_CHUNK_FLOOR = 4_000;

/**
 * An ordered chunk of a split body.
 * @typedef {{ index: number, text: string, start: number, end: number }} Chunk
 */

// Compute a chunk size given the body length and a target number of chunks.
// Rounding up so a 100K body with target_K=5 yields 5 chunks of ~20K each
// rather than 6 chunks of <20K. The floor ensures we don't over-fragment a
// short body (e.g. an 8K body with target_K=5 would otherwise produce 1.6K
// chunks; the floor forces a single chunk).
/**
 * @param {number} bodyLength
 * @param {number} targetK
 * @returns {number}
 */
export function computeChunkSize(bodyLength, targetK) {
  const safeLen = Number.isFinite(bodyLength) && bodyLength > 0 ? Math.floor(bodyLength) : 0;
  const safeK = Number.isFinite(targetK) && targetK >= 1 ? Math.floor(targetK) : 1;
  if (safeLen === 0) return MIN_CHUNK_FLOOR;
  const computed = Math.ceil(safeLen / safeK);
  return Math.max(MIN_CHUNK_FLOOR, computed);
}

// Find the next turn-header position at or after `from`. Returns -1 when no
// header appears in the rest of the body. The regex is anchored on a line
// start via the multiline flag, so a literal `### User` inside a fenced code
// block does NOT match unless it begins its own line — which is consistent
// with how transcriptToMarkdown ALWAYS prefixes headers with a newline.
/**
 * @param {string} body
 * @param {number} from
 * @returns {number}
 */
function findNextHeaderAt(body, from) {
  if (from >= body.length) return -1;
  const slice = body.slice(from);
  const m = slice.match(HEADER_LINE_RE);
  if (!m) return -1;
  return from + /** @type {number} */ (m.index);
}

// Enumerate every line-start header position in `body` strictly after
// `afterPos`. Used by the header-first cut search.
/**
 * @param {string} body
 * @param {number} afterPos
 * @returns {number[]}
 */
function listHeaderPositionsAfter(body, afterPos) {
  /** @type {number[]} */
  const out = [];
  for (const m of body.matchAll(/(^|\n)(### (?:User|Assistant|summary|system)\b)/g)) {
    const mIndex = /** @type {number} */ (m.index);
    const headerStart = m[1] === "" ? mIndex : mIndex + 1;
    if (headerStart > afterPos) out.push(headerStart);
  }
  return out;
}

// Enumerate every paragraph break (\n\n) position in `body` strictly after
// `afterPos`. Used as a fallback for non-transcript bodies (e.g. a daily
// raw fallback that contains a compacted summary in numbered-bullet shape,
// with no `### User` / `### Assistant` headers at all).
/**
 * @param {string} body
 * @param {number} afterPos
 * @returns {number[]}
 */
function listParagraphPositionsAfter(body, afterPos) {
  /** @type {number[]} */
  const out = [];
  let from = afterPos;
  while (from < body.length) {
    const idx = body.indexOf("\n\n", from);
    if (idx === -1) break;
    // Cut position is the start of the line AFTER the blank line so the
    // chunk that ends at this cut keeps its trailing content intact.
    const pos = idx + 2;
    if (pos > afterPos) out.push(pos);
    from = pos;
  }
  return out;
}

// Pick the closest cut to targetEnd from a sorted-ascending position list.
// Prefer the LATEST candidate at or before targetEnd (keeps the chunk ≤
// chunkSize); fall back to the EARLIEST candidate after targetEnd when no
// position is reachable in the prior window.
/**
 * @param {number[]} positions
 * @param {number} targetEnd
 * @returns {number}
 */
function pickClosestCut(positions, targetEnd) {
  if (positions.length === 0) return -1;
  let beforeOrAt = -1;
  let firstAfter = -1;
  for (const p of positions) {
    if (p <= targetEnd) beforeOrAt = p;
    else {
      firstAfter = p;
      break;
    }
  }
  if (beforeOrAt !== -1) return beforeOrAt;
  return firstAfter;
}

// Never cut between a UTF-16 surrogate pair: every chunk is rendered to
// UTF-8 independently (LLM prompt, stash record), and a lone surrogate
// encodes as U+FFFD — silent content corruption. Shifting the cut forward by
// one keeps the pair in the left chunk. Header/paragraph cuts always land
// after a newline, so only the HARD cut paths need this.
/**
 * @param {string} body
 * @param {number} pos
 * @returns {number}
 */
function surrogateSafe(body, pos) {
  if (pos > 0 && pos < body.length) {
    const hi = body.charCodeAt(pos - 1);
    const lo = body.charCodeAt(pos);
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) return pos + 1;
  }
  return pos;
}

// Find the best chunk boundary, in priority order:
//   1. Turn header (`### User` / `### Assistant`)  — semantic, ideal.
//   2. Paragraph break (`\n\n`)                    — non-transcript bodies.
//   3. Hard cut at targetEnd                       — last-resort, when the
//      body is one giant prose block with neither headers nor blank lines.
// Returns -1 only when even a hard cut at targetEnd would not advance the
// cursor (i.e. cursor >= body.length); the caller treats that as EOF and
// emits the final chunk.
/**
 * @param {string} body
 * @param {number} cursor
 * @param {number} targetEnd
 * @returns {number}
 */
function findBestCut(body, cursor, targetEnd) {
  const headerCut = pickClosestCut(listHeaderPositionsAfter(body, cursor), targetEnd);
  if (headerCut !== -1) return headerCut;
  const paraCut = pickClosestCut(listParagraphPositionsAfter(body, cursor), targetEnd);
  if (paraCut !== -1) return paraCut;
  // Hard fallback: cut at the target so a header-less, paragraph-less body
  // (one giant prose blob, post-compact summary as a single line, etc.)
  // still gets chunked rather than submitted as one oversized blob that
  // the LLM may reject with prose-not-JSON.
  if (targetEnd > cursor && targetEnd < body.length) return surrogateSafe(body, targetEnd);
  return -1;
}

// Find the nearest paragraph break (`\n\n`) AT OR BEFORE `from`. Returns -1
// when none exists in the leading slice. Used when no turn header is reachable
// before the next chunk's target end, to at least avoid splitting mid-line.
/**
 * @param {string} body
 * @param {number} from
 * @returns {number}
 */
function findPrevParagraphBreak(body, from) {
  const slice = body.slice(0, from);
  const idx = slice.lastIndexOf("\n\n");
  return idx === -1 ? -1 : idx + 2;
}

// Split `body` into ordered chunks. Each chunk: `{ index, text, start, end }`.
// Length contract: every chunk's `text` is non-empty; the union of all chunks
// equals `body` (no characters dropped, no overlap). Single-chunk returns
// `[{ index: 0, text: body, start: 0, end: body.length }]` (callers can
// fast-path on chunks.length === 1).
/**
 * @param {unknown} body
 * @param {{ chunkSize?: number }} [opts]
 * @returns {Chunk[]}
 */
export function chunkTranscript(body, { chunkSize } = {}) {
  const text = typeof body === "string" ? body : "";
  if (!text) return [];
  const size =
    Number.isFinite(chunkSize) && /** @type {number} */ (chunkSize) > 0
      ? Math.floor(/** @type {number} */ (chunkSize))
      : MIN_CHUNK_FLOOR;
  if (text.length <= size) {
    return [{ index: 0, text, start: 0, end: text.length }];
  }

  /** @type {Chunk[]} */
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    const targetEnd = cursor + size;
    if (targetEnd >= text.length) {
      chunks.push({
        index: chunks.length,
        text: text.slice(cursor),
        start: cursor,
        end: text.length,
      });
      cursor = text.length;
      break;
    }
    // Prefer the LATEST header at-or-before targetEnd (chunk ≤ chunkSize);
    // fall back to the FIRST header after targetEnd (chunk slightly
    // larger). Cutting at a header keeps each chunk's last turn intact.
    let cut = findBestCut(text, cursor, targetEnd);
    if (cut === -1) {
      // No more headers — emit the remainder as a final chunk and stop.
      chunks.push({
        index: chunks.length,
        text: text.slice(cursor),
        start: cursor,
        end: text.length,
      });
      cursor = text.length;
      break;
    }
    if (cut <= cursor) {
      // Defensive: only reachable when `size` was coerced too small to make
      // forward progress. Fall back to paragraph boundary then hard cut.
      const para = findPrevParagraphBreak(text, targetEnd);
      cut = para > cursor ? para : surrogateSafe(text, Math.max(cursor + 1, targetEnd));
    }
    chunks.push({ index: chunks.length, text: text.slice(cursor, cut), start: cursor, end: cut });
    cursor = cut;
  }
  return chunks;
}

// Convenience: build chunks from a source body using the configured target
// K. Pure derivative of computeChunkSize + chunkTranscript; exposed so
// callers don't have to thread both calls.
/**
 * @param {unknown} body
 * @param {{ targetK?: number }} [opts]
 * @returns {Chunk[]}
 */
export function chunkSource(body, { targetK } = {}) {
  const text = typeof body === "string" ? body : "";
  if (!text) return [];
  const size = computeChunkSize(text.length, /** @type {number} */ (targetK));
  return chunkTranscript(text, { chunkSize: size });
}

export const __testing = Object.freeze({
  MIN_CHUNK_FLOOR,
  findNextHeaderAt,
  findPrevParagraphBreak,
  surrogateSafe,
});

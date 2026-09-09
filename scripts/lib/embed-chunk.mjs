import { cosine } from "./embed-lexical.mjs";
import { embedMany, contentHash, getTokenizer } from "./embed.mjs";
import { chunkTexts, scoreLeaf } from "./embed-chunk-text.mjs";
import { embedChunk } from "./settings.mjs";
import { COLD_SKIP_SCORE, defaultColdBudget } from "./cold-budget.mjs";

/** @typedef {import("./embed.mjs").EmbedCache} EmbedCache */
/** @typedef {import("./embed.mjs").EmbedCacheEntry} EmbedCacheEntry */
/** @typedef {{ take: (n: number) => boolean, spent: number, skipped: number, skipLeaf?: (key?: string) => void, openDraw?: () => void }} ColdBudget */

// The cache-filling half of length-aware recall: fill/reuse per-leaf vectors and
// chunk sets, bounded by a shared cold-embed ledger. The pure text/geometry half
// (chunkTexts / scoreLeaf) lives in embed-chunk-text.mjs; the ledger itself, and how its
// allowance is divided between the reads that share it, lives in cold-budget.mjs.

/**
 * Convenience wrapper: resolve the chunk config + tokenizer (from settings) and
 * delegate to `scoreTree`. `chunkAware` is opt-in per read entry point; the
 * tokenizer is only loaded when chunking is both requested AND enabled.
 * @param {{ id: string, datasetId: string, embedText: string, text: string, full?: boolean }[]} candidates
 * @param {(cat: string) => EmbedCache} cacheFor
 * @param {number[]} queryVec
 * @param {boolean} chunkAware
 * @param {ColdBudget | null} [budget]
 * @returns {Promise<Map<string, number>>}
 */
export async function scoreCandidates(candidates, cacheFor, queryVec, chunkAware, budget) {
  const { enabled, maxChunks, penalty, fullMaxChunks, fullPenalty } = embedChunk();
  const tokenizer = chunkAware && enabled ? await getTokenizer() : null;
  return scoreTree(candidates, cacheFor, queryVec, {
    chunkAware,
    tokenizer,
    penalty,
    maxChunks,
    fullMaxChunks,
    fullPenalty,
    // A caller that spans several reads (the federated fanout, a recall ladder)
    // passes ONE ledger so the whole request shares the bound. A lone read gets
    // its own. Maintenance (consolidate) is exempt: it needs every vector or its
    // dedup clustering silently under-merges, and it runs detached where a long
    // embed costs nobody's latency.
    //
    // A caller that supplies NO ledger cannot report a shortfall: the one made here is
    // discarded with the call, so `coldShortfall` has nothing to read and the search looks
    // complete however many leaves were dropped. Any read path that wants the advisory must
    // OWN its ledger — recall.mjs, recall-search.mjs and the webapp's searchWiki all do. The
    // webapp did not, which is exactly why its results were silently truncated.
    budget: budget ?? defaultColdBudget(),
  });
}

/**
 * Group candidates by category, batch-fill each category's cache via
 * cachedLeafVectors, and return `${datasetId}\0${id}` -> recall score.
 * chunkAware picks penalized-max-over-chunks (recall) vs plain whole-leaf cosine
 * (consolidate/compile). A `full` candidate uncaps to `fullMaxChunks` and scores
 * with `fullPenalty` (0) so its whole body is searchable and length never hurts.
 * `text` is the candidate's raw body; `full` is resolved by the caller.
 * @param {{ id: string, datasetId: string, embedText: string, text: string, full?: boolean }[]} candidates
 * @param {(cat: string) => EmbedCache} cacheFor
 * @param {number[]} queryVec
 * @param {{ chunkAware: boolean, tokenizer: import("./embed.mjs").Tokenizer | null, penalty: number, maxChunks: number, fullPenalty?: number, fullMaxChunks?: number, budget?: ColdBudget | null }} opts
 * @returns {Promise<Map<string, number>>}
 */
export async function scoreTree(candidates, cacheFor, queryVec, opts) {
  const {
    chunkAware,
    tokenizer,
    penalty,
    maxChunks,
    fullPenalty = 0,
    fullMaxChunks = maxChunks,
  } = opts;
  /** @type {Map<string, { id: string, embedText: string, body: string, full?: boolean }[]>} */
  const byCat = new Map();
  for (const c of candidates) {
    const it = { id: c.id, embedText: c.embedText, body: c.text, full: c.full === true };
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
      fullMaxChunks,
      budget: opts.budget,
      // The ledger is shared across categories and rungs, so a dropped leaf needs a namespaced
      // identity or two categories' same-named leaves would dedupe into one.
      keyPrefix: cat,
    });
    items.forEach((it, i) => {
      const v = perLeaf[i];
      // A budget-skipped leaf is UNKNOWN, not irrelevant: scoring it 0 would let
      // it through a `scoreThreshold: 0` gate and occupy a result slot. The
      // sentinel lets the caller drop it instead.
      if (v.skipped) {
        scoreByKey.set(`${cat}\0${it.id}`, COLD_SKIP_SCORE);
        return;
      }
      const pen = it.full ? fullPenalty : penalty;
      const score = chunkAware
        ? scoreLeaf(queryVec, v.chunks ?? [v.vector], pen)
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
 * A `full` item uncaps its chunk count to `fullMaxChunks` (the whole document is
 * embedded); a non-full item uses `maxChunks` (today's 6). So an atomic leaf is
 * byte-identical and a full leaf becomes fully searchable.
 * @param {EmbedCache} cache
 * @param {{ id: string, embedText: string, body: string, full?: boolean }[]} items
 * `budget` (a makeColdBudget ledger) bounds how many TEXTS this call may embed;
 * omit it for the unlimited path the background warm relies on. A leaf the budget
 * refuses comes back `{ skipped: true }` and is left out of the cache.
 * @param {{ tokenizer: import("./embed.mjs").Tokenizer | null, needChunks: boolean, window?: number, maxChunks?: number, margin?: number, fullMaxChunks?: number, batchSize?: number, budget?: ColdBudget | null, keyPrefix?: string }} opts
 * @returns {Promise<{ vector: number[], chunks?: number[][], skipped?: boolean }[]>}
 */
export async function cachedLeafVectors(cache, items, opts) {
  const list = Array.isArray(items) ? items : [];
  const { tokenizer = null, needChunks = false, keyPrefix = "" } = opts || {};
  /** @type {string[]} */
  const missTexts = [];
  /** @type {{ kind: "vector" | "chunk", i: number, k?: number }[]} */
  const missRefs = [];
  /** @typedef {{ id: string, hash: string, vector?: number[], chunkHashes?: string[], chunkVecs?: number[][], preserve?: import("./embed.mjs").EmbedChunkVec[], skipped?: boolean }} LeafStage */
  /** @type {LeafStage[]} */
  const staged = new Array(list.length);

  const budget = opts?.budget ?? null;
  /** @type {({ existing: EmbedCacheEntry | undefined, vectorHit: number[] | null } | null)[]} */
  const pending = new Array(list.length);

  // Pass 1 — every leaf's WHOLE-LEAF vector, before any chunk refinement. Ordering
  // matters under a bounded budget: interleaving the two let one long leaf spend
  // `1 + n` up front and left later leaves with nothing, so they came back
  // `skipped` and were DROPPED from the result set. Vectors first means the same
  // budget ranks strictly more leaves; only chunk refinement defers.
  for (let i = 0; i < list.length; i += 1) {
    const { id, embedText } = list[i];
    const hash = contentHash(embedText);
    const existing = cache.entries[id];
    const vectorHit =
      existing && existing.hash === hash && Array.isArray(existing.vector) ? existing.vector : null;
    /** @type {LeafStage} */
    const stage = { id, hash };
    staged[i] = stage;
    pending[i] = null;
    if (vectorHit) stage.vector = vectorHit;
    else if (!budget || budget.take(1)) {
      missRefs.push({ kind: "vector", i });
      missTexts.push(embedText);
    } else {
      // Budget spent: leave this leaf unembedded AND uncached, so it ranks last
      // for this one read (cosine returns 0 on a length mismatch) and the next
      // background warm still sees it as a miss. Skipping the chunk work below
      // also skips its tokenization, keeping the read off the CPU entirely.
      stage.skipped = true;
      if (budget && typeof budget.skipLeaf === "function") {
        // Namespaced by category exactly as scoreByKey is: leaf ids are category-relative,
        // so a bare id would merge two different leaves that share a path.
        budget.skipLeaf(keyPrefix ? `${keyPrefix}\0${id}` : id);
      }
      continue;
    }
    pending[i] = { existing, vectorHit };
  }

  // Pass 2 — chunk sets, funded by whatever pass 1 left.
  for (let i = 0; i < list.length; i += 1) {
    const p = pending[i];
    if (!p) continue;
    const { id, embedText, body, full } = list[i];
    const { existing, vectorHit } = p;
    const stage = staged[i];
    // A full leaf embeds its whole body (fullMaxChunks); others cap at maxChunks.
    const chunkOpts = {
      window: opts?.window,
      maxChunks: full ? (opts?.fullMaxChunks ?? opts?.maxChunks) : opts?.maxChunks,
      margin: opts?.margin,
    };
    // `chunkTexts` throws if its embedText/body coupling ever breaks, rather than
    // slicing a wrong header and persisting vectors for text no leaf contains.
    // That refusal is per-LEAF here on purpose: this runs on the recall path, where
    // `searchOneTree` is explicit that a search must not throw, so letting it
    // propagate would trade one leaf's degraded chunking for the whole query's
    // failure across every category. `null` is the already-supported "no chunk set"
    // state — the leaf falls back to its whole-leaf vector, exactly as it behaved
    // before chunking existed — and the reason is named loudly for the operator.
    /** @type {string[] | null} */
    let texts = null;
    if (needChunks && tokenizer) {
      try {
        texts = chunkTexts(embedText, body, tokenizer, chunkOpts);
      } catch (err) {
        texts = null;
        console.error(
          `[embed] chunking refused for ${id}: ${err instanceof Error ? err.message : String(err)} — falling back to the whole-leaf vector; this leaf's long-body recall is degraded until the cause is fixed`,
        );
      }
    }
    if (texts && texts.length > 1) {
      const chunkHashes = texts.map(contentHash);
      const prev = existing && Array.isArray(existing.chunks) ? existing.chunks : null;
      const hit =
        prev &&
        prev.length === chunkHashes.length &&
        chunkHashes.every((h, k) => prev[k]?.hash === h && Array.isArray(prev[k]?.vector));
      if (hit) {
        stage.chunkHashes = chunkHashes;
        stage.chunkVecs = prev.map((c) => c.vector);
      } else if (!budget || budget.take(texts.length)) {
        stage.chunkHashes = chunkHashes;
        stage.chunkVecs = new Array(texts.length);
        texts.forEach((t, k) => {
          missRefs.push({ kind: "chunk", i, k });
          missTexts.push(t);
        });
      }
      // Budget spent on a leaf whose WHOLE-LEAF vector is warm: keep that vector
      // and skip only the chunk refinement, so the leaf still scores normally.
    } else if (vectorHit && existing?.chunks) {
      // Not chunking this call (consolidate/compile, or not truncated) but the
      // body is unchanged (vector hit) — keep the chunks a prior recall built.
      stage.preserve = existing.chunks;
    }
  }

  if (missTexts.length > 0) {
    cache._dirty = true;
    const vecs = await embedMany(missTexts, { batchSize: opts?.batchSize, kind: "document" });
    missRefs.forEach((ref, m) => {
      if (ref.kind === "vector") staged[ref.i].vector = vecs[m];
      else
        /** @type {number[][]} */ (staged[ref.i].chunkVecs)[/** @type {number} */ (ref.k)] =
          vecs[m];
    });
  }

  /** @type {{ vector: number[], chunks?: number[][], skipped?: boolean }[]} */
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const s = staged[i];
    if (s.skipped) {
      // Writing NO cache entry keeps the leaf a genuine miss for the next warm —
      // caching a zero vector under a matching hash would poison it permanently.
      out[i] = { vector: [], skipped: true };
      continue;
    }
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

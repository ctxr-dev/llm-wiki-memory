// Cache DIMENSION COHERENCE: every vector in one cache file must have the same length.
//
// Its own module rather than part of embed-cache-guards.mjs because the question differs:
// guards decide whether a WRITE may proceed, this decides whether a cache is internally
// consistent — and that is checked on both the read and the write path.
//
// A cache file belongs to exactly one model + backend, so every vector in it — top-level
// AND chunk — must agree. A mixed file is silently destructive: `cosine` returns 0 for a
// length mismatch (deliberately), and `scoreLeaf` on a mismatched chunk set returns a
// NEGATIVE score, so the affected leaves rank below genuinely irrelevant ones and disappear
// from results with nothing reporting it.
//
// It was reachable and reproduced: a run loads a cache while the backend is unresolved (the
// object is stamped optimistically), the model fails mid-run and lexical vectors enter that
// same map, then the retry window expires and the backend recovers — the stamp matches
// again, the drift check sees nothing, and the mix is persisted. Nothing detected it
// afterwards, because `cacheDim` samples only the FIRST top-level vector and ignores
// `chunks`, while `sliceIsWarm` and the `vectorHit` gate compare the content hash and
// `Array.isArray` but never a length.

/** @typedef {import("./embed-cache-io.mjs").EmbedCache} EmbedCache */
/**
 * Vector lengths in a cache, split by role.
 *
 * The WHOLE-LEAF vectors are the authority: `cacheDim` stamps the file from one of them and
 * the non-chunk-aware scoring path uses them directly. A `chunks` array is a refinement that
 * must conform, so chunk lengths are reported but never get a vote — letting them vote meant
 * a single 5-dim chunk beside a 3-dim vector could win a 1-1 tie and delete the good entry.
 * @param {EmbedCache} cache
 * @returns {{ top: Map<number, number>, chunk: Set<number> }}
 */
function dimHistogram(cache) {
  /** @type {Map<number, number>} */
  const top = new Map();
  /** @type {Set<number>} */
  const chunk = new Set();
  for (const entry of Object.values(cache.entries || {})) {
    if (Array.isArray(entry?.vector))
      top.set(entry.vector.length, (top.get(entry.vector.length) || 0) + 1);
    // A non-array chunk vector counts as a disagreement (-1) — otherwise the detector was
    // laxer than the pruner and that malformed shape was never repaired.
    for (const c of entry?.chunks || []) chunk.add(Array.isArray(c?.vector) ? c.vector.length : -1);
  }
  return { top, chunk };
}

/**
 * The dimension a cache is really built at, and whether it disagrees with itself.
 *
 * `preferredDim` is an authority the caller supplies, and it WINS whenever it is one of the
 * dimensions actually present. Counting alone is a trap: when the degraded side OUTNUMBERS the
 * good side — a partly-warm category that fell back mid-run and embedded more leaves during the
 * window than it already had cached — the vote deletes exactly the vectors that match the live
 * model, and the re-stamp then makes the next read discard the whole file. Measured on the
 * scenario this module exists for: 20 good + 60 degraded became 0 usable, i.e. worse than
 * having no check at all.
 *
 * The two doors have different trustworthy authorities, which is why this is a parameter:
 *   - loadCache: the FILE is already mixed, so its own stamp was sampled from whichever entry
 *     enumerated first and cannot be trusted; it passes the live query dim when it has one.
 *   - saveCache: the mix is in MEMORY and the object's stamp came from the last clean file, so
 *     that stamp IS the good dimension; it passes that.
 *
 * Non-positive candidates never win: a `vector: []` entry would otherwise be chosen and then
 * repair nothing (`pruneDimOutliers` requires `dim > 0`), leaving a self-sustaining mix while
 * burning the one-shot diagnostic. Ties fall back to the stamped `dim`, else the larger, so the
 * result is deterministic for any input ordering.
 * @param {EmbedCache} cache @param {number} [preferredDim]
 * @returns {{ dim: number, mixed: boolean, counts: Map<number, number> }}
 */
function dominantDim(cache, preferredDim = 0) {
  const { top, chunk } = dimHistogram(cache);
  if (top.size === 0) return { dim: 0, mixed: false, counts: top };
  let dim = 0;
  let best = -1;
  for (const [candidate, count] of [...top].sort((a, b) => a[0] - b[0])) {
    if (candidate <= 0) continue;
    const wins =
      count > best ||
      (count === best && (candidate === cache.dim || (cache.dim !== dim && candidate > dim)));
    if (wins) {
      dim = candidate;
      best = count;
    }
  }
  if (preferredDim > 0 && top.has(preferredDim)) dim = preferredDim;
  // Mixed if the whole-leaf vectors disagree with each other, OR any chunk vector disagrees
  // with the dimension they settled on.
  const mixed = top.size > 1 || [...chunk].some((c) => c !== dim);
  return { dim, mixed, counts: top };
}

/**
 * Drops everything that disagrees with `dim`, in place.
 *
 * An entry whose whole-leaf vector disagrees is removed outright, so the leaf reads as a
 * cache MISS and the next warm recomputes it — that is what makes the repair self-healing.
 * A mismatched CHUNK set only loses its `chunks` array: the whole-leaf vector still ranks,
 * and the leaf re-chunks on the next chunk-aware read. Removing the entry instead would
 * throw away a good vector to fix a refinement.
 * @param {EmbedCache} cache @param {number} dim
 * @returns {{ entriesDropped: number, chunkSetsDropped: number }}
 */
function pruneDimOutliers(cache, dim) {
  let entriesDropped = 0;
  let chunkSetsDropped = 0;
  if (!(dim > 0) || !cache.entries) return { entriesDropped, chunkSetsDropped };
  for (const [id, entry] of Object.entries(cache.entries)) {
    if (!Array.isArray(entry?.vector) || entry.vector.length !== dim) {
      delete cache.entries[id];
      entriesDropped += 1;
      continue;
    }
    if (!Array.isArray(entry.chunks)) continue;
    if (entry.chunks.some((c) => !Array.isArray(c?.vector) || c.vector.length !== dim)) {
      delete entry.chunks;
      chunkSetsDropped += 1;
    }
  }
  return { entriesDropped, chunkSetsDropped };
}

// Keyed by path AND door: the load door and the save door repair DIFFERENT sets (load fixes
// what is on disk, save fixes what a run built in memory), so one shared key let the first
// report swallow the second — and the save door's drop is usually the larger one.
// Lazily imported so a healthy process never loads the monitoring stack, and so a broken
// capture store can never turn a successful repair into a failure.
/**
 * @param {string} message @param {string} cachePath
 * @returns {void}
 */
function recordDimMixCapture(message, cachePath) {
  import("./monitoring.mjs")
    .then(({ writeMonitoringCapture }) =>
      writeMonitoringCapture({
        title: "embedding cache mixed vector dimensions",
        severity: "confirmed-bug",
        surface: "embed-cache",
        observed: message,
        evidence: `cache: ${cachePath}`,
      }),
    )
    .catch(() => {});
}

/** @type {Set<string>} */
const warnedDimMix = new Set();
/**
 * @param {string} cachePath @param {Map<number, number>} counts @param {number} kept
 * @param {{ entriesDropped: number, chunkSetsDropped: number }} dropped
 * @param {"load" | "save"} door
 * @returns {void}
 */
function warnDimMix(cachePath, counts, kept, dropped, door) {
  const latch = `${door}:${cachePath}`;
  if (warnedDimMix.has(latch)) return;
  const shape = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${n}×${d}-dim`)
    .join(", ");
  // Write BEFORE arming, matching warnDowngradeOnce: a throwing stderr (a destroyed stream
  // in a piped one-shot CLI) then leaves the latch unarmed and the diagnostic is retried.
  const message = `${cachePath} mixed vector dimensions (${shape}) on ${door}; kept ${kept}-dim, dropped ${dropped.entriesDropped} entr${dropped.entriesDropped === 1 ? "y" : "ies"} + ${dropped.chunkSetsDropped} chunk set(s) that cannot be compared against it. Those leaves re-embed on the next \`cli.mjs warm\`.`;
  process.stderr.write(`embed: ${message}\n`);
  // stderr is not enough: Claude Code discards the MCP server's stderr and launchd drops the
  // cron's, and those are precisely the two runtimes that trigger a repair. A capture is the
  // channel the user actually sees — session-start reports the open count.
  try {
    recordDimMixCapture(message, cachePath);
  } catch {
    // Observability is best-effort; the repair itself already happened.
  }
  warnedDimMix.add(latch);
}

/**
 * Enforces the one-dimension invariant on a cache, in place, reporting once per path.
 * @param {string} cachePath @param {EmbedCache} cache
 * @param {number} [preferredDim] the caller's authority — see dominantDim
 * @param {"load" | "save"} [door] which door repaired it; latches per door so both are reported
 * @returns {void}
 */
export function enforceOneDim(cachePath, cache, preferredDim = 0, door = "load") {
  const { dim, mixed, counts } = dominantDim(cache, preferredDim);
  if (!mixed) return;
  const dropped = pruneDimOutliers(cache, dim);
  // Repaired nothing means nothing to report — and reporting anyway would ARM the one-shot
  // latch, so the next GENUINE mix on this path would be repaired silently.
  if (!dropped.entriesDropped && !dropped.chunkSetsDropped) return;
  // Mark it persistable. Every existing persist point already gates on `_dirty`, so without
  // this the repair lived only in memory: warm reported `embedded: 0`, the GC wrote nothing,
  // and doctor reported the file red on EVERY run forever while telling the user it would heal
  // on the next warm. A healthy cache is never marked, so the read path gains no write.
  cache._dirty = true;
  warnDimMix(cachePath, counts, dim, dropped, door);
}

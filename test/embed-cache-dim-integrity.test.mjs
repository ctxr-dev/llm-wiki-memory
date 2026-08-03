// ONE VECTOR DIMENSION PER CACHE FILE.
//
// A cache file belongs to exactly one model + backend, so every vector in it — top-level
// AND chunk — must have the same length. Mixing them is silently destructive: `cosine`
// returns 0 for a length mismatch (by design), and a chunked leaf scores NEGATIVE, so the
// affected leaves rank below genuinely irrelevant ones and simply vanish from results.
//
// Nothing detected it before this. `cacheDim` samples only the FIRST top-level vector and
// ignores `chunks`, so the file-level stamp validated; `sliceIsWarm` and the `vectorHit`
// gate in `cachedLeafVectors` check the content hash and `Array.isArray` but never a
// length, so `warm` considered a poisoned entry finished and never re-embedded it, and
// `doctor` compared only the backend stamp.
//
// The reproduced path: a long run loads a cache while the backend is still unresolved (so
// the object is stamped optimistically), the model fails mid-run and lexical vectors are
// inserted into that same map, then the 30s fallback window expires and the backend
// recovers — at which point the stamp matches again, the drift check sees nothing, and the
// mixed map is persisted.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCache, saveCache } from "../scripts/lib/embed-cache-io.mjs";
import { __resetForTest, noteFallback, noteSuccess } from "../scripts/lib/embed-backend-state.mjs";
import { withSettingsOverride } from "../scripts/lib/settings.mjs";

const MODEL = "test/dim-model";
const SETTINGS = { embed: { backend: "transformers", model: MODEL, dtype: "q4" } };

/**
 * A cache path inside a wiki-shaped install whose settings declare transformers — the
 * persistence guard resolves "did this wiki choose lexical" from the owning install's
 * settings file, so the shape matters.
 * @returns {string}
 */
function wikiCachePath() {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-dimint-")));
  fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "settings", "settings.yaml"),
    `embed:\n  backend: transformers\n  model: ${MODEL}\n  dtype: q4\n`,
  );
  const dir = path.join(dataDir, "wiki", "knowledge", ".embeddings");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "embeddings.json");
}

/** @param {string} p @param {object} body */
const seed = (p, body) => fs.writeFileSync(p, JSON.stringify(body));
/** @param {string} p */
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

/** Counts of every vector length in a cache, top-level AND chunk. @param {object} cache */
function dimCounts(cache) {
  /** @type {Record<number, number>} */
  const counts = {};
  const bump = (v) => {
    if (Array.isArray(v)) counts[v.length] = (counts[v.length] || 0) + 1;
  };
  for (const e of Object.values(cache.entries || {})) {
    bump(e?.vector);
    for (const c of e?.chunks || []) bump(c?.vector);
  }
  return counts;
}

beforeEach(() => {
  __resetForTest();
});

test("a fallback that RECOVERS mid-run never persists a mixed-dimension cache", async () => {
  const p = wikiCachePath();
  seed(p, {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    dim: 3,
    entries: { a: { hash: "ha", vector: [1, 0, 0] }, b: { hash: "hb", vector: [0, 1, 0] } },
  });

  await withSettingsOverride(SETTINGS, async () => {
    const cache = loadCache(p);
    assert.equal(Object.keys(cache.entries).length, 2, "the healthy cache loads");

    // The model fails mid-run: lexical vectors land in the map the run is holding open.
    noteFallback(new Error("model load failed mid-run"));
    cache.entries.poison = { hash: "hp", vector: [9, 9] };

    saveCache(p, cache);
    assert.deepEqual(dimCounts(read(p)), { 3: 2 }, "a degraded save must not reach disk");

    // The retry window expires and the backend recovers. The object's stamp now matches
    // live settings again, so the drift check sees nothing — this is where the mixed map
    // used to be written.
    noteSuccess();
    saveCache(p, cache);
  });

  const onDisk = read(p);
  assert.deepEqual(
    dimCounts(onDisk),
    { 3: 2 },
    "the 2-dim vector must be dropped, never persisted beside 3-dim ones",
  );
  assert.equal(onDisk.entries.poison, undefined, "the degraded entry is gone");
  assert.ok(onDisk.entries.a && onDisk.entries.b, "the healthy vectors survive");
});

test("a mixed cache already on disk is REPAIRED on load, so the leaf re-embeds", async () => {
  // The latent-damage net: any cache poisoned before this fix heals the next time it is
  // read, because a dropped entry reads as a cache miss and the next warm recomputes it.
  const p = wikiCachePath();
  seed(p, {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    dim: 3,
    entries: {
      good1: { hash: "h1", vector: [1, 0, 0] },
      good2: { hash: "h2", vector: [0, 1, 0] },
      bad: { hash: "h3", vector: [5, 5] },
    },
  });

  const cache = await withSettingsOverride(SETTINGS, async () => loadCache(p));
  assert.deepEqual(dimCounts(cache), { 3: 2 }, "the outlier is dropped on load");
  assert.equal(cache.entries.bad, undefined, "so the leaf is a miss and will re-embed");
  assert.ok(cache.entries.good1 && cache.entries.good2);
});

test("with NO stamp to trust, the dominant dimension wins, not whichever entry is first", async () => {
  // The vote is the fallback for a file that claims nothing — a legacy cache written before
  // dtype/dim stamping, or a caller-constructed map. `cacheDim` samples the FIRST entry, which
  // is why the pre-fix behaviour depended on insertion order, so the outlier is deliberately
  // listed first here. (When the file DOES carry a stamp it is authoritative — see the
  // load-door test below; that is the shape a real mid-run fallback produces.)
  const p = wikiCachePath();
  seed(p, {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    entries: {
      outlierFirst: { hash: "h0", vector: [7, 7] },
      a: { hash: "h1", vector: [1, 0, 0] },
      b: { hash: "h2", vector: [0, 1, 0] },
      c: { hash: "h3", vector: [0, 0, 1] },
    },
  });

  const cache = await withSettingsOverride(SETTINGS, async () => loadCache(p));
  assert.deepEqual(dimCounts(cache), { 3: 3 }, "the three 3-dim vectors are the majority");
  assert.equal(cache.entries.outlierFirst, undefined);
});

test("a CHUNK vector disagreeing with its leaf drops the chunk set, keeping the entry", async () => {
  // Chunk vectors were the half a top-level-only check would miss: `cacheDim` never looks at
  // them. Scoring a mismatched chunk set yields `best - penalty * (n - 1)` with `best` = 0, so
  // it is 0 for a single chunk and strictly NEGATIVE for two or more (below a genuinely
  // irrelevant leaf) — TWO ragged chunks below, so the negative path is the one exercised.
  // Dropping the array (not the entry) lets the leaf re-chunk on the next chunk-aware read
  // while its whole-leaf vector keeps ranking.
  const p = wikiCachePath();
  seed(p, {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    dim: 3,
    entries: {
      coherent: {
        hash: "hc",
        vector: [1, 0, 0],
        chunks: [
          { hash: "c0", vector: [1, 0, 0] },
          { hash: "c1", vector: [0, 1, 0] },
        ],
      },
      ragged: {
        hash: "hr",
        vector: [0, 1, 0],
        chunks: [
          { hash: "c2", vector: [4, 4, 4, 4, 4] },
          { hash: "c3", vector: [5, 5, 5, 5, 5] },
        ],
      },
    },
  });

  const cache = await withSettingsOverride(SETTINGS, async () => loadCache(p));
  assert.ok(cache.entries.ragged, "the entry survives");
  assert.equal(cache.entries.ragged.chunks, undefined, "its mismatched chunk set is dropped");
  assert.equal(cache.entries.coherent.chunks.length, 2, "a coherent chunk set is untouched");
  assert.deepEqual(dimCounts(cache), { 3: 4 }, "every surviving vector agrees");
});

test("a coherent cache is passed through untouched and silently", async () => {
  const p = wikiCachePath();
  const entries = {
    a: { hash: "ha", vector: [1, 0, 0], chunks: [{ hash: "c0", vector: [0, 1, 0] }] },
    b: { hash: "hb", vector: [0, 0, 1] },
  };
  seed(p, { model: MODEL, backend: "transformers", dtype: "q4", dim: 3, entries });

  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await withSettingsOverride(SETTINGS, async () => {
      const cache = loadCache(p);
      assert.deepEqual(Object.keys(cache.entries).sort(), ["a", "b"]);
      saveCache(p, cache);
    });
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(dimCounts(read(p)), { 3: 3 }, "nothing dropped");
  assert.deepEqual(
    lines.filter((l) => /dimension/i.test(l)),
    [],
    "a healthy cache must produce no dimension diagnostic",
  );
});

test("an EMPTY cache is not treated as inconsistent", async () => {
  const p = wikiCachePath();
  seed(p, { model: MODEL, backend: "transformers", dtype: "q4", dim: 0, entries: {} });
  const cache = await withSettingsOverride(SETTINGS, async () => loadCache(p));
  assert.deepEqual(cache.entries, {}, "no entries, no pruning, no crash");
  // Assert the FIXTURE is in force: loadCache returns `{entries:{}}` both when it accepts an
  // empty file and when it REJECTS a stamp, so without this the test cannot tell them apart.
  assert.equal(cache.model, MODEL, "the seeded file was accepted, not stamp-rejected");
});

test("dominantDim's tie-break is deterministic and prefers the file's own stamped dim", async () => {
  // A 1-1 tie is the only case where the ordering rule is load-bearing, and it is the most
  // intricate expression in the module. With `dim: 2` stamped, 2 must win even though 3 is
  // larger; with an absent stamp the larger wins. Insertion order must not matter.
  const withStamp = wikiCachePath();
  seed(withStamp, {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    dim: 2,
    entries: { big: { hash: "h1", vector: [1, 1, 1] }, small: { hash: "h2", vector: [2, 2] } },
  });
  const a = await withSettingsOverride(SETTINGS, async () => loadCache(withStamp));
  assert.deepEqual(dimCounts(a), { 2: 1 }, "the stamped dim breaks the tie");

  const noStamp = wikiCachePath();
  seed(noStamp, {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    entries: { small: { hash: "h2", vector: [2, 2] }, big: { hash: "h1", vector: [1, 1, 1] } },
  });
  const b = await withSettingsOverride(SETTINGS, async () => loadCache(noStamp));
  assert.deepEqual(dimCounts(b), { 3: 1 }, "with no stamp to defer to, the larger dim wins");
});

test("a malformed chunk vector is repaired, not silently tolerated", async () => {
  // The detector must not be laxer than the pruner: a non-array chunk vector has to register
  // as a disagreement, or that shape is flagged by nothing and repaired by nothing.
  const p = wikiCachePath();
  seed(p, {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    dim: 3,
    entries: { a: { hash: "ha", vector: [1, 0, 0], chunks: [{ hash: "c", vector: null }] } },
  });
  const cache = await withSettingsOverride(SETTINGS, async () => loadCache(p));
  assert.ok(cache.entries.a, "the entry survives");
  assert.equal(cache.entries.a.chunks, undefined, "the malformed chunk set is dropped");
});

test("a uniformly-wrong dimension is coherent — the file-level stamp check owns that", async () => {
  // Every vector agrees with every other, so there is no internal inconsistency to fix.
  // Invalidating a whole cache for the live query dim is loadCache's existing job.
  const p = wikiCachePath();
  seed(p, {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    dim: 5,
    entries: {
      a: { hash: "ha", vector: [1, 1, 1, 1, 1] },
      b: { hash: "hb", vector: [2, 2, 2, 2, 2] },
    },
  });
  const cache = await withSettingsOverride(SETTINGS, async () => loadCache(p));
  assert.equal(Object.keys(cache.entries).length, 2, "a coherent cache is never pruned");
});

test("the dimension diagnostic names the file and fires ONCE per path", async () => {
  const p = wikiCachePath();
  const body = {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    dim: 3,
    entries: {
      a: { hash: "ha", vector: [1, 0, 0] },
      b: { hash: "hb", vector: [0, 1, 0] },
      bad: { hash: "hz", vector: [9] },
    },
  };
  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await withSettingsOverride(SETTINGS, async () => {
      seed(p, body);
      loadCache(p);
      // A second load of the same path must not repeat the diagnostic. Re-seed with a
      // different size so the mtime+size memo cannot short-circuit the read.
      seed(p, { ...body, entries: { ...body.entries, extra: { hash: "he", vector: [3, 3, 3] } } });
      loadCache(p);
    });
  } finally {
    process.stderr.write = write;
  }
  const warnings = lines.filter((l) => /dimension/i.test(l));
  assert.equal(warnings.length, 1, `warned once, got ${warnings.length}: ${warnings.join("")}`);
  assert.match(warnings[0], /embed: /, "follows the subsystem's diagnostic prefix");
  assert.ok(warnings[0].includes(p), "names the cache file");
});

test("the chunk-PRESERVE carrier cannot smuggle an old-dim chunk set onto disk", async () => {
  // `cachedLeafVectors` re-attaches an existing `chunks` array BY REFERENCE on a
  // needChunks:false pass, gated only on the leaf's content hash — which says nothing about
  // model, backend or dimension. So a maintenance pass can staple an old-dim chunk set onto
  // an entry whose whole-leaf vector has since been rebuilt at a new dim, entirely invisible
  // to the file stamp (`cacheDim` never looks at chunks). This is that end state, and the
  // save path must contain it.
  const p = wikiCachePath();
  const cache = {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    dim: 3,
    entries: {
      rebuilt: {
        hash: "hr",
        vector: [1, 0, 0],
        chunks: [
          { hash: "c0", vector: [1, 1, 1, 1, 1] },
          { hash: "c1", vector: [2, 2, 2, 2, 2] },
        ],
      },
      other: { hash: "ho", vector: [0, 1, 0] },
    },
  };

  await withSettingsOverride(SETTINGS, async () => saveCache(p, cache));

  const onDisk = read(p);
  assert.ok(onDisk.entries.rebuilt, "the rebuilt whole-leaf vector survives");
  assert.equal(onDisk.entries.rebuilt.chunks, undefined, "the stale chunk set never reaches disk");
  assert.deepEqual(dimCounts(onDisk), { 3: 2 }, "every persisted vector agrees");
});

test("when the DEGRADED side outnumbers the good, the good vectors still survive", async () => {
  // The regression a plain majority vote introduces. A partly-warm category that falls back
  // mid-run can embed more leaves during the 30s window than it already had cached, so the
  // degraded vectors are the majority. Counting alone then deletes exactly the vectors that
  // match the live model and re-stamps the file to the degraded dim, so the next read discards
  // everything — measured at 20 good + 60 degraded becoming 0 usable, i.e. worse than having
  // no check at all. On the save door the object's stamp came from the last CLEAN file, so it
  // is the authority, whatever the counts say.
  const p = wikiCachePath();
  /** @type {Record<string, { hash: string, vector: number[] }>} */
  const entries = {};
  for (let i = 0; i < 20; i += 1) entries[`good${i}`] = { hash: `hg${i}`, vector: [1, 0, 0] };
  seed(p, { model: MODEL, backend: "transformers", dtype: "q4", dim: 3, entries });

  await withSettingsOverride(SETTINGS, async () => {
    const cache = loadCache(p);
    assert.equal(Object.keys(cache.entries).length, 20, "20 good vectors are cached");
    noteFallback(new Error("model load failed mid-run"));
    for (let i = 0; i < 60; i += 1) {
      cache.entries[`lex${i}`] = { hash: `hl${i}`, vector: [9, 9] };
    }
    noteSuccess();
    saveCache(p, cache);
  });

  const onDisk = read(p);
  assert.equal(onDisk.dim, 3, "the file is still stamped at the model's dimension");
  assert.deepEqual(dimCounts(onDisk), { 3: 20 }, "all 20 good vectors survive; the 60 do not");
});

test("a stamped dim of 0 never wins, and a no-op never burns the one-shot diagnostic", async () => {
  // A `vector: []` entry is the worst poison shape — `sliceIsWarm` calls it warm because
  // `Array.isArray` passes, and `cosine` scores it 0 forever. If 0 could win the vote,
  // pruneDimOutliers (which requires dim > 0) would repair nothing while the warning armed the
  // latch, so the next GENUINE mix on this path would be fixed silently.
  const p = wikiCachePath();
  seed(p, {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    dim: 0,
    entries: { empty: { hash: "he", vector: [] }, real: { hash: "hr", vector: [1, 0, 0] } },
  });

  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  let cache;
  try {
    cache = await withSettingsOverride(SETTINGS, async () => loadCache(p));
  } finally {
    process.stderr.write = write;
  }
  assert.ok(cache.entries.real, "the real vector survives");
  assert.equal(cache.entries.empty, undefined, "the zero-length entry is actually repaired");
  const warnings = lines.filter((l) => /dimension/i.test(l));
  assert.equal(warnings.length, 1, "and the repair IS reported");
  assert.ok(!/keeping 0-dim/.test(warnings[0]), `must not claim to keep 0-dim: ${warnings[0]}`);
});

test("a reader on the MEMO-HIT path is never handed an unpruned map", async () => {
  // loadCache memoises the object and `saveCache` reuses the same `entries` reference, so a
  // writer still filling a map and a reader hitting the memo share one object. Without the
  // check on the hit path the reader scores the writer's mid-run degraded vectors — and a
  // mismatched chunk set scores NEGATIVE, i.e. below a genuinely irrelevant leaf.
  const p = wikiCachePath();
  seed(p, {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    dim: 3,
    entries: { a: { hash: "ha", vector: [1, 0, 0] } },
  });

  await withSettingsOverride(SETTINGS, async () => {
    const writer = loadCache(p);
    writer.entries.degraded = { hash: "hd", vector: [7, 7] };
    // A second load in the same process takes the memo hit and gets the SAME object.
    const reader = loadCache(p, 3);
    assert.equal(reader, writer, "the memo really is shared (else this test proves nothing)");
    assert.equal(reader.entries.degraded, undefined, "the hit path applied the invariant");
    assert.ok(reader.entries.a, "and kept the good vector");
  });
});

test("the LOAD door trusts the file's own stamp, so warm cannot delete the good vectors", async () => {
  // `warm` is the primary heal path and it passes no expectedDim, so the vote decided — and
  // when the degraded side is the MAJORITY (a partly-warm category that fell back mid-run and
  // embedded more leaves during the window than it had cached) the vote kept the degraded
  // dimension and discarded every healthy vector, forcing a full cold re-embed.
  //
  // The stamp is the right authority here: in that path the entries loaded from the clean file
  // are inserted FIRST, so `cacheDim` sampled a good vector and the stamp records the good
  // dimension. It also made the two doors incoherent — save trusted the stamp that load
  // distrusted, so one run kept 256 then 768.
  const p = wikiCachePath();
  seed(p, {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    dim: 3,
    entries: {
      good1: { hash: "h1", vector: [1, 0, 0] },
      good2: { hash: "h2", vector: [0, 1, 0] },
      lex1: { hash: "l1", vector: [9, 9] },
      lex2: { hash: "l2", vector: [8, 8] },
      lex3: { hash: "l3", vector: [7, 7] },
    },
  });

  // No expectedDim — exactly how embed-warm, sync-embeddings, the GC and the webapp load.
  const cache = await withSettingsOverride(SETTINGS, async () => loadCache(p));
  assert.deepEqual(dimCounts(cache), { 3: 2 }, "the two stamped-dimension vectors survive");
  assert.ok(cache.entries.good1 && cache.entries.good2);
  assert.equal(cache.entries.lex1, undefined, "the degraded majority is dropped");
});

test("a repair marks the cache dirty, so an existing persist point flushes it to disk", async () => {
  // Without this the repair lived only in memory: `warm` reported `embedded: 0`, the GC wrote
  // nothing, and `doctor` reported the file red on every run — forever — while the one hint the
  // user got ("re-embeds on the next warm") was false. Every persist point already checks
  // `_dirty`, so setting it is all that is needed.
  const p = wikiCachePath();
  seed(p, {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    dim: 3,
    entries: {
      good: { hash: "h1", vector: [1, 0, 0] },
      bad: { hash: "l1", vector: [9, 9] },
    },
  });

  const cache = await withSettingsOverride(SETTINGS, async () => loadCache(p));
  assert.equal(cache._dirty, true, "a repaired cache must be persistable by its holder");

  // And the flush produces a coherent file, so the next load is a silent no-op.
  await withSettingsOverride(SETTINGS, async () => saveCache(p, cache));
  assert.deepEqual(dimCounts(read(p)), { 3: 1 }, "the repair reached disk");
});

test("a HEALTHY cache is never marked dirty (no write amplification on the read path)", async () => {
  const p = wikiCachePath();
  seed(p, {
    model: MODEL,
    backend: "transformers",
    dtype: "q4",
    dim: 3,
    entries: { a: { hash: "ha", vector: [1, 0, 0] }, b: { hash: "hb", vector: [0, 1, 0] } },
  });
  const cache = await withSettingsOverride(SETTINGS, async () => loadCache(p));
  assert.equal(cache._dirty, undefined, "a clean load must not trigger a save on every search");
});

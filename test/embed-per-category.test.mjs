// Phase D: per-category embedding caches. Each category's vectors live in its
// own hidden file `<wikiRoot>/<category>/.embeddings/embeddings.json`, resolved
// by `embedCacheFor(root, category)`. Scoring, prune, and the upsert/rename
// paths all operate on the leaf's category cache; a multi-category search loads
// each relevant category's cache. The lexical harness keeps this hermetic.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const embed = await import("../scripts/lib/embed.mjs");
const chunk = await import("../scripts/lib/embed-chunk.mjs");
const env = await import("../scripts/lib/env.mjs");

function catCache(category) {
  return env.embedCacheFor(env.wikiRoot(), category);
}

test("embedCacheFor resolves a hidden per-category file under the category dir", () => {
  const p = env.embedCacheFor("/some/wiki", "knowledge");
  assert.equal(p, path.join("/some/wiki", "knowledge", ".embeddings", "embeddings.json"));
  assert.notEqual(
    env.embedCacheFor("/some/wiki", "knowledge"),
    env.embedCacheFor("/some/wiki", "self_improvement"),
    "distinct categories resolve to distinct files",
  );
});

test("a single-category search writes THAT category's cache, not the monolithic file", async () => {
  const res = store.saveDocument({
    name: "pc-single.md",
    text: "# Single\n\nzebra zebra zebra apple orchard.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "pctest" },
  });
  const id = res.created.document.id;

  const out = await store.searchMemoryFiltered({ query: "zebra apple", datasetId: "knowledge" });
  assert.ok(out.records.length >= 1, "search returns the leaf");

  const kPath = catCache("knowledge");
  assert.ok(fs.existsSync(kPath), "the knowledge category cache file exists");
  assert.ok(embed.loadCache(kPath).entries[id], "the leaf's vector is cached under knowledge");

  // The pre-split monolithic <data>/index/embeddings.json is NOT written by search.
  assert.equal(
    fs.existsSync(env.embedCachePath()),
    false,
    "search no longer writes the monolithic root-level cache",
  );
});

test("a two-category search loads BOTH category caches and ranks correctly", async () => {
  const k = store.saveDocument({
    name: "pc-two-knowledge.md",
    text: "# K\n\nkiwi kiwi kiwi lantern telescope.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "pctest" },
  });
  const s = store.saveDocument({
    name: "pc-two-lesson.md",
    text: "# L\n\nmango mango mango umbrella harpsichord.",
    datasetId: "self_improvement",
    metadata: { atom_type: "self-improvement-lesson", project_module: "pctest" },
  });

  // Query strongly matches the knowledge leaf's tokens.
  const out = await store.searchMemoryFiltered({ query: "kiwi lantern telescope", limit: 8 });
  assert.equal(
    out.records[0].documentName,
    "pc-two-knowledge.md",
    "the knowledge leaf ranks first for its own tokens",
  );

  // BOTH categories were scored, so BOTH per-category caches were written.
  const kPath = catCache("knowledge");
  const sPath = catCache("self_improvement");
  assert.ok(fs.existsSync(kPath), "knowledge cache written");
  assert.ok(fs.existsSync(sPath), "self_improvement cache written");
  assert.ok(embed.loadCache(kPath).entries[k.created.document.id], "knowledge leaf cached");
  assert.ok(embed.loadCache(sPath).entries[s.created.document.id], "lesson leaf cached");
});

test("searchMemoryFiltered threads chunkAware through the real search path (parity under lexical)", async () => {
  store.saveDocument({
    name: "pc-chunkaware.md",
    text: "# CA\n\nnarwhal narwhal beacon lighthouse compass.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "pctest" },
  });
  const q = { query: "narwhal beacon", datasetId: "knowledge" };
  const aware = await store.searchMemoryFiltered({ ...q, chunkAware: true });
  const whole = await store.searchMemoryFiltered({ ...q, chunkAware: false });
  assert.ok(
    aware.records.some((r) => r.documentName === "pc-chunkaware.md"),
    "chunkAware:true search returns the leaf (branch + fan-out passthrough exercised)",
  );
  // Under lexical there is no tokenizer, so chunking is a no-op → identical top hit.
  assert.equal(
    aware.records[0].documentName,
    whole.records[0].documentName,
    "chunkAware:true matches whole-leaf under lexical (no regression)",
  );
});

test("renameEmbedding across categories moves the entry between per-category files", () => {
  const from = "knowledge/old/mover.md";
  const to = "self_improvement/new/mover.md";
  const kPath = catCache("knowledge");
  const sPath = catCache("self_improvement");

  const kCache = embed.loadCache(kPath);
  kCache.entries[from] = { hash: "sha256:mover", vector: [0.11, 0.22, 0.33] };
  embed.saveCache(kPath, kCache);

  store.renameEmbedding(from, to);

  assert.ok(!embed.loadCache(kPath).entries[from], "entry removed from the source category cache");
  assert.deepEqual(
    embed.loadCache(sPath).entries[to],
    { hash: "sha256:mover", vector: [0.11, 0.22, 0.33] },
    "entry (with its vector) landed in the destination category cache",
  );
});

test("chunked entry {hash,vector,chunks}: dim is read from .vector (not chunks), so an all-chunked cache is NOT invalidated", () => {
  const p = path.join(fs.mkdtempSync(path.join(dataDir, "chunkcache-")), "e.json");
  // vector is dim-3 but chunk vectors are dim-5: if cacheDim wrongly read a
  // chunk's dim (5) the stamp would be 5, mismatch the query dim (3), and the
  // cache would be invalidated. Surviving proves the dim comes from .vector.
  embed.saveCache(p, {
    entries: {
      "issues/only.md": {
        hash: "sha256:whole",
        vector: [0.1, 0.2, 0.3],
        chunks: [
          { hash: "c0", vector: [1, 2, 3, 4, 5] },
          { hash: "c1", vector: [6, 7, 8, 9, 10] },
        ],
      },
    },
  });
  const loaded = embed.loadCache(p, 3);
  assert.ok(
    loaded.entries["issues/only.md"],
    "chunked cache survives the dim-stamp check (dim from .vector)",
  );
  assert.equal(loaded.entries["issues/only.md"].chunks.length, 2, "chunks round-trip on disk");
});

test("renameEmbedding carries a chunked entry (its chunks included) to the new id", () => {
  const kPath = catCache("knowledge");
  const cache = embed.loadCache(kPath);
  cache.entries["knowledge/old/cm.md"] = {
    hash: "h",
    vector: [1, 2],
    chunks: [{ hash: "c", vector: [1, 2] }],
  };
  embed.saveCache(kPath, cache);
  store.renameEmbedding("knowledge/old/cm.md", "knowledge/new/cm.md");
  const after = embed.loadCache(kPath);
  assert.ok(!after.entries["knowledge/old/cm.md"]);
  assert.equal(
    after.entries["knowledge/new/cm.md"].chunks.length,
    1,
    "chunks moved with the entry",
  );
});

test("upsertEmbedding invalidates a chunked entry when its content hash changed", () => {
  const kPath = catCache("knowledge");
  const cache = embed.loadCache(kPath);
  cache.entries["knowledge/up.md"] = {
    hash: "OLD",
    vector: [1, 2],
    chunks: [{ hash: "c", vector: [1, 2] }],
  };
  embed.saveCache(kPath, cache);
  store.upsertEmbedding("knowledge/up.md", "brand new body");
  assert.ok(
    !embed.loadCache(kPath).entries["knowledge/up.md"],
    "hash-changed chunked entry dropped",
  );
});

test("doctor ignores the hidden per-category .embeddings/ dir (never a stray/orphan)", async () => {
  const { doctor } = await import("../scripts/lib/doctor.mjs");
  store.saveDocument({
    name: "pc-doctor.md",
    text: "# Doc\n\ndoctor scan should skip the hidden embeddings dir.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "pctest" },
  });
  // Populate the hidden cache dir under knowledge.
  await store.searchMemoryFiltered({ query: "doctor scan hidden", datasetId: "knowledge" });
  assert.ok(fs.existsSync(catCache("knowledge")), "cache dir present for the scan");

  const r = doctor(env.wikiRoot());
  const mentionsEmbeddings = (arr, key) =>
    arr.some((e) => String(e[key] || "").includes(".embeddings"));
  assert.ok(!mentionsEmbeddings(r.strays, "stray"), ".embeddings not flagged as a stray");
  assert.ok(!mentionsEmbeddings(r.orphans, "orphan"), ".embeddings not flagged as an orphan");
  assert.ok(
    !r.unlisted.some((u) => u.unlisted.some((c) => String(c.name).includes("embeddings"))),
    ".embeddings not flagged as unlisted",
  );
});

test("embedMany returns vectors aligned to input order (batched == per-item)", async () => {
  const texts = ["alpha alpha beta", "gamma delta", "epsilon zeta eta theta"];
  const many = await embed.embedMany(texts);
  assert.equal(many.length, 3, "one vector per input");
  for (let i = 0; i < texts.length; i += 1) {
    const single = await embed.embed(texts[i]);
    assert.ok(embed.cosine(many[i], single) > 0.999, `row ${i} matches the single embed`);
  }
});

test("embedMany([]) is [] (no model call)", async () => {
  assert.deepEqual(await embed.embedMany([]), []);
});

test("embedMany chunks by batchSize and preserves order across chunk boundaries", async () => {
  const texts = ["one uno", "two dos", "three tres", "four cuatro", "five cinco"];
  const batched = await embed.embedMany(texts, 2); // 3 chunks: [2, 2, 1]
  assert.equal(batched.length, 5);
  for (let i = 0; i < texts.length; i += 1) {
    const single = await embed.embed(texts[i]);
    assert.ok(embed.cosine(batched[i], single) > 0.999, `chunked row ${i} preserved`);
  }
});

test("cachedLeafVectors reuses a hash-matching whole-leaf vector and embeds only the misses", async () => {
  /** @type {import("../scripts/lib/embed.mjs").EmbedCache} */
  const cache = { entries: {} };
  const hit = { id: "knowledge/a.md", embedText: "reused body token", body: "reused body token" };
  cache.entries[hit.id] = { hash: embed.contentHash(hit.embedText), vector: [0.5, 0.5] };
  const items = [
    hit,
    { id: "knowledge/b.md", embedText: "fresh body one", body: "fresh body one" },
    { id: "knowledge/c.md", embedText: "fresh body two", body: "fresh body two" },
  ];
  const out = await chunk.cachedLeafVectors(cache, items, { tokenizer: null, needChunks: false });
  assert.equal(out.length, 3, "aligned to items");
  assert.deepEqual(
    out[0].vector,
    [0.5, 0.5],
    "the hash-matching whole-leaf vector is returned verbatim, not re-embedded",
  );
  assert.ok(cache.entries["knowledge/b.md"], "miss b stored in the cache");
  assert.ok(cache.entries["knowledge/c.md"], "miss c stored in the cache");
  assert.equal(
    cache.entries["knowledge/b.md"].hash,
    embed.contentHash("fresh body one"),
    "the stored entry is keyed by the current content hash",
  );
});

test("tensorRows reshapes a batched [count,dim] tensor into ordered per-input rows", () => {
  // Row-major [3,2]: rows [10,11],[20,21],[30,31]. Distinct per-row values so a
  // transpose or wrong-offset slice (the untested transformer batch path) is RED.
  const out = { dims: [3, 2], data: [10, 11, 20, 21, 30, 31] };
  assert.deepEqual(embed.tensorRows(out, 3), [
    [10, 11],
    [20, 21],
    [30, 31],
  ]);
});

test("tensorRows handles a Float32Array tensor and a single-row (last-chunk) case", () => {
  const out = { dims: [1, 4], data: Float32Array.from([1, 2, 3, 4]) };
  assert.deepEqual(embed.tensorRows(out, 1), [[1, 2, 3, 4]]);
});

test("cachedLeafVectors re-embeds a whole-leaf entry whose content hash changed", async () => {
  /** @type {import("../scripts/lib/embed.mjs").EmbedCache} */
  const cache = { entries: {} };
  cache.entries["knowledge/x.md"] = { hash: "STALE", vector: [9, 9] };
  const [r] = await chunk.cachedLeafVectors(
    cache,
    [{ id: "knowledge/x.md", embedText: "brand new content", body: "brand new content" }],
    { tokenizer: null, needChunks: false },
  );
  assert.notDeepEqual(r.vector, [9, 9], "the stale-hash entry is recomputed, not returned");
  assert.equal(cache.entries["knowledge/x.md"].hash, embed.contentHash("brand new content"));
});

test("cosine guards a dimension mismatch (no bogus high score)", () => {
  // Same length still computes a real similarity.
  assert.ok(Math.abs(embed.cosine([1, 0, 0], [1, 0, 0]) - 1) < 1e-9, "identical vectors -> 1");
  // Different lengths (e.g. a stale lexical-256 vector vs a transformer vector)
  // must NOT mis-score or return a high value.
  assert.equal(embed.cosine([1, 1, 1, 1], [1, 1]), 0, "len mismatch -> 0, never a partial dot");
  assert.equal(
    embed.cosine(new Array(256).fill(1), new Array(1024).fill(1)),
    0,
    "256 vs 1024 -> 0",
  );
});

test("backend/dim stamp invalidates a stale cache on load", () => {
  // Isolated scratch path (not a live category cache other tests populate).
  const p = path.join(dataDir, "stamp-probe", "embeddings.json");
  const seed = embed.loadCache(p);
  seed.entries["knowledge/stamp/z.md"] = { hash: "h", vector: new Array(8).fill(0.1) };
  embed.saveCache(p, seed); // stamps current model + backend + dim(=8)

  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(raw.backend, embed.activeBackend(), "save stamps the active backend");
  assert.equal(raw.dim, 8, "save stamps the vector dim");

  // Same signature -> reused.
  assert.ok(embed.loadCache(p).entries["knowledge/stamp/z.md"], "matching stamp reuses the cache");

  // Explicit expected dim mismatch -> invalidated (dropped, not mis-scored).
  assert.deepEqual(embed.loadCache(p, 16).entries, {}, "dim mismatch drops the cache");
  assert.ok(embed.loadCache(p, 8).entries["knowledge/stamp/z.md"], "matching expected dim reused");

  // Different backend stamp -> invalidated.
  fs.writeFileSync(p, JSON.stringify({ ...raw, backend: "some-other-backend" }));
  assert.deepEqual(embed.loadCache(p).entries, {}, "backend mismatch drops the cache");

  // Different model stamp -> invalidated (pre-existing model-stamp behaviour).
  fs.writeFileSync(p, JSON.stringify({ ...raw, model: "some-other-model" }));
  assert.deepEqual(embed.loadCache(p).entries, {}, "model mismatch drops the cache");
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Force the deterministic lexical backend so cachedLeafVectors' embedMany runs
// without the transformer model (fast, no download); the fake tokenizer below
// drives chunking independently of the backend.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "embed-chunk-test-"));
process.env.MEMORY_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, "settings"), { recursive: true });
fs.writeFileSync(path.join(TMP, "settings", "settings.yaml"), "embed:\n  backend: lexical\n");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { chunkTexts, scoreLeaf, tokenCount, EMBED_WINDOW, cachedLeafVectors, scoreTree } =
  await import("../scripts/lib/embed-chunk.mjs");
const { embed } = await import("../scripts/lib/embed.mjs");

// A word-per-token fake tokenizer: deterministic, round-trips, no specials — so
// a body of N words is exactly N tokens and windowing is exactly assertable.
const fakeTok = {
  encode: (t) => {
    const s = String(t || "").trim();
    return s === "" ? [] : s.split(/\s+/);
  },
  decode: (ids) => ids.join(" "),
};

const HEADER = "TITLE · tag1, tag2\n\n";
const bodyOf = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

test("chunkTexts: no tokenizer (lexical) -> single chunk = embedText", () => {
  const body = bodyOf(2000);
  const et = HEADER + body;
  assert.deepEqual(chunkTexts(et, body, null), [et]);
});

test("chunkTexts: text within the window -> single chunk", () => {
  const body = bodyOf(100);
  const et = HEADER + body;
  assert.deepEqual(chunkTexts(et, body, fakeTok, { window: 512 }), [et]);
});

test("chunkTexts: long body -> multiple chunks, each headered and within the window", () => {
  const body = bodyOf(2000);
  const et = HEADER + body;
  const chunks = chunkTexts(et, body, fakeTok, { window: 512, maxChunks: 6, margin: 8 });
  assert.ok(chunks.length > 1, "splits");
  for (const c of chunks) {
    assert.ok(c.startsWith(HEADER), "each chunk carries the header");
    assert.ok(tokenCount(fakeTok, c) <= 512, `chunk within window (was ${tokenCount(fakeTok, c)})`);
  }
});

test("chunkTexts: caps at maxChunks (very long body drops the remainder)", () => {
  const body = bodyOf(100000);
  const et = HEADER + body;
  const chunks = chunkTexts(et, body, fakeTok, { window: 512, maxChunks: 6, margin: 8 });
  assert.equal(chunks.length, 6);
});

test("chunkTexts: header alone exceeds the budget -> single chunk (degenerate clamp)", () => {
  const bigHeader = bodyOf(600) + "\n\n";
  const body = bodyOf(50);
  const et = bigHeader + body;
  assert.deepEqual(chunkTexts(et, body, fakeTok, { window: 512, margin: 8 }), [et]);
});

test("chunkTexts: empty body -> single chunk", () => {
  const et = HEADER;
  assert.deepEqual(chunkTexts(et, "", fakeTok, { window: 512 }), [et]);
});

test("chunkTexts: no header (body-only) still windows correctly", () => {
  const body = bodyOf(1500);
  const chunks = chunkTexts(body, body, fakeTok, { window: 512, maxChunks: 6, margin: 8 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(tokenCount(fakeTok, c) <= 512);
});

const fakeCos = (_q, v) => v[0];

test("scoreLeaf: n=1 is exactly cosine (penalty never applies to a short leaf)", () => {
  assert.equal(scoreLeaf([1], [[0.73]], 0.015, fakeCos), 0.73);
});

test("scoreLeaf: max over chunks minus penalty*(n-1)", () => {
  const s = scoreLeaf([1], [[0.8], [0.5], [0.9]], 0.015, fakeCos);
  assert.ok(Math.abs(s - (0.9 - 0.03)) < 1e-9, `got ${s}`);
});

test("scoreLeaf: monotonic in best chunk; always finite", () => {
  const lo = scoreLeaf([1], [[0.4], [0.6]], 0.015, fakeCos);
  const hi = scoreLeaf([1], [[0.4], [0.95]], 0.015, fakeCos);
  assert.ok(hi > lo);
  assert.ok(
    Number.isFinite(scoreLeaf([1], [[0.1], [0.1], [0.1], [0.1], [0.1], [0.1]], 0.015, fakeCos)),
  );
});

test("scoreLeaf: empty vecList -> 0 (defensive, never NaN)", () => {
  assert.equal(scoreLeaf([1], [], 0.015, fakeCos), 0);
});

test("scoreLeaf: recovers a leaf whose WHOLE-leaf vector misses but a chunk matches (models truncation)", () => {
  // Real geometry (default cosine): the query is orthogonal to the head-only
  // whole-leaf vector (a truncated vector never saw the tail) but aligned with a
  // tail chunk. Chunk-aware max recovers the leaf; the whole-leaf baseline misses.
  const q = [0, 1];
  const wholeLeafMiss = scoreLeaf(q, [[1, 0]], 0.015);
  const chunkAwareHit = scoreLeaf(
    q,
    [
      [1, 0],
      [0, 1],
    ],
    0.015,
  );
  assert.ok(wholeLeafMiss < 0.01, `whole-leaf (head) misses the tail query (${wholeLeafMiss})`);
  assert.ok(chunkAwareHit > 0.9, `a matching tail chunk recovers the leaf (${chunkAwareHit})`);
});

test("EMBED_WINDOW is the bge-large window", () => {
  assert.equal(EMBED_WINDOW, 512);
});

// ── cachedLeafVectors (lexical backend + fake tokenizer) ──────────────────
const item = (id, body) => ({ id, embedText: HEADER + body, body });
const opts = (needChunks) => ({
  tokenizer: fakeTok,
  needChunks,
  window: 30,
  maxChunks: 6,
  margin: 4,
});

test("cachedLeafVectors: every leaf gets a vector; a short leaf has no chunks", async () => {
  const cache = { entries: {} };
  const out = await cachedLeafVectors(cache, [item("a.md", bodyOf(5))], opts(true));
  assert.ok(Array.isArray(out[0].vector));
  assert.equal(out[0].chunks, undefined);
  assert.equal(cache.entries["a.md"].chunks, undefined);
  assert.ok(Array.isArray(cache.entries["a.md"].vector));
});

test("cachedLeafVectors: long leaf + needChunks -> chunks in out AND entry, whole-leaf vector kept", async () => {
  const cache = { entries: {} };
  const out = await cachedLeafVectors(cache, [item("b.md", bodyOf(200))], opts(true));
  assert.ok(out[0].chunks.length > 1, "scored over chunks");
  assert.ok(Array.isArray(cache.entries["b.md"].vector), "whole-leaf vector kept");
  assert.equal(cache.entries["b.md"].chunks.length, out[0].chunks.length);
  assert.ok(
    cache.entries["b.md"].chunks.every(
      (c) => typeof c.hash === "string" && Array.isArray(c.vector),
    ),
  );
});

test("cachedLeafVectors: needChunks:false never chunks (consolidate path) -> vector-only", async () => {
  const cache = { entries: {} };
  const out = await cachedLeafVectors(cache, [item("c.md", bodyOf(200))], opts(false));
  assert.equal(out[0].chunks, undefined);
  assert.equal(cache.entries["c.md"].chunks, undefined);
  assert.ok(Array.isArray(cache.entries["c.md"].vector));
});

test("cachedLeafVectors: vector reused on a hash hit (same cached array)", async () => {
  const cache = { entries: {} };
  const it = [item("d.md", bodyOf(5))];
  const a = await cachedLeafVectors(cache, it, opts(true));
  const b = await cachedLeafVectors(cache, it, opts(true));
  assert.deepEqual(b[0].vector, a[0].vector);
  assert.equal(cache.entries["d.md"].vector, b[0].vector);
});

test("cachedLeafVectors: legacy {hash,vector}-only entry on a truncated leaf -> chunks added, vector kept", async () => {
  const it = item("e.md", bodyOf(200));
  const cache = { entries: {} };
  await cachedLeafVectors(cache, [it], opts(false));
  const legacyVec = cache.entries["e.md"].vector;
  assert.equal(cache.entries["e.md"].chunks, undefined);
  const out = await cachedLeafVectors(cache, [it], opts(true));
  assert.ok(out[0].chunks.length > 1);
  assert.equal(cache.entries["e.md"].vector, legacyVec, "whole-leaf vector preserved on hash hit");
  assert.ok(cache.entries["e.md"].chunks.length > 1);
});

test("cachedLeafVectors: a needChunks:false pass PRESERVES chunks a prior recall built", async () => {
  const it = item("f.md", bodyOf(200));
  const cache = { entries: {} };
  await cachedLeafVectors(cache, [it], opts(true));
  const chunksBefore = cache.entries["f.md"].chunks;
  await cachedLeafVectors(cache, [it], opts(false));
  assert.equal(cache.entries["f.md"].chunks, chunksBefore, "chunks preserved, not stripped");
});

test("cachedLeafVectors: tokenizer null (lexical) -> single vector even for a long leaf", async () => {
  const cache = { entries: {} };
  const out = await cachedLeafVectors(cache, [item("g.md", bodyOf(200))], {
    tokenizer: null,
    needChunks: true,
    window: 30,
  });
  assert.equal(out[0].chunks, undefined);
  assert.equal(cache.entries["g.md"].chunks, undefined);
});

// ── scoreTree wiring (real lexical vectors + fake tokenizer) ──────────────
const cand = (id, body) => ({ id, datasetId: "knowledge", embedText: HEADER + body, text: body });
const cacheStore = () => {
  const caches = {};
  return (cat) => (caches[cat] ||= { entries: {} });
};

test("scoreTree: chunkAware scores a long leaf by its best sub-region (a tail token diluted in the whole)", async () => {
  const tailTok = "quokkazephyr";
  const body = `${bodyOf(600)} ${tailTok}`; // tail token in the last chunk, not the head
  const cands = [cand("k/long.md", body)];
  const q = await embed(tailTok);
  const key = "knowledge\0k/long.md";
  const aware = await scoreTree(cands, cacheStore(), q, {
    chunkAware: true,
    tokenizer: fakeTok,
    penalty: 0.015,
    maxChunks: 6,
  });
  const whole = await scoreTree(cands, cacheStore(), q, {
    chunkAware: false,
    tokenizer: fakeTok,
    penalty: 0.015,
    maxChunks: 6,
  });
  assert.ok(
    aware.get(key) > whole.get(key),
    `chunk-aware (${aware.get(key)}) beats whole-leaf (${whole.get(key)}) on a tail query`,
  );
});

test("cachedLeafVectors: a FULL item uncaps chunk count (fullMaxChunks); non-full caps at maxChunks", async () => {
  const body = bodyOf(400);
  const et = HEADER + body;
  const o = {
    tokenizer: fakeTok,
    needChunks: true,
    window: 30,
    maxChunks: 6,
    margin: 4,
    fullMaxChunks: 20,
  };
  const capped = await cachedLeafVectors(
    { entries: {} },
    [{ id: "x", embedText: et, body, full: false }],
    o,
  );
  const uncapped = await cachedLeafVectors(
    { entries: {} },
    [{ id: "x", embedText: et, body, full: true }],
    o,
  );
  assert.equal(capped[0].chunks.length, 6, "non-full capped at maxChunks");
  assert.ok(uncapped[0].chunks.length > 6, `full uncapped (got ${uncapped[0].chunks.length})`);
});

test("scoreTree: a FULL candidate scores with NO penalty (length never hurts its rank)", async () => {
  // scoreTree uses the real 512-token window (it doesn't forward a test window),
  // so the body must exceed 512 tokens to chunk. ~600 words -> 2 chunks for BOTH
  // full and atomic (under either cap), isolating the penalty difference.
  const body = bodyOf(600);
  const et = HEADER + body;
  const q = await embed("w3");
  const key = "knowledge\0f.md";
  const o = {
    chunkAware: true,
    tokenizer: fakeTok,
    penalty: 0.015,
    maxChunks: 6,
    fullPenalty: 0,
    fullMaxChunks: 20,
  };
  const full = await scoreTree(
    [{ id: "f.md", datasetId: "knowledge", embedText: et, text: body, full: true }],
    cacheStore(),
    q,
    o,
  );
  const atomic = await scoreTree(
    [{ id: "f.md", datasetId: "knowledge", embedText: et, text: body, full: false }],
    cacheStore(),
    q,
    o,
  );
  assert.ok(
    full.get(key) > atomic.get(key),
    `full (${full.get(key)}) beats penalized atomic (${atomic.get(key)})`,
  );
});

test("scoreTree: a SHORT leaf scores identically under chunkAware true/false (no regression)", async () => {
  const cands = [cand("k/short.md", bodyOf(10))];
  const q = await embed("w3");
  const key = "knowledge\0k/short.md";
  const aware = await scoreTree(cands, cacheStore(), q, {
    chunkAware: true,
    tokenizer: fakeTok,
    penalty: 0.015,
    maxChunks: 6,
  });
  const whole = await scoreTree(cands, cacheStore(), q, {
    chunkAware: false,
    tokenizer: fakeTok,
    penalty: 0.015,
    maxChunks: 6,
  });
  assert.equal(aware.get(key), whole.get(key), "short leaf: chunk-aware is a no-op");
});

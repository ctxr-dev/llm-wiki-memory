import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";
import { warmWikiEmbeddings, pauseAfterSlice, sliceIsWarm } from "../scripts/lib/embed-warm.mjs";
import { loadCache, contentHash } from "../scripts/lib/embed.mjs";
import { embedCacheFor } from "../scripts/lib/env.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

function seed(rel, focus, body) {
  const abs = path.join(wiki, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(
    abs,
    `---\nfocus: ${focus}\nmemory:\n  atom_type: decision\n  status: active\n---\n${body}\n`,
  );
}

test("pauseAfterSlice clamps into [200, 10000] at 3x the slice duration", () => {
  assert.equal(pauseAfterSlice(0), 200);
  assert.equal(pauseAfterSlice(50), 200);
  assert.equal(pauseAfterSlice(400), 1200);
  assert.equal(pauseAfterSlice(10_000), 10_000);
});

test("cold warm embeds every active leaf, persists caches, and pauses between miss slices", async () => {
  seed("knowledge/a.md", "alpha", "First fact about kafka.");
  seed("knowledge/b.md", "beta", "Second fact about queues.");
  seed("knowledge/c.md", "gamma", "Third fact about topics.");
  seed("plans/p.md", "plan", "A plan body.");
  const pauses = [];
  const stats = await warmWikiEmbeddings(wiki, {
    sliceSize: 2,
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
  assert.ok(stats.leaves >= 4, `saw the seeded leaves; got ${JSON.stringify(stats)}`);
  assert.ok(stats.embedded >= 4, "cold leaves were embedded");
  assert.equal(stats.paused, pauses.length);
  assert.ok(pauses.length >= 2, "paused after each miss slice");
  assert.ok(
    pauses.every((ms) => ms >= 200 && ms <= 10_000),
    `pauses clamped; got ${pauses}`,
  );
  const cache = loadCache(embedCacheFor(wiki, "knowledge"));
  assert.equal(Object.keys(cache.entries).length >= 3, true, "knowledge cache persisted");
});

test("the warm covers ARCHIVED leaves too (they are searchable, so they must not stay cold)", async () => {
  const abs = path.join(wiki, "knowledge", "retired.md");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(
    abs,
    `---\nfocus: retired\nmemory:\n  atom_type: decision\n  status: archived\n---\nAn archived fact about queues.\n`,
  );
  const stats = await warmWikiEmbeddings(wiki, { sliceSize: 2, sleep: async () => {} });
  assert.ok(stats.embedded >= 1, `the archived leaf was embedded; got ${JSON.stringify(stats)}`);
  const cache = loadCache(embedCacheFor(wiki, "knowledge"));
  assert.ok(cache.entries["knowledge/retired.md"], "archived leaf is in the cache");
});

// The all-warm skip must be CONSERVATIVE: reporting a leaf warm when it still
// needs work is how the warm silently stops converging, so every "warm" verdict
// here has to be one we can prove.
test("sliceIsWarm only reports warm when there is provably nothing left to do", () => {
  const short = { id: "k/short.md", embedText: "tiny" };
  const long = { id: "k/long.md", embedText: "x".repeat(500) };
  const hash = (t) => contentHash(t);
  const withEntry = (item, entry) => ({ entries: { [item.id]: entry } });

  assert.equal(sliceIsWarm({ entries: {} }, [short], 100), false, "no entry at all");
  assert.equal(
    sliceIsWarm(withEntry(short, { hash: "stale", vector: [1] }), [short], 100),
    false,
    "a stale hash (the leaf was edited) is never warm",
  );
  assert.equal(
    sliceIsWarm(withEntry(short, { hash: hash(short.embedText) }), [short], 100),
    false,
    "an entry with no vector is not warm",
  );
  assert.equal(
    sliceIsWarm(withEntry(short, { hash: hash(short.embedText), vector: [1] }), [short], 100),
    true,
    "short enough that a chunk set is impossible -> warm",
  );
  assert.equal(
    sliceIsWarm(withEntry(long, { hash: hash(long.embedText), vector: [1] }), [long], 100),
    false,
    "long enough to POSSIBLY need chunks and none present -> not warm",
  );
  assert.equal(
    sliceIsWarm(
      withEntry(long, {
        hash: hash(long.embedText),
        vector: [1],
        chunks: [{ hash: "c", vector: [1] }],
      }),
      [long],
      100,
    ),
    true,
    "long but already carries a chunk set -> warm",
  );
  assert.equal(
    sliceIsWarm(
      { entries: { [short.id]: { hash: hash(short.embedText), vector: [1] } } },
      [short, long],
      100,
    ),
    false,
    "one cold leaf makes the whole slice not warm",
  );
});

test("a second warm over the same content is an all-hit no-op with zero pauses", async () => {
  const pauses = [];
  const stats = await warmWikiEmbeddings(wiki, {
    sliceSize: 2,
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
  assert.equal(stats.embedded, 0, "nothing re-embedded");
  assert.equal(pauses.length, 0, "no pauses on a warm wiki");
});

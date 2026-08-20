// saveCache re-stamps the cache from LIVE settings. That is correct only while the
// entries it is stamping were produced under those same settings.
//
// The window is not a microsecond race: warmWikiEmbeddings calls loadCache ONCE per
// category and then embeds slice-by-slice with a deliberate duty-cycle pause, so a
// cold warm holds one cache object open for minutes. A settings edit in that window
// used to re-label the ENTIRE pre-existing entries map — 898 q4 vectors persisted as
// q8. A q4->q8 flip preserves the vector dimension, so loadCache's file-level check
// has nothing to catch and the mixed-precision cache validates forever, silently
// degrading cosine ranking.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCache, saveCache } from "../scripts/lib/embed-cache-io.mjs";
import { __resetForTest } from "../scripts/lib/embed-backend-state.mjs";
import { withSettingsOverride } from "../scripts/lib/settings.mjs";

const MODEL = "test/stamp-model";
/** @param {string} dtype */
const settingsFor = (dtype) => ({ embed: { backend: "transformers", model: MODEL, dtype } });

function tmpCachePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-stamp-"));
  return path.join(dir, "embeddings.json");
}

/** @param {string} cachePath */
const readStamp = (cachePath) => JSON.parse(fs.readFileSync(cachePath, "utf8"));

test("a dtype change between load and save does NOT re-label the already-cached vectors", async () => {
  __resetForTest();
  const cachePath = tmpCachePath();
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      model: MODEL,
      backend: "transformers",
      dtype: "q4",
      dim: 3,
      entries: { a: { hash: "h1", vector: [1, 0, 0] }, b: { hash: "h2", vector: [0, 1, 0] } },
    }),
  );

  const cache = await withSettingsOverride(settingsFor("q4"), async () => loadCache(cachePath));
  assert.equal(Object.keys(cache.entries).length, 2, "the q4 cache loads under q4 settings");

  // The operator edits embed.dtype while the run holds this cache object open.
  await withSettingsOverride(settingsFor("q8"), async () => saveCache(cachePath, cache));

  // The on-disk file is left ALONE: it still describes itself honestly as q4, and
  // loadCache will reject it under q8 on the next read. What must never happen is q4
  // vectors persisted under a q8 stamp, which no later check could detect.
  const onDisk = readStamp(cachePath);
  assert.equal(onDisk.dtype, "q4", "the drifting save leaves the on-disk cache authoritative");
  assert.deepEqual(Object.keys(onDisk.entries), ["a", "b"], "and does not destroy it");
  assert.equal(cache.dtype, "q8", "the in-memory object is re-stamped so the run continues");
  assert.deepEqual(Object.keys(cache.entries), [], "old-signature vectors are dropped in memory");
});

test("after the drift is reconciled, the SAME cache object accumulates cleanly", async () => {
  __resetForTest();
  const cachePath = tmpCachePath();
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      model: MODEL,
      backend: "transformers",
      dtype: "q4",
      dim: 3,
      entries: { old: { hash: "h", vector: [1, 0, 0] } },
    }),
  );
  const cache = await withSettingsOverride(settingsFor("q4"), async () => loadCache(cachePath));

  await withSettingsOverride(settingsFor("q8"), async () => {
    saveCache(cachePath, cache);
    // The warm loop keeps writing into the object it already holds; those vectors
    // ARE q8, so the next save must persist them rather than drop them again.
    cache.entries.fresh = { hash: "h2", vector: [0, 0, 1] };
    saveCache(cachePath, cache);
  });

  const onDisk = readStamp(cachePath);
  assert.equal(onDisk.dtype, "q8");
  assert.deepEqual(Object.keys(onDisk.entries), ["fresh"], "post-change vectors survive");
});

test("no drift -> entries are persisted untouched (the normal path is unaffected)", async () => {
  __resetForTest();
  const cachePath = tmpCachePath();
  const cache = await withSettingsOverride(settingsFor("q4"), async () => {
    const c = loadCache(cachePath);
    c.entries.a = { hash: "h", vector: [1, 2, 3] };
    saveCache(cachePath, c);
    return c;
  });
  const onDisk = readStamp(cachePath);
  assert.deepEqual(Object.keys(onDisk.entries), ["a"], "a stable config persists normally");
  assert.equal(onDisk.dim, 3);
  assert.equal(cache.entries.a.hash, "h");
});

test("a legacy cache with NO dtype stamp is not treated as drifted", async () => {
  __resetForTest();
  const cachePath = tmpCachePath();
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      model: MODEL,
      backend: "transformers",
      dim: 3,
      entries: { a: { hash: "h", vector: [1, 0, 0] } },
    }),
  );
  const cache = await withSettingsOverride(settingsFor("q4"), async () => loadCache(cachePath));
  assert.equal(Object.keys(cache.entries).length, 1, "loadCache accepts an unstamped dtype");
  await withSettingsOverride(settingsFor("q4"), async () => saveCache(cachePath, cache));
  assert.deepEqual(
    Object.keys(readStamp(cachePath).entries),
    ["a"],
    "an absent dtype matches any dtype, exactly as loadCache treats it",
  );
});

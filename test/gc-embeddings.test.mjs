// gc-embeddings: on-demand pruning of orphaned embedding-cache entries (ids
// whose leaf no longer exists on disk). Live-leaf entries are kept.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const embed = await import("../scripts/lib/embed.mjs");
const env = await import("../scripts/lib/env.mjs");

test("pruneEmbeddingCache drops orphan ids and keeps live-leaf ids", () => {
  // A real live leaf on disk; its rel id must survive the sweep.
  const res = store.saveDocument({
    name: "gc-live.md",
    text: "# Live\n\nthis leaf exists on disk.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "gctest" },
  });
  const liveId = res.created.document.id;

  // Seed the cache with the live id + two orphans (ids with no leaf on disk).
  const cachePath = env.embedCachePath();
  const cache = embed.loadCache(cachePath); // correct model header for this env
  cache.entries[liveId] = { hash: "sha256:live", vector: [0.1, 0.2] };
  cache.entries["knowledge/gone/reference/orphan-a.md"] = { hash: "sha256:a", vector: [0.3] };
  cache.entries["issues/JIRA/DEV/999/9/9/DEV-999999.md"] = { hash: "sha256:b", vector: [0.4] };
  embed.saveCache(cachePath, cache);

  // Dry-run: reports the 2 orphans, writes nothing.
  const dry = store.pruneEmbeddingCache({ dryRun: true });
  assert.equal(dry.removed, 2, "dry-run counts both orphans");
  assert.equal(dry.after, dry.before, "dry-run does not shrink the cache");
  assert.ok(embed.loadCache(cachePath).entries["knowledge/gone/reference/orphan-a.md"], "orphan still present after dry-run");

  // Real run: orphans removed, live id kept.
  const before = embed.loadCache(cachePath);
  const beforeCount = Object.keys(before.entries).length;
  const r = store.pruneEmbeddingCache();
  assert.equal(r.removed, 2);
  assert.equal(r.after, beforeCount - 2);

  const reloaded = embed.loadCache(cachePath);
  assert.ok(reloaded.entries[liveId], "live-leaf entry kept");
  assert.ok(!reloaded.entries["knowledge/gone/reference/orphan-a.md"], "orphan-a removed");
  assert.ok(!reloaded.entries["issues/JIRA/DEV/999/9/9/DEV-999999.md"], "orphan-b removed");

  // Idempotent: a second sweep removes nothing.
  const again = store.pruneEmbeddingCache();
  assert.equal(again.removed, 0, "second sweep is a no-op");
});

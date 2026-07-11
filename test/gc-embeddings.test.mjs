// gc-embeddings: on-demand pruning of orphaned embedding-cache entries (ids
// whose leaf no longer exists on disk). Live-leaf entries are kept.

import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const embed = await import("../scripts/lib/embed.mjs");
const env = await import("../scripts/lib/env.mjs");
const { __setSettingsForTest, __clearSettingsForTest } =
  await import("../scripts/lib/settings.mjs");

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
  assert.ok(
    embed.loadCache(cachePath).entries["knowledge/gone/reference/orphan-a.md"],
    "orphan still present after dry-run",
  );

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

afterEach(() => {
  __clearSettingsForTest();
});

test("--if-due throttle: disabled / due / not-due / stamps state", () => {
  const statePath = env.GC_STATE_PATH;
  const clearState = () => {
    try {
      fs.rmSync(statePath);
    } catch {
      /* none */
    }
  };

  // disabled (0/off): never sweeps, no state written.
  clearState();
  __setSettingsForTest({ gc: { intervalDays: 0 } });
  const disabled = store.pruneEmbeddingCache({ ifDue: true });
  assert.equal(disabled.skipped, "disabled");
  assert.ok(!fs.existsSync(statePath), "disabled run writes no state");

  // due (no prior state): sweeps + stamps last_run_utc.
  __setSettingsForTest({ gc: { intervalDays: 7 } });
  const first = store.pruneEmbeddingCache({ ifDue: true });
  assert.ok(!first.skipped, "no prior state -> runs");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.ok(Date.parse(state.last_run_utc), "last_run_utc stamped");

  // not-due (just ran, within 7d): skipped, reports next_due_utc.
  const second = store.pruneEmbeddingCache({ ifDue: true });
  assert.equal(second.skipped, "not-due");
  assert.ok(Date.parse(second.next_due_utc) > Date.now(), "next_due in the future");

  // due again after backdating the last run > interval.
  fs.writeFileSync(
    statePath,
    JSON.stringify({ last_run_utc: new Date(Date.now() - 10 * 86_400_000).toISOString() }),
  );
  const third = store.pruneEmbeddingCache({ ifDue: true });
  assert.ok(!third.skipped, "backdated past the interval -> runs again");
  const restamped = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.ok(Date.now() - Date.parse(restamped.last_run_utc) < 60_000, "timestamp refreshed");

  // unconditional run (no ifDue) always stamps state too.
  clearState();
  store.pruneEmbeddingCache();
  assert.ok(fs.existsSync(statePath), "unconditional run stamps state");

  // dry-run with ifDue when due: reports but writes no state.
  clearState();
  const dry = store.pruneEmbeddingCache({ ifDue: true, dryRun: true });
  assert.ok(!dry.skipped, "due -> would run");
  assert.ok(!fs.existsSync(statePath), "dry-run writes no state");
});

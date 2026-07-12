import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setupWorkspace, cleanup, SRC } from "./harness.mjs";

// Brain-global settings (lexical embed backend) come from MEMORY_DATA_DIR.
const { dataDir } = setupWorkspace({ init: false });
const { syncEmbeddings } = await import("../scripts/hooks/sync-embeddings.mjs");

/** @type {string[]} */
const tmps = [];
function mountWith(sharedYaml) {
  const mount = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-sync-")));
  tmps.push(mount);
  const wiki = path.join(mount, ".llm-wiki-memory", "wiki");
  fs.mkdirSync(path.join(wiki, ".layout"), { recursive: true });
  fs.writeFileSync(path.join(wiki, ".layout", "layout.yaml"), sharedYaml);
  return { mount, wiki };
}
function writeLeaf(wiki, rel, body) {
  const abs = path.join(wiki, rel.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---\nmemory:\n  status: active\n---\n${body}\n`);
}
after(() => {
  cleanup(dataDir);
  for (const d of tmps) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

const SHARED_LAYOUT =
  "layout:\n  - path: shared_notes\n    ownership: repo\n  - path: self_improvement\n    ownership: wiki\n";

test("syncEmbeddings warms the embedding cache for a changed SHARED category", async () => {
  const { mount, wiki } = mountWith(SHARED_LAYOUT);
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\nshared note about kafka partition keys");
  const cachePath = path.join(wiki, "shared_notes", ".embeddings", "embeddings.json");
  assert.ok(!fs.existsSync(cachePath), "no cache before the sync");

  const res = await syncEmbeddings({
    mountDir: mount,
    changedPaths: [".llm-wiki-memory/wiki/shared_notes/note.md"],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.warmed, ["shared_notes"]);

  assert.ok(fs.existsSync(cachePath), "cache written after the sync");
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const entry = cache.entries["shared_notes/note.md"];
  assert.ok(entry, "leaf embedded and keyed by its wiki-relative id");
  assert.ok(Array.isArray(entry.vector) && entry.vector.length > 0, "a vector was computed");
});

test("syncEmbeddings ignores a changed PERSONAL (ownership==wiki) category", async () => {
  const { mount, wiki } = mountWith(SHARED_LAYOUT);
  writeLeaf(wiki, "self_improvement/x.md", "# Lesson\n\npersonal lesson body");
  const res = await syncEmbeddings({
    mountDir: mount,
    changedPaths: [".llm-wiki-memory/wiki/self_improvement/x.md"],
  });
  assert.deepEqual(res.warmed, [], "personal category is not warmed by the shared-sync hook");
});

test("syncEmbeddings skips cleanly when the mount has no wiki", async () => {
  const res = await syncEmbeddings({ mountDir: path.join(os.tmpdir(), "lwm-does-not-exist-xyz") });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, "no-wiki");
});

test("the sync-embeddings.sh wrapper always exits 0 (best-effort, never blocks git)", () => {
  const noGitDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-syncsh-")));
  tmps.push(noGitDir);
  const r = spawnSync("bash", [path.join(SRC, "scripts", "hooks", "sync-embeddings.sh")], {
    encoding: "utf8",
    cwd: noGitDir,
    env: process.env,
  });
  assert.equal(r.status, 0, "wrapper exits 0 even outside a git repo / wiki");
});

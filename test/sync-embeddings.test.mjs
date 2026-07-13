import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setupWorkspace, cleanup, SRC } from "./harness.mjs";

// Brain-global settings (lexical embed backend) come from MEMORY_DATA_DIR.
const { dataDir } = setupWorkspace({ init: false });
const { syncEmbeddings, changedPathsFromGit } =
  await import("../scripts/hooks/sync-embeddings.mjs");

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

const TWO_SHARED_LAYOUT =
  "layout:\n  - path: shared_notes\n    ownership: repo\n  - path: team\n    ownership: repo\n";

test("syncEmbeddings full=true warms EVERY shared category with no changedPaths (degenerate-range fallback, F5g)", async () => {
  const { mount, wiki } = mountWith(TWO_SHARED_LAYOUT);
  writeLeaf(wiki, "shared_notes/a.md", "# A\n\nshared note a");
  writeLeaf(wiki, "team/b.md", "# B\n\nshared note b");
  const res = await syncEmbeddings({ mountDir: mount, full: true });
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.warmed.sort(),
    ["shared_notes", "team"],
    "both shared cats warmed, no paths given",
  );
  assert.ok(fs.existsSync(path.join(wiki, "shared_notes", ".embeddings", "embeddings.json")));
  assert.ok(fs.existsSync(path.join(wiki, "team", ".embeddings", "embeddings.json")));
});

/** @returns {{ d: string, git: (a: string[]) => import("node:child_process").SpawnSyncReturns<string> }} */
function gitRepo() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-syncgit-")));
  tmps.push(d);
  const git = (/** @type {string[]} */ a) =>
    spawnSync("git", ["-C", d, ...a], { encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  return { d, git };
}

test("changedPathsFromGit: a resolvable HEAD~1..HEAD range → {full:false} with the changed paths (F5f)", () => {
  const { d, git } = gitRepo();
  fs.writeFileSync(path.join(d, "a.txt"), "1\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "c1"]);
  fs.writeFileSync(path.join(d, "b.txt"), "2\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "c2"]);
  const res = changedPathsFromGit(d, []);
  assert.equal(res.full, false, "a resolvable range is not a full warm");
  assert.deepEqual(res.paths, ["b.txt"], "HEAD~1..HEAD lists the changed file");
});

test("changedPathsFromGit: a 2-SHA argv uses shas[0]..shas[1] (post-checkout, F5f)", () => {
  const { d, git } = gitRepo();
  fs.writeFileSync(path.join(d, "a.txt"), "1\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "c1"]);
  fs.writeFileSync(path.join(d, "b.txt"), "2\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "c2"]);
  const prev = git(["rev-parse", "HEAD~1"]).stdout.trim();
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  const res = changedPathsFromGit(d, [prev, head]);
  assert.equal(res.full, false);
  assert.deepEqual(res.paths, ["b.txt"]);
});

test("changedPathsFromGit: a root-commit-only repo (no HEAD~1, no ORIG_HEAD) → {full:true} (F5f/G2 fragility)", () => {
  const { d, git } = gitRepo();
  fs.writeFileSync(path.join(d, "a.txt"), "1\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "root"]);
  const res = changedPathsFromGit(d, []);
  assert.equal(res.full, true, "an unresolvable range falls back to a full warm, not a silent []");
  assert.deepEqual(res.paths, []);
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

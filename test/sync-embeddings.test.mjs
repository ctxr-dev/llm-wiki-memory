import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setupWorkspace, cleanup, SRC } from "./harness.mjs";
import { ensureIndexes } from "../scripts/lib/wiki-cli.mjs";

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

test("syncEmbeddings SKIPS a conflicted (invalid-YAML) shared leaf instead of aborting the warm", async () => {
  const { mount, wiki } = mountWith(SHARED_LAYOUT);
  writeLeaf(wiki, "shared_notes/good.md", "# Good\n\nclean shared note about kafka");
  // A git-conflicted leaf: markers INSIDE the frontmatter → matter() throws on parse.
  fs.writeFileSync(
    path.join(wiki, "shared_notes", "bad.md"),
    `---\nmemory:\n<<<<<<< HEAD\n  status: active\n=======\n  status: archived\n>>>>>>> x\n---\nconflicted body\n`,
  );
  const res = await syncEmbeddings({
    mountDir: mount,
    changedPaths: [
      ".llm-wiki-memory/wiki/shared_notes/good.md",
      ".llm-wiki-memory/wiki/shared_notes/bad.md",
    ],
  });
  assert.equal(res.ok, true, "the warm resolves despite the conflicted leaf");
  const cache = JSON.parse(
    fs.readFileSync(path.join(wiki, "shared_notes", ".embeddings", "embeddings.json"), "utf8"),
  );
  assert.ok(cache.entries["shared_notes/good.md"], "the clean leaf is warmed");
  assert.ok(!cache.entries["shared_notes/bad.md"], "the conflicted leaf is skipped, not warmed");
});

test("syncEmbeddings does NOT throw when the shared category tree is READ-ONLY (best-effort persist)", async () => {
  // The "owner curates, teammate consumes read-only" model: the shared tree isn't
  // writable, so .embeddings/ can't be created. The warm must resolve (ok:true),
  // not throw out of the detached hook. Skip where 0o555 doesn't block writes.
  const { mount, wiki } = mountWith(SHARED_LAYOUT);
  writeLeaf(wiki, "shared_notes/ro.md", "# RO\n\nread only shared note about kafka");
  const cat = path.join(wiki, "shared_notes");
  fs.chmodSync(cat, 0o555);
  let modeBlocks = false;
  try {
    fs.mkdirSync(path.join(cat, ".embeddings"));
  } catch {
    modeBlocks = true;
  }
  if (!modeBlocks) {
    fs.chmodSync(cat, 0o755);
    return; // root / a mode-ignoring FS → skip
  }
  try {
    const res = await syncEmbeddings({
      mountDir: mount,
      changedPaths: [".llm-wiki-memory/wiki/shared_notes/ro.md"],
    });
    assert.equal(
      res.ok,
      true,
      "the warm resolves despite an unwritable tree (persist is best-effort)",
    );
    assert.deepEqual(res.warmed, ["shared_notes"]);
  } finally {
    fs.chmodSync(cat, 0o755); // restore so after() can clean up
  }
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

test("syncEmbeddings resolves the category via the .llm-wiki-memory anchor even under a `wiki/` dir", async () => {
  // The mount holder is literally named `wiki`, so the repo-relative changed path
  // leads with a spurious `wiki` segment; anchoring on `.llm-wiki-memory` (not the
  // first `wiki`) must still resolve the real category.
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-wikidir-")));
  tmps.push(outer);
  const mount = path.join(outer, "wiki");
  const wiki = path.join(mount, ".llm-wiki-memory", "wiki");
  fs.mkdirSync(path.join(wiki, ".layout"), { recursive: true });
  fs.writeFileSync(path.join(wiki, ".layout", "layout.yaml"), SHARED_LAYOUT);
  writeLeaf(wiki, "shared_notes/note.md", "# n\n\nbody about kafka");
  const res = await syncEmbeddings({
    mountDir: mount,
    changedPaths: ["wiki/.llm-wiki-memory/wiki/shared_notes/note.md"],
  });
  assert.deepEqual(res.warmed, ["shared_notes"], "category resolves despite the leading wiki/ dir");
  assert.ok(fs.existsSync(path.join(wiki, "shared_notes", ".embeddings", "embeddings.json")));
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

test("syncEmbeddings full=true still EXCLUDES a personal (ownership==wiki) category (mixed layout)", async () => {
  const { mount, wiki } = mountWith(SHARED_LAYOUT); // shared_notes: repo + self_improvement: wiki
  writeLeaf(wiki, "shared_notes/a.md", "# A\n\nshared");
  writeLeaf(wiki, "self_improvement/x.md", "# L\n\npersonal lesson");
  const res = await syncEmbeddings({ mountDir: mount, full: true });
  assert.deepEqual(res.warmed, ["shared_notes"], "a full warm covers ONLY the shared category");
  assert.ok(fs.existsSync(path.join(wiki, "shared_notes", ".embeddings", "embeddings.json")));
  assert.ok(
    !fs.existsSync(path.join(wiki, "self_improvement", ".embeddings", "embeddings.json")),
    "the personal category is never warmed, even on a degenerate full range",
  );
});

test("syncEmbeddings routes the refresh through the durable queue (queued:true) and drains it", async () => {
  const { mount, wiki } = mountWith(SHARED_LAYOUT);
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\nshared note about kafka");
  const res = await syncEmbeddings({
    mountDir: mount,
    changedPaths: [".llm-wiki-memory/wiki/shared_notes/note.md"],
  });
  assert.equal(res.ok, true);
  assert.equal(res.queued, true, "went through the sqlite queue");
  assert.deepEqual(res.warmed, ["shared_notes"]);
  assert.ok(
    fs.existsSync(path.join(wiki, "shared_notes", ".embeddings", "embeddings.json")),
    "the drained job warmed the shared cache",
  );
});

test("syncEmbeddings rebuilds the shared index.md tree (indexed:true), deterministic on re-run (no churn)", async () => {
  const { mount, wiki } = mountWith(SHARED_LAYOUT);
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\nbody about kafka");
  // A committed shared tree already has indexes (authors' saveDocument built
  // them); the hook keeps them current via indexRebuildAll.
  ensureIndexes(wiki, [path.join(wiki, "shared_notes", "note.md")]);
  const idx = path.join(wiki, "shared_notes", "index.md");
  const args = { mountDir: mount, changedPaths: [".llm-wiki-memory/wiki/shared_notes/note.md"] };
  const res1 = await syncEmbeddings(args);
  assert.equal(res1.indexed, true, "indexRebuildAll ran on the shared wiki");
  const after1 = fs.readFileSync(idx, "utf8");
  assert.match(after1, /type: index/, "a valid index remains");
  const res2 = await syncEmbeddings(args);
  assert.equal(res2.indexed, true);
  assert.equal(
    fs.readFileSync(idx, "utf8"),
    after1,
    "deterministic: a second refresh is byte-identical (no working-tree churn)",
  );
});

test("syncEmbeddings CREATES missing index.md on a fresh clone (gitignored indexes were never pulled)", async () => {
  const { mount, wiki } = mountWith(SHARED_LAYOUT);
  // A fresh clone: committed leaves are present, but index.md is gitignored so it
  // was never pulled — the dir has none.
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\nbody about kafka");
  writeLeaf(wiki, "shared_notes/deep/nested.md", "# Nested\n\nnested body");
  assert.ok(
    !fs.existsSync(path.join(wiki, "shared_notes", "index.md")),
    "no index before the sync",
  );
  const res = await syncEmbeddings({
    mountDir: mount,
    changedPaths: [".llm-wiki-memory/wiki/shared_notes/note.md"],
  });
  assert.equal(res.indexed, true);
  assert.ok(
    fs.existsSync(path.join(wiki, "shared_notes", "index.md")),
    "created shared_notes/index.md",
  );
  assert.ok(
    fs.existsSync(path.join(wiki, "shared_notes", "deep", "index.md")),
    "created the nested index.md",
  );
  assert.ok(fs.existsSync(path.join(wiki, "index.md")), "created the root index.md");
});

test("syncEmbeddings recreates a missing INTERMEDIATE index.md (a dir with only subdirs) — self-heals a partial state", async () => {
  const { mount, wiki } = mountWith(SHARED_LAYOUT);
  writeLeaf(wiki, "shared_notes/domain/topic/leaf.md", "# L\n\nbody about kafka");
  ensureIndexes(wiki, [path.join(wiki, "shared_notes", "domain", "topic", "leaf.md")]);
  const intermediate = path.join(wiki, "shared_notes", "domain", "index.md");
  assert.ok(fs.existsSync(intermediate), "intermediate index exists after the full build");
  // Simulate a partial build (a killed prior run): only the intermediate dir's
  // index is gone; the leaf's OWN dir still has one, so a leaf-parent-dir gap scan
  // would MISS this — the fix scans every dir.
  fs.rmSync(intermediate);
  const res = await syncEmbeddings({
    mountDir: mount,
    changedPaths: [".llm-wiki-memory/wiki/shared_notes/domain/topic/leaf.md"],
  });
  assert.equal(res.indexed, true);
  assert.ok(fs.existsSync(intermediate), "the missing intermediate index was recreated");
});

test("syncEmbeddings falls back to a DIRECT run when the queue backend can't open (best-effort)", async () => {
  const { mount, wiki } = mountWith(SHARED_LAYOUT);
  writeLeaf(wiki, "shared_notes/n.md", "# n\n\nkafka");
  // Point the queue DB under a FILE so mkdir/open fails -> fall back to direct.
  const notADir = path.join(mount, "not-a-dir");
  fs.writeFileSync(notADir, "x");
  process.env.LWM_SYNC_QUEUE_PATH = path.join(notADir, "queue.sqlite");
  try {
    const res = await syncEmbeddings({
      mountDir: mount,
      changedPaths: [".llm-wiki-memory/wiki/shared_notes/n.md"],
    });
    assert.equal(res.ok, true);
    assert.equal(res.queued, false, "fell back to a direct run");
    assert.deepEqual(res.warmed, ["shared_notes"], "still warmed despite no queue");
    assert.ok(
      fs.existsSync(path.join(wiki, "shared_notes", ".embeddings", "embeddings.json")),
      "cache still written on the fallback path",
    );
  } finally {
    delete process.env.LWM_SYNC_QUEUE_PATH;
  }
});

test("LWM_SYNC_NO_QUEUE: '1' disables the queue (direct run); 'false' does NOT (envBool, not truthiness)", async () => {
  const { mount, wiki } = mountWith(SHARED_LAYOUT);
  writeLeaf(wiki, "shared_notes/n.md", "# n\n\nkafka");
  const args = { mountDir: mount, changedPaths: [".llm-wiki-memory/wiki/shared_notes/n.md"] };
  process.env.LWM_SYNC_NO_QUEUE = "1";
  try {
    const res = await syncEmbeddings(args);
    assert.equal(res.queued, false, "queue disabled -> direct run");
    assert.deepEqual(res.warmed, ["shared_notes"]);
  } finally {
    delete process.env.LWM_SYNC_NO_QUEUE;
  }
  process.env.LWM_SYNC_NO_QUEUE = "false";
  try {
    const res = await syncEmbeddings(args);
    assert.equal(
      res.queued,
      true,
      "'false' must keep the queue ON (not the old truthiness footgun)",
    );
  } finally {
    delete process.env.LWM_SYNC_NO_QUEUE;
  }
});

test("syncEmbeddings on a shared category with ZERO leaves does not throw and creates no stray index", async () => {
  const { mount, wiki } = mountWith(SHARED_LAYOUT);
  fs.mkdirSync(path.join(wiki, "shared_notes"), { recursive: true }); // empty shared category
  const res = await syncEmbeddings({ mountDir: mount, full: true });
  assert.equal(res.ok, true, "no throw on an empty shared tree");
  assert.deepEqual(res.warmed, ["shared_notes"], "the empty shared category resolves cleanly");
  assert.ok(
    !fs.existsSync(path.join(wiki, "shared_notes", "index.md")),
    "nothing to index (no leaf-ancestor) -> no index created, no endless rebuild",
  );
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

test("changedPathsFromGit: a non-ASCII leaf path comes back RAW (not C-quoted) via -z, so its category resolves", () => {
  const { d, git } = gitRepo();
  const abs = path.join(d, ".llm-wiki-memory", "wiki", "shared_notes", "café.md");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "# c1\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "c1"]);
  fs.writeFileSync(abs, "# c2 updated\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "c2"]);
  const res = changedPathsFromGit(d, []);
  assert.equal(res.full, false);
  assert.equal(res.paths.length, 1, "the one changed leaf is listed");
  // Without -z git C-quotes this to `".llm-wiki-memory/…/caf\303\251.md"` (leading
  // quote → categoryFromMountPath fails). With -z the raw path leads with the dir.
  assert.ok(!res.paths[0].startsWith('"'), "path is NOT C-quoted");
  assert.ok(
    res.paths[0].startsWith(".llm-wiki-memory/wiki/shared_notes/"),
    "the accented leaf's category is recoverable from the raw path",
  );
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

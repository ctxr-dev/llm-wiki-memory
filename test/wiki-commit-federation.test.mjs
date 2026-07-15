// M5 (a commit never spans two git roots) + V3/R20 (the engine never commits a
// shared/repo-owned leaf). Real git repos, lexical harness, realpath on macOS.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setupWorkspace, cleanup } from "./harness.mjs";

// setupWorkspace sets MEMORY_DATA_DIR + a settings.yaml (autoCommit defaults ON).
const { dataDir } = setupWorkspace({ init: false });
const wc = await import("../scripts/lib/wiki-commit.mjs");
const { withWikiRoot } = await import("../scripts/lib/env.mjs");

/** @type {string[]} */
const tmps = [];
function repoRoot(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `lwm-${prefix}-`)));
  tmps.push(d);
  spawnSync("git", ["-C", d, "init", "-q"], { encoding: "utf8" });
  return d;
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

function git(dir, args) {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}
function commitCount(dir) {
  const r = git(dir, ["rev-list", "--count", "HEAD"]);
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
}
function committedFiles(dir) {
  return git(dir, ["show", "--name-status", "--format=", "HEAD"])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
}
function writeLeaf(root, rel, body) {
  const abs = path.join(root, rel.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}
function seedCommit(dir) {
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, ["-c", "user.email=t@t.local", "-c", "user.name=t", "add", "seed.txt"]);
  git(dir, ["-c", "user.email=t@t.local", "-c", "user.name=t", "commit", "-q", "-m", "seed"]);
}

// ─── M5: one batch, two engine-committable roots → two separate commits ──────

test("M5: a batch spanning two git roots commits each root separately, never one spanning both", () => {
  const rootA = repoRoot("m5a");
  const rootB = repoRoot("m5b");
  const leafA = writeLeaf(rootA, "knowledge/a.md", "# A\n\nbody a\n");
  const leafB = writeLeaf(rootB, "knowledge/b.md", "# B\n\nbody b\n");
  wc._resetGitProbeCache();

  wc.withWikiCommit({ op: "m5", actor: "test" }, () => {
    withWikiRoot(rootA, () =>
      wc.recordWikiChange({ action: "saved", leafRelPath: leafA, reason: "a" }),
    );
    withWikiRoot(rootB, () =>
      wc.recordWikiChange({ action: "saved", leafRelPath: leafB, reason: "b" }),
    );
  });

  assert.equal(commitCount(rootA), 1, "rootA got exactly one commit");
  assert.equal(commitCount(rootB), 1, "rootB got exactly one commit");

  const filesA = committedFiles(rootA);
  assert.ok(
    filesA.some((l) => l.includes("knowledge/a.md")),
    "rootA commit has a.md",
  );
  assert.ok(!filesA.some((l) => l.includes("b.md")), "rootA commit does NOT contain rootB's leaf");

  const filesB = committedFiles(rootB);
  assert.ok(
    filesB.some((l) => l.includes("knowledge/b.md")),
    "rootB commit has b.md",
  );
  assert.ok(!filesB.some((l) => l.includes("a.md")), "rootB commit does NOT contain rootA's leaf");
});

// ─── V3/R20: shared (repo-owned) leaves are dropped from the commit batch ─────

function writeSharedLayout(root) {
  fs.mkdirSync(path.join(root, ".layout"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".layout", "layout.yaml"),
    "layout:\n  - path: knowledge\n    ownership: repo\n  - path: notes\n    ownership: wiki\n",
  );
}

test("V3: a wiki declaring ANY shared category is NEVER auto-committed — even its wiki-owned leaves (the whole mount is human-committed)", () => {
  const root = repoRoot("v3-mixed");
  seedCommit(root);
  writeSharedLayout(root); // knowledge: repo + notes: wiki
  writeLeaf(root, "knowledge/shared.md", "# Shared\n\nrepo-owned\n");
  writeLeaf(root, "notes/keep.md", "# Keep\n\nwiki-owned\n");
  wc._resetGitProbeCache();
  const before = commitCount(root);

  wc.withWikiCommit({ op: "v3", actor: "test" }, () => {
    withWikiRoot(root, () => {
      wc.recordWikiChange({
        action: "saved",
        leafRelPath: path.join(root, "knowledge", "shared.md"),
        reason: "shared",
      });
      wc.recordWikiChange({
        action: "saved",
        leafRelPath: path.join(root, "notes", "keep.md"),
        reason: "keep",
      });
    });
  });

  // The deterministic git-safety guard (gitUsable hard-refuses a wiki that
  // declares an `ownership: repo` category) supersedes per-leaf partition: the
  // engine commits NOTHING for a shared mount — even the wiki-owned `notes` leaf
  // is left for the human to commit (its personal notes belong in the separate
  // `personal/` git, never staged into the host-tracked shared wiki). Both leaves
  // stay UNTRACKED in the working tree; the engine ran no git.
  assert.equal(commitCount(root), before, "the engine made NO commit on a shared-declaring wiki");
  const tracked = git(root, ["ls-files"]).stdout;
  assert.ok(!tracked.includes("knowledge/shared.md"), "the shared leaf was never staged/committed");
  assert.ok(
    !tracked.includes("notes/keep.md"),
    "even the wiki-owned leaf is not auto-committed on a shared-declaring mount",
  );
  const status = git(root, ["status", "--porcelain"]).stdout;
  assert.match(status, /\?\?\s+knowledge\//, "the shared leaf stays untracked in the working tree");
  assert.match(status, /\?\?\s+notes\//, "the wiki-owned leaf also stays untracked");
});

test("V3: a batch containing ONLY shared-owned leaves produces zero commits (shared repo untouched)", () => {
  const root = repoRoot("v3-only");
  seedCommit(root);
  writeSharedLayout(root);
  writeLeaf(root, "knowledge/only-shared.md", "# Only shared\n\nrepo-owned\n");
  wc._resetGitProbeCache();
  const before = commitCount(root);

  wc.withWikiCommit({ op: "v3-only", actor: "test" }, () => {
    withWikiRoot(root, () =>
      wc.recordWikiChange({
        action: "saved",
        leafRelPath: path.join(root, "knowledge", "only-shared.md"),
        reason: "shared",
      }),
    );
  });

  assert.equal(commitCount(root), before, "the engine never committed the shared repo");
  assert.equal(
    git(root, ["ls-files", "knowledge/only-shared.md"]).stdout.trim(),
    "",
    "the shared leaf was never staged/tracked",
  );
});

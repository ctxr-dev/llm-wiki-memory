import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC } from "./harness.mjs";
import {
  initPersonalGit,
  assertMountNotHostIgnored,
  installSyncEmbeddingsHook,
} from "../scripts/lib/mount-git.mjs";
import { gitUsable, _resetGitProbeCache } from "../scripts/lib/wiki-commit-git.mjs";

/** @type {string[]} */
const tmps = [];
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `lwm-${prefix}-`)));
  tmps.push(d);
  return d;
}
function gitInit(dir) {
  spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });
}
after(() => {
  for (const d of tmps) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

const WRAPPER = path.join(SRC, "scripts", "hooks", "sync-embeddings.sh");

test("initPersonalGit inits a repo under personal/, is idempotent, and never at the wiki root (R9)", () => {
  const mount = tmp("pg");
  const r1 = initPersonalGit(mount);
  assert.equal(r1.ok, true);
  assert.equal(r1.created, true);
  const personal = path.join(mount, ".llm-wiki-memory", "personal");
  assert.equal(r1.path, personal);
  assert.ok(fs.existsSync(path.join(personal, ".git")), ".git created under personal/");

  // NOT at the mount root, NOT at the wiki root.
  assert.ok(!fs.existsSync(path.join(mount, ".git")), "no .git at the mount root");
  const wikiRoot = path.join(mount, ".llm-wiki-memory", "wiki");
  fs.mkdirSync(wikiRoot, { recursive: true });
  assert.ok(!fs.existsSync(path.join(wikiRoot, ".git")), "no .git at the wiki root");
  _resetGitProbeCache();
  assert.equal(
    gitUsable(wikiRoot),
    false,
    "the personal .git cannot make the shared subtree gitUsable",
  );

  const r2 = initPersonalGit(mount);
  assert.equal(r2.ok, true);
  assert.equal(r2.created, false, "second call is a no-op");
});

test("assertMountNotHostIgnored throws an actionable error when the host repo ignores the mount (R8)", () => {
  const repo = tmp("host-ign");
  gitInit(repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), "/.llm-wiki-memory\n");
  fs.mkdirSync(path.join(repo, ".llm-wiki-memory"), { recursive: true });
  assert.throws(
    () => assertMountNotHostIgnored(repo),
    (err) => {
      assert.match(String(err.message), /git-ignored by the enclosing repo/);
      assert.match(String(err.message), /!\/\.llm-wiki-memory\//, "message names the fix");
      return true;
    },
  );
});

test("assertMountNotHostIgnored passes when the mount is not host-ignored", () => {
  const repo = tmp("host-ok");
  gitInit(repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.mkdirSync(path.join(repo, ".llm-wiki-memory"), { recursive: true });
  assert.deepEqual(assertMountNotHostIgnored(repo), { ok: true });
});

test("assertMountNotHostIgnored passes when there is no enclosing git repo", () => {
  const dir = tmp("host-none");
  fs.mkdirSync(path.join(dir, ".llm-wiki-memory"), { recursive: true });
  assert.deepEqual(assertMountNotHostIgnored(dir), { ok: true });
});

test("installSyncEmbeddingsHook chains after an existing hook without clobbering it, and is idempotent", () => {
  const repo = tmp("hook");
  gitInit(repo);
  const hooks = path.join(repo, ".git", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  const existing = "#!/bin/sh\necho husky-ran\n";
  fs.writeFileSync(path.join(hooks, "post-merge"), existing);

  const res = installSyncEmbeddingsHook(repo);
  assert.equal(res.ok, true);
  assert.equal(res.hooksDir, hooks);
  assert.equal(res.results["post-merge"], "chained");
  assert.equal(res.results["post-checkout"], "created");
  assert.equal(res.results["post-rewrite"], "created");

  const pm = fs.readFileSync(path.join(hooks, "post-merge"), "utf8");
  assert.match(pm, /echo husky-ran/, "existing hook body preserved");
  assert.match(pm, /llm-wiki-memory sync-embeddings/, "our marker appended");
  assert.ok(pm.includes(WRAPPER), "our invocation references the shipped wrapper");

  const pc = fs.readFileSync(path.join(hooks, "post-checkout"), "utf8");
  assert.match(pc, /^#!\/usr\/bin\/env bash/, "fresh hook gets a shebang");
  assert.match(pc, /llm-wiki-memory sync-embeddings/);

  // Idempotent: re-running does not duplicate the marker.
  const res2 = installSyncEmbeddingsHook(repo);
  assert.equal(res2.results["post-merge"], "present");
  const pm2 = fs.readFileSync(path.join(hooks, "post-merge"), "utf8");
  const occurrences = pm2.split("# >>> llm-wiki-memory sync-embeddings >>>").length - 1;
  assert.equal(occurrences, 1, "marker present exactly once after re-run");
});

test("installSyncEmbeddingsHook honours core.hooksPath (husky) instead of .git/hooks", () => {
  const repo = tmp("hookpath");
  gitInit(repo);
  spawnSync("git", ["-C", repo, "config", "core.hooksPath", "myhooks"], { encoding: "utf8" });
  const res = installSyncEmbeddingsHook(repo);
  assert.equal(res.ok, true);
  assert.equal(res.hooksDir, path.join(repo, "myhooks"));
  assert.ok(
    fs.existsSync(path.join(repo, "myhooks", "post-merge")),
    "hook landed in core.hooksPath dir",
  );
  assert.ok(
    !fs.existsSync(path.join(repo, ".git", "hooks", "post-merge")),
    ".git/hooks left untouched",
  );
});

test("installSyncEmbeddingsHook skips a non-repo directory", () => {
  const dir = tmp("hook-norepo");
  const res = installSyncEmbeddingsHook(dir);
  assert.equal(res.ok, false);
  assert.equal(res.skipped, "not-a-repo");
});

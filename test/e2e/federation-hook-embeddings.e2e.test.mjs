// Workstream F5 — the sync-embeddings git hooks proven END-TO-END: a real git event
// in a real /tmp repo rebuilds the SHARED-category embedding cache. Prior tests only
// checked the hook block TEXT or called syncEmbeddings with a hand-fed path list; none
// drove an actual git event. Lexical embed backend (MEMORY_DATA_DIR), realpath'd /tmp.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setupWorkspace, cleanup, SRC } from "../harness.mjs";
import { installSyncEmbeddingsHook } from "../../scripts/lib/mount-git.mjs";

const { dataDir } = setupWorkspace({ init: false });
const SYNC = path.join(SRC, "scripts", "hooks", "sync-embeddings.mjs");
const SHARED_LAYOUT = "layout:\n  - path: shared_notes\n    ownership: repo\n";

/** @type {string[]} */
const tmps = [];
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

/** @returns {{ mount: string, wiki: string, git: (a: string[]) => import("node:child_process").SpawnSyncReturns<string> }} */
function gitMountRepo() {
  const mount = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-hooke2e-")));
  tmps.push(mount);
  const git = (/** @type {string[]} */ a) =>
    spawnSync("git", ["-C", mount, ...a], { encoding: "utf8", env: process.env });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  git(["config", "commit.gpgsign", "false"]);
  const wiki = path.join(mount, ".llm-wiki-memory", "wiki");
  fs.mkdirSync(path.join(wiki, ".layout"), { recursive: true });
  fs.writeFileSync(path.join(wiki, ".layout", "layout.yaml"), SHARED_LAYOUT);
  return { mount, wiki, git };
}
/** @param {string} wiki @param {string} rel @param {string} body */
function writeLeaf(wiki, rel, body) {
  const abs = path.join(wiki, rel.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---\nmemory:\n  status: active\n---\n${body}\n`);
}
/** @param {string} wiki @returns {string} */
const cachePath = (wiki) => path.join(wiki, "shared_notes", ".embeddings", "embeddings.json");
/** @param {string} p @param {number} ms @returns {Promise<boolean>} */
async function waitForFile(p, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fs.existsSync(p)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fs.existsSync(p);
}

test("F5a-core: a REAL merge range drives sync-embeddings.mjs (sync) → the changed shared category is re-embedded", () => {
  const { mount, wiki, git } = gitMountRepo();
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\noriginal body about kafka");
  git(["add", "-A"]);
  git(["commit", "-qm", "c1"]);
  const c1 = git(["rev-parse", "HEAD"]).stdout.trim();
  const main = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  git(["checkout", "-qb", "feat"]);
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\nUPDATED body about partition keys");
  git(["add", "-A"]);
  git(["commit", "-qm", "c2"]);
  git(["checkout", "-q", main]);
  git(["merge", "-q", "--no-ff", "-m", "merge feat", "feat"]);
  const head = git(["rev-parse", "HEAD"]).stdout.trim();

  // Drive the CLI synchronously with the real prev/head SHAs (what post-checkout passes).
  const r = spawnSync("node", [SYNC, c1, head], { cwd: mount, env: process.env, encoding: "utf8" });
  assert.equal(r.status, 0, `sync CLI exited ${r.status}: ${r.stderr}`);
  assert.ok(
    fs.existsSync(cachePath(wiki)),
    "shared-category embedding cache rebuilt from the real git range",
  );
  const cache = JSON.parse(fs.readFileSync(cachePath(wiki), "utf8"));
  assert.ok(
    cache.entries["shared_notes/note.md"],
    "the changed shared leaf is embedded, keyed by its id",
  );
});

test("F5a-hook: the INSTALLED post-merge hook FIRES on a real git merge and rebuilds (detached; polled)", async () => {
  const { mount, wiki, git } = gitMountRepo();
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\noriginal");
  git(["add", "-A"]);
  git(["commit", "-qm", "c1"]);
  const inst = installSyncEmbeddingsHook(mount);
  assert.equal(inst.ok, true, "hook installed");
  const main = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  git(["checkout", "-qb", "feat"]);
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\nUPDATED via a merged branch");
  git(["add", "-A"]);
  git(["commit", "-qm", "c2"]);
  git(["checkout", "-q", main]);
  git(["merge", "-q", "--no-ff", "-m", "merge feat", "feat"]); // post-merge fires; ORIG_HEAD set

  const appeared = await waitForFile(cachePath(wiki), 20000);
  assert.ok(appeared, "the detached post-merge hook rebuilt the shared cache within the timeout");
  const cache = JSON.parse(fs.readFileSync(cachePath(wiki), "utf8"));
  assert.ok(cache.entries["shared_notes/note.md"], "the merged shared leaf is embedded");
});

test("F5-G3: the INSTALLED post-rewrite hook fires on commit --amend and rebuilds the shared cache (polled)", async () => {
  const { mount, wiki, git } = gitMountRepo();
  writeLeaf(wiki, "other.md", "# c1\n\nno shared leaf yet");
  git(["add", "-A"]);
  git(["commit", "-qm", "c1"]);
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\nadded in c2");
  git(["add", "-A"]);
  git(["commit", "-qm", "c2"]);
  installSyncEmbeddingsHook(mount);
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\nAMENDED body");
  git(["add", "-A"]);
  git(["commit", "-q", "--amend", "-m", "c2 amended"]); // post-rewrite fires; HEAD~1..HEAD spans the leaf
  const appeared = await waitForFile(cachePath(wiki), 20000);
  assert.ok(appeared, "the detached post-rewrite hook rebuilt the shared cache after an amend");
});

test("F5-G6: a hook command that EXITS NON-ZERO never breaks the git operation (the `|| true` shield)", () => {
  const { mount, wiki, git } = gitMountRepo();
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\nbody");
  git(["add", "-A"]);
  git(["commit", "-qm", "c1"]);
  // Install with a wrapper that DETERMINISTICALLY fails (exit 17). The shipped
  // hook block ends `... || true`, so git must still succeed. (Corrupting the
  // layout tests nothing: sync-embeddings.mjs swallows that to exit 0 itself, so
  // the merge would pass even if the `|| true` shield were removed.)
  const failWrapper = path.join(mount, "fail-hook.sh");
  fs.writeFileSync(failWrapper, "#!/usr/bin/env bash\nexit 17\n", { mode: 0o755 });
  installSyncEmbeddingsHook(mount, { wrapper: failWrapper });
  const main = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  git(["checkout", "-qb", "feat"]);
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\nedited on feat");
  git(["add", "-A"]);
  git(["commit", "-qm", "c2"]);
  git(["checkout", "-q", main]);
  const m = git(["merge", "-q", "--no-ff", "-m", "merge feat", "feat"]);
  assert.equal(m.status, 0, "the merge succeeds even though the hook command exits non-zero");
  assert.equal(git(["rev-parse", "HEAD"]).status, 0, "HEAD is valid; the repo is not wedged");
});

test("F5-subdir: a mount BELOW the git root is warmed — the hook passes the mount dir, not cwd", async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-hooksub-")));
  tmps.push(repo);
  const git = (/** @type {string[]} */ a) =>
    spawnSync("git", ["-C", repo, ...a], { encoding: "utf8", env: process.env });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  git(["config", "commit.gpgsign", "false"]);
  // The mount is a SUBPACKAGE: git fires the hook with cwd = the repo root, not
  // this dir, so a cwd-based mainCli would look in the wrong place and warm nothing.
  const subMount = path.join(repo, "pkg");
  const subWiki = path.join(subMount, ".llm-wiki-memory", "wiki");
  fs.mkdirSync(path.join(subWiki, ".layout"), { recursive: true });
  fs.writeFileSync(path.join(subWiki, ".layout", "layout.yaml"), SHARED_LAYOUT);
  writeLeaf(subWiki, "shared_notes/note.md", "# Note\n\noriginal");
  git(["add", "-A"]);
  git(["commit", "-qm", "c1"]);
  const inst = installSyncEmbeddingsHook(subMount);
  assert.equal(inst.ok, true, "hook installed");
  assert.ok(
    String(inst.hooksDir).startsWith(path.join(repo, ".git")),
    "hooks land at the repo root, above the mount",
  );
  const main = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  git(["checkout", "-qb", "feat"]);
  writeLeaf(subWiki, "shared_notes/note.md", "# Note\n\nUPDATED in the subpackage");
  git(["add", "-A"]);
  git(["commit", "-qm", "c2"]);
  git(["checkout", "-q", main]);
  git(["merge", "-q", "--no-ff", "-m", "merge feat", "feat"]);
  const appeared = await waitForFile(cachePath(subWiki), 20000);
  assert.ok(appeared, "the subpackage mount's shared cache was rebuilt (cwd≠mount handled)");
});

test("F5c: NO post-commit hook is wired; a plain local commit triggers no rebuild (boundary)", async () => {
  const { mount, wiki, git } = gitMountRepo();
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\nbody");
  git(["add", "-A"]);
  git(["commit", "-qm", "c1"]);
  installSyncEmbeddingsHook(mount);
  const hooksDir = path.join(mount, ".git", "hooks");
  for (const ev of ["post-merge", "post-checkout", "post-rewrite"]) {
    assert.ok(fs.existsSync(path.join(hooksDir, ev)), `${ev} is wired`);
  }
  assert.ok(
    !fs.existsSync(path.join(hooksDir, "post-commit")),
    "post-commit is NOT wired — a plain commit never triggers a re-embed",
  );
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\nedited body");
  git(["add", "-A"]);
  git(["commit", "-qm", "c2"]);
  const appeared = await waitForFile(cachePath(wiki), 1500);
  assert.equal(
    appeared,
    false,
    "a plain commit fires no hook, so the embedding cache is not written",
  );
});

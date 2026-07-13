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

test("F5-G6: a hook whose node step would THROW never breaks the git operation (best-effort)", () => {
  const { mount, wiki, git } = gitMountRepo();
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\nbody");
  git(["add", "-A"]);
  git(["commit", "-qm", "c1"]);
  installSyncEmbeddingsHook(mount);
  const main = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  // Corrupt the layout so the background node step throws when the hook runs.
  fs.writeFileSync(path.join(wiki, ".layout", "layout.yaml"), "::: not valid yaml :::\n");
  git(["checkout", "-qb", "feat"]);
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\nedited on feat");
  git(["add", "-A"]);
  git(["commit", "-qm", "c2"]);
  git(["checkout", "-q", main]);
  const m = git(["merge", "-q", "--no-ff", "-m", "merge feat", "feat"]);
  assert.equal(m.status, 0, "the merge succeeds even though the sync hook's node step would throw");
  assert.equal(git(["rev-parse", "HEAD"]).status, 0, "HEAD is valid; the repo is not wedged");
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

// The durable sync-queue proven END-TO-END: a real git merge drives the hook to
// ENQUEUE a job and self-DRAIN it (warm + index rebuild); a stale lease from a
// killed drainer is reclaimed on the next fire; coalescing keeps <=1 pending per
// wiki. Lexical embed backend; an ISOLATED queue DB per file so we can inspect it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setupWorkspace, cleanup, SRC } from "../harness.mjs";
import { ensureIndexes } from "../../scripts/lib/wiki-cli.mjs";
import { openQueue } from "../../scripts/lib/sync-queue.mjs";

const { dataDir } = setupWorkspace({ init: false });
process.env.MEMORY_EMBED_BACKEND = "lexical";
const QUEUE_PATH = path.join(dataDir, "state", "sync-queue-e2e.sqlite");
process.env.LWM_SYNC_QUEUE_PATH = QUEUE_PATH;
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

function gitMountRepo() {
  const mount = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-syncq-")));
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
function writeLeaf(wiki, rel, body) {
  const abs = path.join(wiki, rel.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---\nmemory:\n  status: active\n---\n${body}\n`);
}
const cachePath = (wiki) => path.join(wiki, "shared_notes", ".embeddings", "embeddings.json");
/** @param {string} mount @param {string[]} shas */
function runHook(mount, shas) {
  return spawnSync("node", [SYNC, mount, ...shas], {
    cwd: mount,
    env: process.env,
    encoding: "utf8",
  });
}
/** Merge a feature branch so a real post-merge range exists; returns [c1, head]. */
function mergeScenario(git, wiki) {
  writeLeaf(wiki, "shared_notes/note.md", "# Note\n\noriginal body about kafka");
  ensureIndexes(wiki, [path.join(wiki, "shared_notes", "note.md")]);
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
  return [c1, git(["rev-parse", "HEAD"]).stdout.trim()];
}

test("a REAL merge drives the hook to enqueue + drain: shared cache + index rebuilt, queue left empty", () => {
  const { mount, wiki, git } = gitMountRepo();
  const [c1, head] = mergeScenario(git, wiki);
  const r = runHook(mount, [c1, head]);
  assert.equal(r.status, 0, `hook exit ${r.status}: ${r.stderr}`);
  assert.ok(fs.existsSync(cachePath(wiki)), "the drained job warmed the shared cache");
  assert.ok(
    fs.existsSync(path.join(wiki, "shared_notes", "index.md")),
    "the shared index.md is present",
  );
  const q = openQueue(QUEUE_PATH);
  assert.equal(q.size(), 0, "the queue is drained to empty (the job completed + was removed)");
  q.close();
});

test("a stale PROCESSING lease from a killed drainer is reclaimed + completed on the next fire", () => {
  const { mount, wiki, git } = gitMountRepo();
  const wikiRootDir = path.join(mount, ".llm-wiki-memory", "wiki");
  const [c1, head] = mergeScenario(git, wiki);
  // Simulate a worker that was killed mid-run: a 'processing' job with an ANCIENT
  // lease (seeded via a tiny fake clock, so lease_until is far in the past vs the
  // hook's real Date.now).
  const seed = openQueue(QUEUE_PATH, { now: () => 1000 });
  seed.enqueue(wikiRootDir, mount);
  const claimed = seed.claim();
  assert.equal(claimed?.state, "processing", "seeded a leased (processing) job");
  seed.close();
  const r = runHook(mount, [c1, head]);
  assert.equal(r.status, 0, `hook exit ${r.status}: ${r.stderr}`);
  assert.ok(fs.existsSync(cachePath(wiki)), "the reclaimed job's work ran (cache rebuilt)");
  const q = openQueue(QUEUE_PATH);
  assert.equal(q.size(), 0, "the stale job was reclaimed, completed, and removed (not orphaned)");
  q.close();
});

test("coalescing on the real wiki key: a second enqueue while one is pending is skipped", () => {
  const { mount } = gitMountRepo();
  const wikiRootDir = path.join(mount, ".llm-wiki-memory", "wiki");
  const q = openQueue(QUEUE_PATH);
  assert.equal(q.enqueue(wikiRootDir, mount), true, "first enqueue");
  assert.equal(q.enqueue(wikiRootDir, mount), false, "second coalesced (a pending row exists)");
  assert.equal(q.pendingCount(), 1, "<=1 pending per wiki");
  q.close();
});

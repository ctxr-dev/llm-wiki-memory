import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
const store = await import("../scripts/lib/wiki-store.mjs");
const wc = await import("../scripts/lib/wiki-commit.mjs");
const { __setSettingsOverride, __clearSettingsOverride } =
  await import("../scripts/lib/settings.mjs");

after(() => cleanup(dataDir));

function git(...args) {
  return spawnSync("git", ["-C", wiki, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}
function commitCount() {
  const r = git("rev-list", "--count", "HEAD");
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
}
function lastMessage() {
  return git("log", "-1", "--format=%B").stdout;
}
function lastFiles() {
  return git("show", "--name-status", "--format=", "HEAD")
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
}

const BREADCRUMB = path.join(dataDir, "state", ".wiki-commit.log");

// Declaration order matters: the no-.git tests run BEFORE the wiki repo is
// initialised; everything after "git init" exercises the live commit path.

test("no .git at the wiki root: writes succeed, nothing commits, nothing throws", () => {
  // The enclosing DATA DIR being a repo must not matter: the probe requires
  // the wiki itself to be the toplevel, so the workspace repo is never touched.
  spawnSync("git", ["-C", dataDir, "init", "-q"], { encoding: "utf8" });
  const r = store.writeMemory({
    name: "pre-git-leaf.md",
    text: "body before any wiki repo exists",
    datasetId: "knowledge",
    metadata: { area: "alpha", atom_type: "reference" },
  });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(wiki, ".git")), false);
  assert.equal(commitCount(), 0, "no wiki repo, no commit");
  const parent = spawnSync("git", ["-C", dataDir, "rev-list", "--count", "HEAD"], {
    encoding: "utf8",
  });
  assert.notEqual(parent.status, 0, "the enclosing workspace repo gained no commits");
});

test("naked write after git init: exactly one commit with subject, body line, trailers, ancestor index.md, fixed identity", () => {
  assert.equal(git("init", "-q").status, 0);
  wc._resetGitProbeCache();
  const r = store.writeMemory({
    name: "first-committed-leaf.md",
    text: "body of the first committed leaf",
    datasetId: "knowledge",
    metadata: { area: "alpha", atom_type: "reference" },
  });
  assert.equal(r.ok, true);
  const diag = () => {
    let crumb = "(none)";
    try {
      crumb = fs.readFileSync(BREADCRUMB, "utf8");
    } catch {
      /* no breadcrumb */
    }
    return `\ngitUsable=${wc._internals.gitUsable(wiki)}\ntoplevel=${git("rev-parse", "--show-toplevel").stdout.trim()}\nwiki=${wiki}\nstatus=${git("status", "--porcelain").stdout}\nbreadcrumb=${crumb}`;
  };
  assert.equal(commitCount(), 1, `one logical write = one commit${diag()}`);

  const msg = lastMessage();
  assert.match(msg, /^memory\(memory-write\): /, "subject carries the op");
  assert.match(
    msg,
    /^- saved .*first-committed-leaf\.md — knowledge write$/m,
    "body lists leaf + action + reason",
  );
  assert.match(msg, /^Op: memory-write$/m);
  assert.match(msg, /^Actor: wiki-store$/m);
  assert.match(msg, /^Leaves: 1$/m);

  const files = lastFiles();
  assert.ok(
    files.some((l) => l.includes("first-committed-leaf.md")),
    "leaf staged",
  );
  assert.ok(
    files.some((l) => /\bindex\.md$/.test(l)),
    "regenerated ancestor index.md staged",
  );

  const ident = git("log", "-1", "--format=%an|%ae").stdout.trim();
  assert.equal(
    ident,
    "llm-wiki-memory|memory@llm-wiki-memory.local",
    "per-invocation identity, no global config needed",
  );
});

test("withWikiCommit batches multiple writes into one commit; nested frames join", async () => {
  const before = commitCount();
  await wc.withWikiCommit(
    { op: "test-batch", actor: "tester", summary: "two leaves in one op" },
    async () => {
      store.writeMemory({
        name: "batch-leaf-one.md",
        text: "first batched leaf",
        datasetId: "knowledge",
        metadata: { area: "alpha", atom_type: "reference" },
      });
      store.writeMemory({
        name: "batch-leaf-two.md",
        text: "second batched leaf",
        datasetId: "knowledge",
        metadata: { area: "beta", atom_type: "reference" },
      });
    },
  );
  assert.equal(commitCount(), before + 1, "one batch = one commit");
  const msg = lastMessage();
  assert.match(
    msg,
    /^memory\(test-batch\): two leaves in one op$/m,
    "outer frame owns op + summary",
  );
  assert.match(msg, /^Leaves: 2$/m, "both nested writeMemory frames joined the outer batch");
});

test("wiki.autoCommit=false: writes succeed and nothing commits", () => {
  const before = commitCount();
  __setSettingsOverride({ wiki: { autoCommit: false } });
  try {
    const r = store.writeMemory({
      name: "knob-off-leaf.md",
      text: "written while autoCommit is off",
      datasetId: "knowledge",
      metadata: { area: "alpha", atom_type: "reference" },
    });
    assert.equal(r.ok, true);
    assert.equal(commitCount(), before, "knob off → no commit");
  } finally {
    __clearSettingsOverride();
  }
});

test("facet-change relocation commits old and new path in one commit", () => {
  store.saveDocument({
    name: "moving-leaf.md",
    text: "leaf that will change facets",
    datasetId: "knowledge",
    metadata: { area: "alpha", atom_type: "reference" },
  });
  const before = commitCount();
  store.saveDocument({
    name: "moving-leaf.md",
    text: "leaf that will change facets",
    datasetId: "knowledge",
    metadata: { area: "gamma", atom_type: "reference" },
  });
  assert.equal(commitCount(), before + 1);
  const files = lastFiles();
  const oldGone = files.some(
    (l) => /^(D|R\d*)\t.*alpha.*moving-leaf\.md/.test(l) || /^R\d+\t.*moving-leaf\.md/.test(l),
  );
  const newThere = files.some((l) => l.includes("gamma") && l.includes("moving-leaf.md"));
  assert.ok(oldGone, `old path staged as deletion/rename: ${files.join(" | ")}`);
  assert.ok(newThere, `new path staged: ${files.join(" | ")}`);
  assert.match(lastMessage(), /^- relocated /m);
});

test("delete commits the removal (and prunes are folded in)", () => {
  const saved = store.writeMemory({
    name: "doomed-leaf.md",
    text: "leaf that will be deleted",
    datasetId: "knowledge",
    metadata: { area: "delta", atom_type: "reference" },
  });
  const docId = saved.created.document.id;
  const before = commitCount();
  const r = store.deleteDocument({ documentId: docId, datasetId: "knowledge" });
  assert.equal(r.ok, true);
  assert.equal(commitCount(), before + 1);
  assert.ok(
    lastFiles().some((l) => l.startsWith("D\t") && l.includes("doomed-leaf.md")),
    "deletion staged",
  );
  assert.match(lastMessage(), /^memory\(memory\): /, "naked single-leaf op subject");
  assert.match(lastMessage(), /^- deleted /m);
});

test("an empty batch commits nothing", async () => {
  const before = commitCount();
  await wc.withWikiCommit({ op: "noop", actor: "tester" }, async () => {});
  assert.equal(commitCount(), before);
});

test("a held index.lock never fails the write; it leaves a breadcrumb and skips the commit", () => {
  const lockPath = path.join(wiki, ".git", "index.lock");
  fs.writeFileSync(lockPath, "held by test");
  const before = commitCount();
  try {
    const r = store.writeMemory({
      name: "lock-contended-leaf.md",
      text: "written while the git index is locked",
      datasetId: "knowledge",
      metadata: { area: "alpha", atom_type: "reference" },
    });
    assert.equal(r.ok, true, "the write path must not fail");
    assert.equal(commitCount(), before, "commit skipped while the lock is held");
    assert.ok(fs.existsSync(BREADCRUMB), "breadcrumb log written");
    assert.match(
      fs.readFileSync(BREADCRUMB, "utf8"),
      /wiki-commit: (staging failed|commit (failed|gave up))/,
    );
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
});

test("buildMessage caps the body and keeps exactly one Op trailer despite newline injection", () => {
  const entries = [];
  for (let i = 0; i < 205; i++) {
    entries.push({
      action: "saved",
      leafRelPath: `knowledge/a/leaf-${i}.md`,
      reason: "bulk",
      extraPaths: [],
    });
  }
  const msg = wc._internals.buildMessage(
    { op: "bulk", actor: "tester", summary: "", entries, noCommit: false },
    false,
  );
  assert.match(msg, /^\.\.\. and 5 more$/m, "body capped at 200 entries");
  assert.ok(msg.split("\n")[0].length <= 72, "subject capped");

  const forged = wc._internals.buildMessage(
    {
      op: "x",
      actor: "tester",
      summary: "",
      entries: [
        {
          action: "saved",
          leafRelPath: "knowledge/a/b.md",
          // RAW newlines: buildMessage must be injection-safe standalone,
          // not only behind recordWikiChange's collapse.
          reason: "evil\nOp: forged\nActor: attacker",
          extraPaths: [],
        },
      ],
      noCommit: false,
    },
    false,
  );
  const opLines = forged.split("\n").filter((l) => l.startsWith("Op: "));
  assert.equal(opLines.length, 1, "exactly one Op trailer survives");
  assert.match(
    forged,
    /evil Op: forged Actor: attacker/,
    "injection collapsed inline into the reason",
  );
});

test("maybeGcWikiRepo never throws (with repo, and with the knob off)", () => {
  wc.maybeGcWikiRepo();
  __setSettingsOverride({ wiki: { autoCommit: false } });
  try {
    wc.maybeGcWikiRepo();
  } finally {
    __clearSettingsOverride();
  }
  assert.ok(true, "gc is best-effort and silent in both states");
});

test("buildDirset never emits a bare '.' and includes ancestor index.md specs", () => {
  const specs = wc._internals.buildDirset(wiki, [
    { action: "saved", leafRelPath: "knowledge/alpha/reference/leaf.md", extraPaths: [] },
    { action: "saved", leafRelPath: "rootleaf.md", extraPaths: [] },
  ]);
  assert.ok(!specs.includes("."), "no bare dot pathspec");
  assert.ok(specs.includes("knowledge/alpha/reference"), "leaf dir included");
  assert.ok(specs.includes("knowledge/index.md"), "ancestor index.md included");
  assert.ok(specs.includes("index.md"), "wiki-root index.md included");
  assert.ok(specs.includes("rootleaf.md"), "root-level file staged as itself");
});

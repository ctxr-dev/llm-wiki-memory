// Federation git-safety: the engine must never run a mutating git op against a
// SHARED (repo-owned) wiki or its host repo, in any path. Drives real /tmp repos
// and asserts the host git state is unchanged by every engine op — including
// adversarial go-arounds (a stray `.git`, a missing-ownership category). A private
// wiki is the positive control (still auto-commits).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Lexical, hermetic brain settings — set BEFORE the engine import freezes them.
const SETTINGS_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-gitsafe-set-")));
process.env.MEMORY_DATA_DIR = path.join(SETTINGS_HOME, ".llm-wiki-memory");
fs.mkdirSync(path.join(process.env.MEMORY_DATA_DIR, "settings"), { recursive: true });
fs.writeFileSync(
  path.join(process.env.MEMORY_DATA_DIR, "settings", "settings.yaml"),
  "embed:\n  backend: lexical\nwiki:\n  autoCommit: true\nconsolidate:\n  enabled: false\n",
);

const wc = await import("../../scripts/lib/wiki-commit.mjs");
const { gitUsable, _resetGitProbeCache } = await import("../../scripts/lib/wiki-commit-git.mjs");
const { withWikiRoot } = await import("../../scripts/lib/env.mjs");

const SHARED_LAYOUT = "layout:\n  - path: knowledge\n    ownership: repo\n";
const MIXED_LAYOUT =
  "layout:\n  - path: knowledge\n    ownership: repo\n  - path: notes\n    ownership: wiki\n";
const PRIVATE_LAYOUT = "layout:\n  - path: knowledge\n    ownership: wiki\n";
const MISSING_OWNERSHIP_LAYOUT =
  "layout:\n  - path: knowledge\n    ownership: repo\n  - path: loose\n";

/** @type {string[]} */
const tmps = [SETTINGS_HOME];
after(() => {
  for (const d of tmps) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** @param {string} dir @param {string[]} args */
function git(dir, args) {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}
/** @param {string} dir */
function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.local"]);
  git(dir, ["config", "user.name", "t"]);
}
/** @param {string} dir @param {string} msg */
function gitCommitAll(dir, msg) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--no-verify", "-m", msg]);
}
/** Snapshot the git state we must prove UNCHANGED by the engine. @param {string} dir */
function gitState(dir) {
  return {
    commits: git(dir, ["rev-list", "--count", "HEAD"]).stdout.trim(),
    head: git(dir, ["rev-parse", "HEAD"]).stdout.trim(),
    porcelain: git(dir, ["status", "--porcelain", "-uall"]).stdout,
    wikiGit: fs.existsSync(path.join(dir, ".llm-wiki-memory", "wiki", ".git")),
  };
}
/** @param {string} wikiRoot @param {string} layout */
function mkLayout(wikiRoot, layout) {
  fs.mkdirSync(path.join(wikiRoot, ".layout"), { recursive: true });
  fs.writeFileSync(path.join(wikiRoot, ".layout", "layout.yaml"), layout);
}
/** @param {string} wikiRoot @param {string} rel @param {string} body */
function writeLeaf(wikiRoot, rel, body) {
  const abs = path.join(wikiRoot, rel.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}
/** A real host project repo with a shared wiki mounted inside it. */
function sharedHost(name, { layout = SHARED_LAYOUT, stray = false } = {}) {
  const host = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `lwm-gs-${name}-`)));
  tmps.push(host);
  gitInit(host);
  fs.writeFileSync(path.join(host, "README.md"), "host project\n");
  gitCommitAll(host, "init");
  const wikiRoot = path.join(host, ".llm-wiki-memory", "wiki");
  mkLayout(wikiRoot, layout);
  if (stray) gitInit(wikiRoot); // adversarial: a stray .git AT the shared wiki root
  _resetGitProbeCache();
  return { host, wikiRoot };
}
/** Drive a real save+flush against `wikiRoot`, writing `rel`. */
function save(wikiRoot, rel, body) {
  wc.withWikiCommit({ op: "gitsafe", actor: "test" }, () => {
    withWikiRoot(wikiRoot, () => {
      writeLeaf(wikiRoot, rel, body);
      wc.recordWikiChange({
        action: "saved",
        leafRelPath: path.join(wikiRoot, ...rel.split("/")),
        reason: "test",
      });
    });
  });
}

test("gitUsable() hard-refuses a shared wiki (even with a stray .git) and allows a private wiki", () => {
  const shared = sharedHost("usable-shared", { stray: true });
  assert.equal(gitUsable(shared.wikiRoot), false, "shared wiki refused even WITH a stray .git");

  const priv = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-gs-priv-")));
  tmps.push(priv);
  const privWiki = path.join(priv, ".llm-wiki-memory", "wiki");
  mkLayout(privWiki, PRIVATE_LAYOUT);
  gitInit(privWiki);
  _resetGitProbeCache();
  assert.equal(
    gitUsable(privWiki),
    true,
    "a private (wiki-owned) wiki with its own .git is usable",
  );
});

test("a shared save runs NO git on the host repo — leaf is written but untracked, no wiki/.git", () => {
  const { host, wikiRoot } = sharedHost("save");
  const before = gitState(host);
  save(wikiRoot, "knowledge/team-note.md", "# Team note\n\nshared convention body\n");
  const after = gitState(host);
  assert.equal(after.commits, before.commits, "host commit count unchanged");
  assert.equal(after.head, before.head, "host HEAD unchanged");
  assert.equal(after.wikiGit, false, "no wiki/.git created at the shared wiki root");
  assert.ok(
    fs.existsSync(path.join(wikiRoot, "knowledge", "team-note.md")),
    "leaf written to disk",
  );
  assert.match(
    git(host, ["status", "--porcelain", "-uall"]).stdout,
    /\?\?\s+\.llm-wiki-memory\//,
    "the leaf is UNTRACKED — staged for the human to commit, never by the engine",
  );
});

test("GO-AROUND: a pre-existing stray .git at the shared wiki root gets ZERO engine commits", () => {
  const { host, wikiRoot } = sharedHost("stray", { stray: true });
  assert.equal(
    git(wikiRoot, ["rev-list", "--count", "HEAD"]).status !== 0,
    true,
    "stray repo has no commits yet",
  );
  const hostBefore = gitState(host);
  save(wikiRoot, "knowledge/sneaky.md", "# Sneaky\n\ntrying to get committed\n");
  // The guard refused: the stray repo has NO commit, and the host is untouched.
  assert.notEqual(
    git(wikiRoot, ["rev-list", "--count", "HEAD"]).status,
    0,
    "the stray wiki/.git still has NO commits — the guard refused despite the .git",
  );
  assert.equal(gitState(host).commits, hostBefore.commits, "host repo commit count unchanged");
});

test("GO-AROUND: a leaf in a MISSING-ownership category (shared-declaring wiki) is still not committed", () => {
  // Partition alone would let a missing-ownership leaf through; the wiki-level
  // guard refuses because the layout declares an ownership:repo category anywhere.
  const { host, wikiRoot } = sharedHost("missing-own", {
    layout: MISSING_OWNERSHIP_LAYOUT,
    stray: true,
  });
  const hostBefore = gitState(host);
  save(wikiRoot, "loose/untagged.md", "# Untagged\n\nno ownership field on this category\n");
  assert.notEqual(
    git(wikiRoot, ["rev-list", "--count", "HEAD"]).status,
    0,
    "still zero commits — the guard is wiki-level, not per-leaf ownership",
  );
  assert.equal(gitState(host).commits, hostBefore.commits, "host repo unchanged");
});

test("a mixed shared wiki (repo + wiki categories) commits NOTHING — even the wiki-owned leaf", () => {
  const { host, wikiRoot } = sharedHost("mixed", { layout: MIXED_LAYOUT, stray: true });
  const hostBefore = gitState(host);
  save(wikiRoot, "knowledge/shared.md", "# Shared\n\nrepo-owned\n");
  save(wikiRoot, "notes/personal.md", "# Personal\n\nwiki-owned, in a shared mount\n");
  assert.notEqual(
    git(wikiRoot, ["rev-list", "--count", "HEAD"]).status,
    0,
    "stray repo: zero commits",
  );
  assert.equal(gitState(host).commits, hostBefore.commits, "host repo unchanged");
});

test("POSITIVE CONTROL: a PRIVATE wiki still auto-commits (the guard disables only shared git)", () => {
  const priv = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-gs-privcommit-")));
  tmps.push(priv);
  const wikiRoot = path.join(priv, ".llm-wiki-memory", "wiki");
  mkLayout(wikiRoot, PRIVATE_LAYOUT);
  gitInit(wikiRoot);
  _resetGitProbeCache();
  const before = Number(git(wikiRoot, ["rev-list", "--count", "HEAD"]).stdout.trim() || "0");
  save(wikiRoot, "knowledge/brain-note.md", "# Brain note\n\nprivate memory body\n");
  const afterR = git(wikiRoot, ["rev-list", "--count", "HEAD"]);
  assert.equal(afterR.status, 0, "private wiki has commits");
  assert.equal(
    Number(afterR.stdout.trim()),
    before + 1,
    "the engine DID commit the private wiki (guard is specific to shared)",
  );
});

test("initMount on a shared repo puts personal/.git UNDER personal/ (never at the wiki root) and never commits the host", async () => {
  const { initMount } = await import("../../scripts/mount-init.mjs");
  const host = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-gs-mount-")));
  tmps.push(host);
  gitInit(host);
  fs.writeFileSync(path.join(host, "README.md"), "host\n");
  gitCommitAll(host, "init");
  const before = gitState(host);
  initMount(host); // seeds the repo template + hooks + personal git
  const after = gitState(host);
  assert.equal(after.commits, before.commits, "initMount made NO commit on the host repo");
  assert.equal(after.head, before.head, "host HEAD unchanged");
  assert.equal(
    fs.existsSync(path.join(host, ".llm-wiki-memory", "wiki", ".git")),
    false,
    "NO .git at the shared wiki root",
  );
  assert.ok(
    fs.existsSync(path.join(host, ".llm-wiki-memory", "personal", ".git")),
    "the PRIVATE personal git lives under personal/ (below the wiki root, can't make gitUsable true)",
  );
});

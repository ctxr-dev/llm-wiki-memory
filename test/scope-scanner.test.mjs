import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanScopes } from "../scripts/lib/scope-scanner.mjs";

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-scope-"));
  tmpDirs.push(home);
  return home;
}

function mkDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function mkMount(dir) {
  fs.mkdirSync(path.join(dir, ".llm-wiki-memory", "wiki", ".layout"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".llm-wiki-memory", "wiki", ".layout", "layout.yaml"),
    "version: 1\n",
  );
  return dir;
}

function real(p) {
  return fs.realpathSync(p);
}

function brainOpts(home) {
  return { home, brainDataDir: path.join(home, ".llm-wiki-memory") };
}

test("scanScopes: a single repo under home yields brain + repo at depths 0 and 1", () => {
  const home = makeHome();
  mkMount(home);
  const proj = mkMount(path.join(home, "proj"));
  const levels = scanScopes([proj], brainOpts(home));
  assert.equal(levels.length, 2, "brain + one repo");
  assert.equal(levels[0].ownership, "wiki");
  assert.equal(levels[0].depth, 0);
  assert.equal(levels[1].ownership, "repo");
  assert.equal(levels[1].depth, 1);
  assert.equal(levels[1].mountDir, real(proj));
  assert.equal(levels[1].root, real(path.join(proj, ".llm-wiki-memory", "wiki")));
  assert.equal(levels[1].projectModule, "proj");
});

test("scanScopes: a nested repo yields brain + parent + child at depths 0/1/2 shallowest-first", () => {
  const home = makeHome();
  mkMount(home);
  const parent = mkMount(path.join(home, "parent"));
  const child = mkMount(path.join(parent, "child"));
  const levels = scanScopes([child], brainOpts(home));
  assert.equal(levels.length, 3);
  assert.deepEqual(
    levels.map((l) => l.depth),
    [0, 1, 2],
  );
  assert.equal(levels[0].ownership, "wiki");
  assert.equal(levels[1].mountDir, real(parent), "parent (shallower) before child");
  assert.equal(levels[2].mountDir, real(child));
});

test("scanScopes: two scopes sharing an ancestor collect that mount once (dedupe)", () => {
  const home = makeHome();
  mkMount(home);
  const mono = mkMount(path.join(home, "mono"));
  const a = mkDir(path.join(mono, "a"));
  const b = mkDir(path.join(mono, "b"));
  const levels = scanScopes([a, b], brainOpts(home));
  assert.equal(levels.length, 2, "brain + shared ancestor once");
  assert.equal(levels[1].mountDir, real(mono));
});

test("scanScopes: a scope outside home is ignored but the brain is still returned at depth 0", () => {
  const home = makeHome();
  mkMount(home);
  const outside = makeHome();
  const proj = mkMount(path.join(outside, "proj"));
  const levels = scanScopes([proj], brainOpts(home));
  assert.equal(levels.length, 1);
  assert.equal(levels[0].ownership, "wiki");
  assert.equal(levels[0].depth, 0);
});

test("scanScopes: a scope under home with no mounts anywhere returns the brain only", () => {
  const home = makeHome();
  mkMount(home);
  const plain = mkDir(path.join(home, "x", "y", "z"));
  const levels = scanScopes([plain], brainOpts(home));
  assert.equal(levels.length, 1);
  assert.equal(levels[0].ownership, "wiki");
});

test("scanScopes: an empty home (HOME unset) returns the brain only, ignoring scopes", () => {
  const home = makeHome();
  mkMount(home);
  const proj = mkMount(path.join(home, "proj"));
  const levels = scanScopes([proj], {
    home: "",
    brainDataDir: path.join(home, ".llm-wiki-memory"),
  });
  assert.equal(levels.length, 1);
  assert.equal(levels[0].depth, 0);
});

test("scanScopes: no scopes returns the brain only at depth 0", () => {
  const home = makeHome();
  mkMount(home);
  const levels = scanScopes([], brainOpts(home));
  assert.equal(levels.length, 1);
  assert.equal(levels[0].depth, 0);
  assert.equal(levels[0].ownership, "wiki");
});

test("scanScopes: a missing scopes argument returns the brain only", () => {
  const home = makeHome();
  mkMount(home);
  const levels = scanScopes(undefined, brainOpts(home));
  assert.equal(levels.length, 1);
  assert.equal(levels[0].ownership, "wiki");
});

test("scanScopes: a half-written mount missing layout.yaml is skipped", () => {
  const home = makeHome();
  mkMount(home);
  const proj = path.join(home, "proj");
  fs.mkdirSync(path.join(proj, ".llm-wiki-memory", "wiki"), { recursive: true });
  const levels = scanScopes([proj], brainOpts(home));
  assert.equal(levels.length, 1, "an incomplete mount is not collected");
  assert.equal(levels[0].ownership, "wiki");
});

test("scanScopes: an inaccessible mount mid-walk never throws and keeps the collected level", () => {
  const home = makeHome();
  mkMount(home);
  const blocked = mkDir(path.join(home, "blocked"));
  const deep = mkMount(path.join(blocked, "deep"));
  const blockedMount = path.join(blocked, ".llm-wiki-memory");
  fs.mkdirSync(blockedMount, { recursive: true });
  fs.chmodSync(blockedMount, 0o000);
  try {
    const levels = scanScopes([deep], brainOpts(home));
    assert.equal(levels.length, 2, "brain + the deep mount collected before the wall");
    assert.equal(levels[0].ownership, "wiki");
    assert.equal(levels[1].mountDir, real(deep));
  } finally {
    fs.chmodSync(blockedMount, 0o755);
  }
});

test("scanScopes: a nonexistent scope does not throw and returns the brain only", () => {
  const home = makeHome();
  mkMount(home);
  const missing = path.join(home, "does-not-exist");
  const levels = scanScopes([missing], brainOpts(home));
  assert.equal(levels.length, 1);
  assert.equal(levels[0].ownership, "wiki");
});

test("scanScopes: ownership is wiki for the brain and repo for a discovered mount", () => {
  const home = makeHome();
  mkMount(home);
  const proj = mkMount(path.join(home, "proj"));
  const [brain, repo] = scanScopes([proj], brainOpts(home));
  assert.equal(brain.ownership, "wiki");
  assert.equal(repo.ownership, "repo");
});

test("scanScopes: projectModule is the repo basename, and the env default for the brain", () => {
  const home = makeHome();
  mkMount(home);
  const proj = mkMount(path.join(home, "acme-service"));
  const prev = process.env.MEMORY_DEFAULT_PROJECT_MODULE;
  process.env.MEMORY_DEFAULT_PROJECT_MODULE = "brain-module";
  try {
    const [brain, repo] = scanScopes([proj], brainOpts(home));
    assert.equal(repo.projectModule, "acme-service");
    assert.equal(brain.projectModule, "brain-module");
  } finally {
    if (prev === undefined) delete process.env.MEMORY_DEFAULT_PROJECT_MODULE;
    else process.env.MEMORY_DEFAULT_PROJECT_MODULE = prev;
  }
});

test("scanScopes: depths are a contiguous 0..n sequence from the shallowest level", () => {
  const home = makeHome();
  mkMount(home);
  const a = mkMount(path.join(home, "a"));
  const b = mkMount(path.join(a, "b"));
  const c = mkMount(path.join(b, "c"));
  const levels = scanScopes([c], brainOpts(home));
  assert.deepEqual(
    levels.map((l) => l.depth),
    [0, 1, 2, 3],
  );
  assert.equal(levels[1].mountDir, real(a), "shallowest repo first");
  assert.equal(levels[3].mountDir, real(c), "deepest repo last");
});

test("scanScopes: the brain root is <brainDataDir>/wiki, mountDir is its parent (wikiRoot semantics)", () => {
  const home = makeHome();
  mkMount(home);
  const brainDataDir = path.join(home, ".llm-wiki-memory");
  const [brain] = scanScopes([], { home, brainDataDir });
  assert.equal(brain.root, path.join(brainDataDir, "wiki"));
  assert.equal(brain.mountDir, home);
});

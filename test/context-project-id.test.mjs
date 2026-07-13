import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveWikiContext } from "../scripts/lib/wiki-context.mjs";
import { defaultProjectModule } from "../scripts/lib/env.mjs";

/** @type {string[]} */
const tmps = [];
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

/** @param {string} dir @param {string} [extraTop] @returns {string} */
function mkMount(dir, extraTop = "") {
  const layoutDir = path.join(dir, ".llm-wiki-memory", "wiki", ".layout");
  fs.mkdirSync(layoutDir, { recursive: true });
  fs.writeFileSync(
    path.join(layoutDir, "layout.yaml"),
    `${extraTop}layout:\n  - path: knowledge\n  - path: daily\n`,
  );
  return dir;
}

test("enrichLevel: a mount layout's project_id overrides the basename projectModule (C4)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c4-projid-"));
  tmps.push(home);
  mkMount(home);
  const proj = mkMount(path.join(home, "proj"), "project_id: acme/widgets\n");
  const ctx = resolveWikiContext([proj], {
    home,
    brainDataDir: path.join(home, ".llm-wiki-memory"),
  });
  assert.equal(ctx.levels.length, 2, "brain + repo mount");
  assert.equal(ctx.levels[1].projectModule, "acme/widgets", "project_id wins over basename 'proj'");
});

test("enrichLevel: a non-git repo mount (no project_id) falls back to its file:// identity", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c4-noprojid-"));
  tmps.push(home);
  mkMount(home);
  const proj = mkMount(path.join(home, "myrepo"));
  const ctx = resolveWikiContext([proj], {
    home,
    brainDataDir: path.join(home, ".llm-wiki-memory"),
  });
  assert.equal(
    ctx.levels[1].projectModule,
    `file://${fs.realpathSync(proj)}`,
    "no git origin and no project_id → file:// of the realpath'd mount dir, never the bare basename",
  );
});

test("enrichLevel: a git repo mount (no project_id) resolves to its canonical org/repo identity", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c4-gitid-"));
  tmps.push(home);
  mkMount(home);
  const proj = mkMount(path.join(home, "gitrepo"));
  const git = (/** @type {string[]} */ args) =>
    spawnSync("git", ["-C", proj, ...args], { encoding: "utf8" });
  git(["init", "-q"]);
  git(["remote", "add", "origin", "git@github.com:acme/gitrepo.git"]);
  const ctx = resolveWikiContext([proj], {
    home,
    brainDataDir: path.join(home, ".llm-wiki-memory"),
  });
  assert.equal(
    ctx.levels[1].projectModule,
    "acme/gitrepo",
    "ssh origin folds to the host-agnostic org/repo identity",
  );
});

test("enrichLevel: the brain (wiki) level keeps the env-default projectModule, never a file:// identity", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c4-brain-"));
  tmps.push(home);
  mkMount(home);
  const proj = mkMount(path.join(home, "r"));
  const ctx = resolveWikiContext([proj], {
    home,
    brainDataDir: path.join(home, ".llm-wiki-memory"),
  });
  assert.equal(ctx.levels[0].ownership, "wiki", "level 0 is the wiki-owned brain");
  assert.equal(
    ctx.levels[0].projectModule,
    defaultProjectModule() || path.basename(home),
    "the brain uses the env default (scanner fallback), not a git/file:// mount identity",
  );
  assert.ok(
    !ctx.levels[0].projectModule.startsWith("file://"),
    "the brain is never a file:// identity",
  );
});

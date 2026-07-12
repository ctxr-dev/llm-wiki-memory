import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildMountGitignore } from "../scripts/lib/mount-gitignore.mjs";

/** @type {string[]} */
const tmps = [];
function tmpRepo() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-mgi-")));
  tmps.push(d);
  spawnSync("git", ["-C", d, "init", "-q"], { encoding: "utf8" });
  return d;
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

// git check-ignore <path>: exit 0 => ignored, 1 => not ignored. Path is
// relative to the repo (the -C dir).
function isIgnored(repoDir, rel) {
  const r = spawnSync("git", ["-C", repoDir, "check-ignore", "-q", rel], { encoding: "utf8" });
  return r.status === 0;
}

test("buildMountGitignore body: shared categories tracked, everything else ignored (git check-ignore matrix)", () => {
  const layout = {
    layout: [
      { path: "knowledge", ownership: "repo" },
      { path: "self_improvement", ownership: "wiki" },
    ],
  };
  const body = buildMountGitignore(layout);
  assert.match(body, /!\/wiki\/knowledge\//, "shared category re-included");
  assert.ok(!/!\/wiki\/self_improvement\//.test(body), "personal category NOT re-included");

  const repo = tmpRepo();
  const mount = path.join(repo, ".llm-wiki-memory");
  const wiki = path.join(mount, "wiki");
  fs.mkdirSync(path.join(wiki, "knowledge", "foo", ".embeddings"), { recursive: true });
  fs.mkdirSync(path.join(wiki, "self_improvement"), { recursive: true });
  fs.mkdirSync(path.join(wiki, ".layout"), { recursive: true });
  fs.writeFileSync(path.join(mount, ".gitignore"), body);
  // Materialise the paths the matrix checks (check-ignore does not require them,
  // but creating them makes the assertions exercise the real tree).
  fs.writeFileSync(path.join(wiki, "knowledge", "foo", "bar.md"), "leaf\n");
  fs.writeFileSync(path.join(wiki, "knowledge", "index.md"), "index\n");
  fs.writeFileSync(path.join(wiki, "knowledge", "foo", ".embeddings", "embeddings.json"), "{}\n");
  fs.writeFileSync(path.join(wiki, "self_improvement", "x.md"), "leaf\n");
  fs.writeFileSync(path.join(wiki, ".layout", "layout.yaml"), "layout: []\n");
  fs.writeFileSync(path.join(wiki, ".layout", "layout.local.yaml"), "layout: []\n");

  const R = ".llm-wiki-memory/wiki";
  // TRACKED (not ignored):
  assert.equal(isIgnored(repo, `${R}/knowledge/foo/bar.md`), false, "shared leaf is tracked");
  assert.equal(
    isIgnored(repo, `${R}/.layout/layout.yaml`),
    false,
    "shared layout contract tracked",
  );
  // IGNORED:
  assert.equal(
    isIgnored(repo, `${R}/.layout/layout.local.yaml`),
    true,
    "personal layout override ignored",
  );
  assert.equal(isIgnored(repo, `${R}/self_improvement/x.md`), true, "personal category ignored");
  assert.equal(
    isIgnored(repo, `${R}/knowledge/foo/.embeddings/embeddings.json`),
    true,
    ".embeddings cache ignored even inside a tracked category",
  );
  assert.equal(isIgnored(repo, `${R}/knowledge/index.md`), true, "generated index.md ignored");
});

test("buildMountGitignore with no shared categories ignores the whole wiki subtree", () => {
  const body = buildMountGitignore({ layout: [{ path: "knowledge", ownership: "wiki" }] });
  assert.ok(!/!\/wiki\/knowledge\//.test(body), "nothing re-included");
  const repo = tmpRepo();
  const mount = path.join(repo, ".llm-wiki-memory");
  const wiki = path.join(mount, "wiki");
  fs.mkdirSync(path.join(wiki, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(mount, ".gitignore"), body);
  fs.writeFileSync(path.join(wiki, "knowledge", "k.md"), "leaf\n");
  assert.equal(isIgnored(repo, ".llm-wiki-memory/wiki/knowledge/k.md"), true);
});

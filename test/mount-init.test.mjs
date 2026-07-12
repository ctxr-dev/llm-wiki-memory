import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initMount } from "../scripts/mount-init.mjs";

/** @type {string[]} */
const tmps = [];
function mount(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `lwm-${prefix}-`)));
  tmps.push(d);
  return d;
}
function writeLayout(mountDir, yaml) {
  const dir = path.join(mountDir, ".llm-wiki-memory", "wiki", ".layout");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "layout.yaml"), yaml);
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

test("initMount is a no-op (skipped) when the layout declares no shared category", () => {
  const m = mount("mi-none");
  writeLayout(m, "layout:\n  - path: knowledge\n    ownership: wiki\n");
  const res = initMount(m);
  assert.equal(res.skipped, "no-shared-categories");
  assert.ok(!fs.existsSync(path.join(m, ".llm-wiki-memory", ".gitignore")), "no mount .gitignore");
  assert.ok(
    !fs.existsSync(path.join(m, ".llm-wiki-memory", "personal", ".git")),
    "no personal git",
  );
});

test("initMount provisions gitignore + personal git + sync hook when a shared category exists", () => {
  const m = mount("mi-shared");
  spawnSync("git", ["-C", m, "init", "-q"], { encoding: "utf8" });
  writeLayout(m, "layout:\n  - path: knowledge\n    ownership: repo\n");
  const res = initMount(m);

  assert.equal(res.gitignore, true);
  const gi = path.join(m, ".llm-wiki-memory", ".gitignore");
  assert.ok(fs.existsSync(gi), "mount .gitignore written");
  assert.match(fs.readFileSync(gi, "utf8"), /!\/wiki\/knowledge\//, "shared category tracked");

  const pg = /** @type {{ created: boolean }} */ (res.personalGit);
  assert.equal(pg.created, true);
  assert.ok(fs.existsSync(path.join(m, ".llm-wiki-memory", "personal", ".git")));

  const host = /** @type {{ ok: boolean }} */ (res.hostIgnore);
  assert.equal(host.ok, true, "mount not host-ignored (no /.llm-wiki-memory rule)");

  const hook = /** @type {{ ok: boolean }} */ (res.syncHook);
  assert.equal(hook.ok, true);
  assert.ok(fs.existsSync(path.join(m, ".git", "hooks", "post-merge")), "sync hook installed");
});

test("initMount surfaces (non-fatally) a host-ignored mount", () => {
  const m = mount("mi-hostign");
  spawnSync("git", ["-C", m, "init", "-q"], { encoding: "utf8" });
  fs.writeFileSync(path.join(m, ".gitignore"), "/.llm-wiki-memory\n");
  writeLayout(m, "layout:\n  - path: knowledge\n    ownership: repo\n");
  const res = initMount(m);
  const host = /** @type {{ ok: boolean, message?: string }} */ (res.hostIgnore);
  assert.equal(host.ok, false);
  assert.match(String(host.message), /git-ignored by the enclosing repo/);
});

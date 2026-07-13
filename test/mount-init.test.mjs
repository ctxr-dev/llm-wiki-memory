import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initMount } from "../scripts/mount-init.mjs";
import { MARKER_START, HOOK_EVENTS } from "../scripts/lib/mount-git.mjs";
import { removeSyncHookBlocks } from "../scripts/lib/uninstall.mjs";

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
  // All THREE events are installed and carry our marker (not just post-merge).
  const hooksDir = path.join(m, ".git", "hooks");
  for (const ev of HOOK_EVENTS) {
    const p = path.join(hooksDir, ev);
    assert.ok(fs.existsSync(p), `${ev} installed`);
    assert.ok(fs.readFileSync(p, "utf8").includes(MARKER_START), `${ev} carries the sync marker`);
  }
});

test("hook lifecycle round-trip: initMount installs all 3 events → uninstall removes them; a user hook survives", () => {
  const m = mount("mi-roundtrip");
  spawnSync("git", ["-C", m, "init", "-q"], { encoding: "utf8" });
  writeLayout(m, "layout:\n  - path: knowledge\n    ownership: repo\n");
  const hooksDir = path.join(m, ".git", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  // A pre-existing USER hook on one event — our block chains after it and must survive uninstall.
  fs.writeFileSync(path.join(hooksDir, "post-merge"), "#!/usr/bin/env bash\necho USER-HOOK\n", {
    mode: 0o755,
  });

  const res = initMount(m);
  assert.equal(/** @type {{ ok: boolean }} */ (res.syncHook).ok, true);
  for (const ev of HOOK_EVENTS) {
    assert.ok(
      fs.readFileSync(path.join(hooksDir, ev), "utf8").includes(MARKER_START),
      `${ev} has marker`,
    );
  }

  const removed = removeSyncHookBlocks(m);
  assert.equal(removed.ok, true);
  assert.equal(removed.results?.["post-merge"], "stripped", "user hook kept, our block stripped");
  assert.equal(removed.results?.["post-checkout"], "removed", "our-only hook deleted");
  assert.equal(removed.results?.["post-rewrite"], "removed", "our-only hook deleted");
  const pm = fs.readFileSync(path.join(hooksDir, "post-merge"), "utf8");
  assert.match(pm, /echo USER-HOOK/, "the user's own hook body survives");
  assert.ok(!pm.includes(MARKER_START), "our marker is gone from the user hook");
  assert.ok(!fs.existsSync(path.join(hooksDir, "post-checkout")), "our-only hook file removed");
});

test("initMount seeds the knowledge-only repo template when the mount has no layout", () => {
  const m = mount("mi-seed");
  spawnSync("git", ["-C", m, "init", "-q"], { encoding: "utf8" });
  // No writeLayout(): the mount starts with no layout at all.
  const res = initMount(m);

  assert.equal(res.seeded, "repo", "repo template seeded");
  const layoutFile = path.join(m, ".llm-wiki-memory", "wiki", ".layout", "layout.yaml");
  assert.ok(fs.existsSync(layoutFile), "layout.yaml materialised from the repo template");
  const raw = fs.readFileSync(layoutFile, "utf8");
  assert.match(raw, /- path: knowledge/);
  assert.match(raw, /ownership:\s*repo/, "seeded layout declares a shared category");
  assert.ok(!raw.includes("- path: daily"), "repo template is knowledge-only");

  // Having seeded a shared layout, it proceeds to wire the git surfaces.
  assert.equal(res.gitignore, true);
  const gi = path.join(m, ".llm-wiki-memory", ".gitignore");
  assert.match(fs.readFileSync(gi, "utf8"), /!\/wiki\/knowledge\//);
  assert.ok(fs.existsSync(path.join(m, ".git", "hooks", "post-merge")), "sync hook installed");

  // Idempotent: a second call finds the layout present and does not re-seed.
  const again = initMount(m);
  assert.equal(again.seeded, undefined, "no re-seed once the layout exists");
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

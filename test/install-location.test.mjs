// Where a PRIVATE brain may be installed. The engine is installed ONCE per
// machine, at $HOME; a second private brain inside a repo would only duplicate
// that wiring into a project tree. These pin the full refusal matrix, including
// the two rows that must still PROCEED (or the guard would wedge an upgrade).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  checkInstallLocation,
  hasHomeBrain,
  DECISION,
} from "../scripts/bootstrap/install-location.mjs";

const GUARD = fileURLToPath(new URL("../scripts/bootstrap/install-location.mjs", import.meta.url));

/** @type {string[]} */
const tmps = [];
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmps.push(d);
  return d;
}

/** Materialise a wiki at `<dir>/.llm-wiki-memory/wiki`, shared or private. */
function seedWiki(dir, { shared = false } = {}) {
  const layoutDir = path.join(dir, ".llm-wiki-memory", "wiki", ".layout");
  fs.mkdirSync(layoutDir, { recursive: true });
  fs.writeFileSync(
    path.join(layoutDir, "layout.yaml"),
    shared
      ? "layout:\n  - path: knowledge\n    ownership: repo\n"
      : "layout:\n  - path: knowledge\n",
  );
  return dir;
}

test("hasHomeBrain: absent, private, and shared-at-home are distinguished", () => {
  const empty = tmpDir("il-empty-");
  assert.equal(hasHomeBrain(empty), false, "no wiki at all");

  const priv = seedWiki(tmpDir("il-priv-"));
  assert.equal(hasHomeBrain(priv), true, "a private brain counts");

  // A machine whose $HOME wiki is itself a shared mount has no private brain.
  const shared = seedWiki(tmpDir("il-shared-"), { shared: true });
  assert.equal(hasHomeBrain(shared), false, "a shared wiki is not a brain");
});

test("workspace == $HOME always proceeds (this IS the one install)", () => {
  const home = tmpDir("il-home-");
  for (const template of ["default", "repo"]) {
    assert.equal(
      checkInstallLocation({ workspaceDir: home, home, template }).decision,
      DECISION.PROCEED,
      `template ${template}`,
    );
  }
});

// "Is the workspace $HOME" was answered by comparing two path.resolve'd STRINGS, which says no
// whenever either side reaches the same directory through a link — a symlinked home on macOS/Linux,
// a junctioned or redirected user profile on Windows. The install is then misclassified as being
// outside $HOME and can be refused outright. samePath() (scripts/lib/path-equal.mjs) already
// answers exactly this question for unregister-global.mjs; the two modules simply disagreed.
test("workspace reaching $HOME through a symlink still proceeds", () => {
  const home = tmpDir("il-link-home-");
  const linkParent = tmpDir("il-link-");
  const linked = path.join(linkParent, "home-alias");
  // "junction" not "dir": a plain directory symlink needs Administrator on Windows.
  fs.symlinkSync(home, linked, "junction");
  assert.notEqual(linked, fs.realpathSync(linked), "fixture must actually be an alias");

  for (const template of ["default", "repo"]) {
    assert.equal(
      checkInstallLocation({ workspaceDir: linked, home, template }).decision,
      DECISION.PROCEED,
      `a link to $HOME is $HOME (template ${template})`,
    );
  }
});

test("an EXISTING wiki outside $HOME proceeds — a re-run is an upgrade, never a refusal", () => {
  const home = seedWiki(tmpDir("il-home2-"));
  // Both a shared mount being re-run (how stale artifacts get cleaned) and a
  // legacy standalone brain mid-migration must keep working.
  for (const shared of [true, false]) {
    const ws = seedWiki(tmpDir("il-existing-"), { shared });
    assert.equal(
      checkInstallLocation({ workspaceDir: ws, home, template: "default" }).decision,
      DECISION.PROCEED,
      `existing ${shared ? "shared" : "private"} wiki`,
    );
  }
});

test("a FRESH install outside $HOME with NO home brain is REFUSED, and says to install at home", () => {
  const home = tmpDir("il-nobrain-");
  const ws = tmpDir("il-repo-");
  for (const template of ["default", "repo"]) {
    const res = checkInstallLocation({ workspaceDir: ws, home, template });
    assert.equal(res.decision, DECISION.REFUSE_NO_HOME_BRAIN, `template ${template}`);
    assert.match(res.message || "", /no llm-wiki-memory brain yet/);
    assert.match(res.message || "", /bootstrap\.sh --schedule hourly/, "gives the exact command");
  }
});

test("a FRESH SHARED mount outside $HOME proceeds once a home brain exists", () => {
  const home = seedWiki(tmpDir("il-home3-"));
  const ws = tmpDir("il-mount-");
  assert.equal(
    checkInstallLocation({ workspaceDir: ws, home, template: "repo" }).decision,
    DECISION.PROCEED,
    "a repo may HOST a team wiki — that is data, and it gets no wiring",
  );
});

test("a FRESH PRIVATE brain outside $HOME is REFUSED even when the home brain exists", () => {
  const home = seedWiki(tmpDir("il-home4-"));
  const ws = tmpDir("il-second-");
  const res = checkInstallLocation({ workspaceDir: ws, home, template: "default" });
  assert.equal(res.decision, DECISION.REFUSE_PRIVATE_OUTSIDE_HOME);
  assert.match(res.message || "", /already serves this directory/);
  assert.match(res.message || "", /--template repo/, "points at the shared-mount alternative");
});

test("CLI: exits 0 to proceed, 3 with the explanation on stderr to refuse", () => {
  const home = seedWiki(tmpDir("il-cli-home-"));
  const ws = tmpDir("il-cli-ws-");

  const ok = spawnSync(process.execPath, [GUARD, home, home, "default"], { encoding: "utf8" });
  assert.equal(ok.status, 0, "workspace == home proceeds");

  const refused = spawnSync(process.execPath, [GUARD, ws, home, "default"], { encoding: "utf8" });
  assert.equal(refused.status, 3, "a private brain outside home is refused");
  assert.match(refused.stderr, /Refusing to install a private brain/);

  const mount = spawnSync(process.execPath, [GUARD, ws, home, "repo"], { encoding: "utf8" });
  assert.equal(mount.status, 0, "a shared mount is allowed");
});

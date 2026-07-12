import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { realTmp, rmAll, writeLexicalSettings, runInit } from "./federation-helpers.mjs";

// B2 (home-install pack, §6c) — the SAFE, subprocess-driven slice: `cli.mjs init`
// only ever writes under its own MEMORY_DATA_DIR (a /tmp dir), never the real src.
// The bootstrap-only machine surfaces (.mcp.json / .claude / .agents / fan-out /
// wiki/.git) are covered separately once the C14 safe-drive lands (bootstrap.sh:109
// runs `npm install` in the real $SRC_DIR — the one real-FS hazard, kept out of here).
// The template variants + unknown-template + byte-identical layout are already covered
// by cmd-init-template.test; the check-ignore matrix by federation-install.e2e (C19) —
// this file is strictly additive gap-fill (fresh-state absences + re-init idempotency).

/** @type {string[]} */
const tmps = [];
after(() => rmAll(tmps));

function initHome(prefix) {
  const dataDir = realTmp(prefix);
  tmps.push(dataDir);
  writeLexicalSettings(dataDir);
  const r = runInit(dataDir, ["--template", "default"]);
  assert.equal(r.status, 0, `init exited non-zero: ${r.stderr}`);
  return { dataDir, parsed: JSON.parse(r.stdout), raw: r };
}

test("home install: a fresh init writes the layout contract and NO index/state artifacts yet", () => {
  const { dataDir, parsed } = initHome("home-fresh");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.template, "default");
  assert.ok(
    fs.existsSync(path.join(parsed.wiki, ".layout", "layout.yaml")),
    "layout.yaml contract written",
  );
  assert.ok(fs.existsSync(path.join(parsed.wiki, "index.md")), "wiki/index.md written by init");
  // index/ and state/ exist but are EMPTY on a fresh install — their artifacts
  // (the embedding cache, consolidate/gc state) are created lazily on first use.
  for (const dir of ["index", "state"]) {
    const p = path.join(dataDir, dir);
    assert.ok(fs.existsSync(p), `${dir}/ dir present`);
    assert.deepEqual(fs.readdirSync(p), [], `${dir}/ is empty on a fresh init`);
  }
  // `cli.mjs init` provisions the WIKI only — it does NOT git-init the wiki (a
  // bootstrap step), so a bare init leaves no wiki/.git.
  assert.ok(
    !fs.existsSync(path.join(parsed.wiki, ".git")),
    "cli.mjs init alone does not create wiki/.git",
  );
});

test("home install: re-running init is idempotent — layout.yaml stays byte-identical", () => {
  const dataDir = realTmp("home-reinit");
  tmps.push(dataDir);
  writeLexicalSettings(dataDir);

  const first = runInit(dataDir, ["--template", "default"]);
  assert.equal(first.status, 0, first.stderr);
  const contract = JSON.parse(first.stdout).contract;
  const layoutAfterFirst = fs.readFileSync(contract, "utf8");

  const second = runInit(dataDir, ["--template", "default"]);
  assert.equal(second.status, 0, `2nd init exited non-zero: ${second.stderr}`);
  assert.equal(JSON.parse(second.stdout).ok, true, "2nd init still reports ok");
  const layoutAfterSecond = fs.readFileSync(contract, "utf8");

  assert.equal(
    layoutAfterSecond,
    layoutAfterFirst,
    "a 2nd init leaves the existing layout.yaml byte-identical (no re-seed / no drift)",
  );
});

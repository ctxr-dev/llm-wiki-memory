// Workstream D e2e — the reference-only wiring against the REAL shipped src
// (dead-reference guard: every @-pointer's target actually exists) and through
// the CLI boundary bootstrap uses. The wiring MECHANISM (surfaces, opt-in,
// @-include, idempotency, migration) is covered by test/wire-memory-surfaces.test.mjs;
// this adds the real-corpus + subprocess coverage without the C14 npm-install
// hazard (it never runs bootstrap.sh, only the pure wire step in a /tmp workspace).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { wireMemorySurfaces } from "../../scripts/wire-memory-surfaces.mjs";

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const HOME = path.dirname(path.dirname(SRC)); // SRC = <home>/.llm-wiki-memory/src

/** @type {string[]} */
const tmps = [];
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

/** @returns {string} a fresh /tmp workspace */
function freshWs() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "d-install-")));
  tmps.push(ws);
  return ws;
}

/** @param {string} ws @returns {string[]} every pointer file across the four surfaces */
function pointerFiles(ws) {
  const out = [];
  for (const s of [".agents/rules", ".claude/skills", ".claude/rules", ".cursor/rules"]) {
    const dir = path.join(ws, s);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith("llm-wiki-memory-")) out.push(path.join(dir, f));
    }
  }
  return out;
}

test("install-wiring: every @-pointer written against the REAL src resolves to a file that exists (no dead references)", () => {
  const ws = freshWs();
  wireMemorySurfaces({ srcDir: SRC, workspaceDir: ws, home: HOME, selfObsEnabled: true });

  const files = pointerFiles(ws);
  assert.ok(
    files.length >= 8,
    `expected the shipped skills+rules to produce pointers, got ${files.length}`,
  );
  for (const f of files) {
    const body = fs.readFileSync(f, "utf8");
    const m = body.match(/^@(~\/.+)$/m);
    assert.ok(m, `pointer ${path.basename(f)} carries an @~/ include line`);
    const target = m[1].replace(/^~/, HOME);
    assert.ok(
      fs.existsSync(target),
      `pointer ${path.basename(f)} → ${target} must exist (no dead reference)`,
    );
    // It is a POINTER, not a copy: the file IS the @-line + fallback, not the target's body.
    assert.ok(
      body.length < 400,
      `pointer ${path.basename(f)} is a thin pointer, not a copied body`,
    );
  }
});

test("install-wiring: the shipped skills each land on .claude/skills as a prefixed pointer, none as a copy", () => {
  const ws = freshWs();
  wireMemorySurfaces({ srcDir: SRC, workspaceDir: ws, home: HOME, selfObsEnabled: false });

  const skills = fs
    .readdirSync(path.join(SRC, "templates/skills"))
    .filter((n) => n.endsWith(".md"));
  for (const name of skills) {
    const pointer = path.join(ws, ".claude/skills", `llm-wiki-memory-${name}`);
    assert.ok(fs.existsSync(pointer), `skill ${name} wired as a pointer`);
    // The unprefixed name (a hard copy) must NOT exist.
    assert.ok(!fs.existsSync(path.join(ws, ".claude/skills", name)), `no hard copy of ${name}`);
  }
});

test("install-wiring: the CLI entrypoint bootstrap calls wires a fresh workspace (exit 0, pointers present)", () => {
  const ws = freshWs();
  const r = spawnSync(
    "node",
    [path.join(SRC, "scripts/wire-memory-surfaces.mjs"), SRC, ws, HOME, "0"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, `wire CLI exited ${r.status}: ${r.stderr}`);
  assert.ok(fs.existsSync(path.join(ws, ".agents/rules")), "surfaces created");
  assert.ok(pointerFiles(ws).length >= 8, "pointers written via the CLI boundary");
  // AGENTS.md/CLAUDE.md created with the @-include of the extracted instructions.
  for (const doc of ["AGENTS.md", "CLAUDE.md"]) {
    const body = fs.readFileSync(path.join(ws, doc), "utf8");
    assert.match(
      body,
      /@~\/.*templates\/agents-memory-instructions\.md/,
      `${doc} @-includes the instructions`,
    );
  }
});

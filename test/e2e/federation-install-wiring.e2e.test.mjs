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
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { wireMemorySurfaces } from "../../scripts/wire-memory-surfaces.mjs";
import { uninstall } from "../../scripts/lib/uninstall.mjs";
import { HASH_MARKER_START, HASH_MARKER_END } from "../../scripts/lib/memory-surface-constants.mjs";
import { manifestPath } from "../../scripts/lib/install-manifest.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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

/** Recursively collect files under `dir`, skipping the memory data + git dirs. @param {string} dir @param {string} root @returns {string[]} */
function walkFiles(dir, root = dir) {
  /** @type {string[]} */ const out = [];
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    if (entry.name === ".llm-wiki-memory" || entry.name === ".git") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, root));
    else out.push(path.relative(root, abs));
  }
  return out;
}

test("install-wiring: a FULL wire→uninstall round-trip leaves ZERO llm-wiki-memory residue (determinism gate)", () => {
  const ws = freshWs();
  // 1. The reference-only wiring (pointers + AGENTS/CLAUDE @-includes + manifest).
  wireMemorySurfaces({ srcDir: SRC, workspaceDir: ws, home: HOME, selfObsEnabled: true });
  // 2. The bootstrap-only materialized artifacts (reproduced WITHOUT bootstrap.sh, C14-safe).
  fs.writeFileSync(
    path.join(ws, ".gitignore"),
    `node_modules\n${HASH_MARKER_START}\n/.llm-wiki-memory\n${HASH_MARKER_END}\n`,
  );
  fs.mkdirSync(path.join(ws, ".agents", "clients"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".agents", "README.md"), "our readme\n");
  fs.writeFileSync(
    path.join(ws, ".agents", "mcp.json"),
    `${JSON.stringify({ mcpServers: { "llm-wiki-memory": { command: "node" } } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(ws, ".agents", "clients", "openai-codex.toml"),
    '[mcp_servers.llm-wiki-memory]\ncommand = "node"\n',
  );
  fs.writeFileSync(
    path.join(ws, ".mcp.json"),
    `${JSON.stringify(
      { mcpServers: { "llm-wiki-memory": { command: "node" }, other: { command: "x" } } },
      null,
      2,
    )}\n`,
  );
  fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".claude", "settings.json"),
    `${JSON.stringify(
      {
        hooks: {
          SessionEnd: [{ hooks: [{ command: "$HOME/.llm-wiki-memory/src/scripts/hooks/gc.sh" }] }],
        },
      },
      null,
      2,
    )}\n`,
  );

  // 3. Uninstall.
  const res = uninstall({ workspaceDir: ws });

  // 4. ZERO residue: no prefixed pointer, no @-include, no our-src reference anywhere
  //    (the intentionally-kept .llm-wiki-memory data dir is excluded from the walk).
  const remaining = walkFiles(ws);
  for (const rel of remaining) {
    const name = path.basename(rel);
    assert.ok(!name.startsWith("llm-wiki-memory-"), `no prefixed pointer should remain: ${rel}`);
    const body = fs.readFileSync(path.join(ws, rel), "utf8");
    assert.doesNotMatch(
      body,
      /\.llm-wiki-memory\/src/,
      `no file should still reference our install after uninstall: ${rel}`,
    );
  }
  assert.ok(!fs.existsSync(manifestPath(ws)), "the install manifest is gone");
  assert.ok(!fs.existsSync(path.join(ws, "AGENTS.md")), "AGENTS.md (only our block) is removed");
  assert.ok(!fs.existsSync(path.join(ws, "CLAUDE.md")), "CLAUDE.md (only our block) is removed");
  assert.ok(!fs.existsSync(path.join(ws, ".agents", "README.md")), "our .agents README removed");
  // Emptied surface dirs AND their parents are pruned (no empty-dir residue).
  for (const surface of [
    ".agents/rules",
    ".claude/skills",
    ".claude/rules",
    ".cursor/rules",
    ".agents",
    ".claude",
    ".cursor",
  ]) {
    assert.ok(!fs.existsSync(path.join(ws, surface)), `emptied dir pruned: ${surface}`);
  }
  // .mcp.json survives with the sibling server; our key is gone.
  const mcp = JSON.parse(fs.readFileSync(path.join(ws, ".mcp.json"), "utf8"));
  assert.ok(!("llm-wiki-memory" in mcp.mcpServers), "our MCP key removed");
  assert.ok("other" in mcp.mcpServers, "a sibling MCP server is preserved");

  // 5. Idempotent: a second uninstall removes nothing and never throws.
  const res2 = uninstall({ workspaceDir: ws });
  assert.deepEqual(res2.surfaces.pointers, [], "2nd uninstall removes no pointers");
  assert.deepEqual(res2.agents.removed, [], "2nd uninstall removes no .agents surface");
  assert.equal(res2.claudeHooks.removed, 0, "2nd uninstall removes no hooks");
  assert.equal(res2.gitignore, false, "2nd uninstall strips no gitignore block");
  assert.ok(Array.isArray(res.surfaces.pointers) && res.surfaces.pointers.length >= 8);
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

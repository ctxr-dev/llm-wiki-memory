// Phase B4 e2e — uninstall reverses the reference-only install (D). It deletes
// every prefixed @-pointer from the four surfaces, strips the AGENTS.md/CLAUDE.md
// @-include, and removes the MCP registration (preserving siblings + the user's own
// rules), is idempotent, and a reinstall is clean (one block, no duplicates). The
// MCP-JSON and sync-hook mechanics are unit-covered by test/uninstall.test.mjs; this
// adds the D surface-removal + reinstall round-trip. Realpath'd /tmp; no bootstrap
// (no C14 npm-install hazard) — the pure wire + uninstall halves only.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wireMemorySurfaces } from "../../scripts/wire-memory-surfaces.mjs";
import { uninstall } from "../../scripts/lib/uninstall.mjs";

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const HOME = path.dirname(path.dirname(SRC));

/** @type {string[]} */
const tmps = [];
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

/** @returns {string} */
function freshWs() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "b4-uninstall-")));
  tmps.push(ws);
  return ws;
}

const SURFACES = [".agents/rules", ".claude/rules", ".claude/skills", ".cursor/rules"];

/** @param {string} ws @returns {number} */
function pointerCount(ws) {
  let n = 0;
  for (const s of SURFACES) {
    const dir = path.join(ws, s);
    if (!fs.existsSync(dir)) continue;
    n += fs.readdirSync(dir).filter((f) => f.startsWith("llm-wiki-memory-")).length;
  }
  return n;
}

/** @param {string} ws */
function install(ws) {
  wireMemorySurfaces({ srcDir: SRC, workspaceDir: ws, home: HOME, selfObsEnabled: true });
  fs.writeFileSync(
    path.join(ws, ".mcp.json"),
    `${JSON.stringify({ mcpServers: { "llm-wiki-memory": { command: "node" }, other: { command: "x" } } }, null, 2)}\n`,
  );
}

test("uninstall: reverses the reference-only install (pointers, @-include, MCP entry) and preserves siblings + user rules", () => {
  const ws = freshWs();
  install(ws);
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "# My project\n\nuser notes.\n");
  wireMemorySurfaces({ srcDir: SRC, workspaceDir: ws, home: HOME, selfObsEnabled: true });
  // A user's OWN rule (not prefixed) must survive.
  fs.writeFileSync(path.join(ws, ".claude/rules", "my-own-rule.md"), "# mine\n");
  assert.ok(pointerCount(ws) >= 8, "install wired pointers");

  const report = uninstall({ workspaceDir: ws });

  assert.equal(pointerCount(ws), 0, "every prefixed @-pointer removed from every surface");
  assert.ok(report.surfaces.pointers.length >= 8, "report lists the removed pointers");
  assert.ok(
    fs.existsSync(path.join(ws, ".claude/rules", "my-own-rule.md")),
    "the user's own rule is untouched",
  );

  const agents = fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
  assert.match(agents, /# My project/, "user content preserved");
  assert.ok(!agents.includes("BEGIN llm-wiki-memory"), "the @-include block is stripped");
  assert.ok(report.surfaces.docs.includes("AGENTS.md"), "report lists the doc stripped");

  const mcp = JSON.parse(fs.readFileSync(path.join(ws, ".mcp.json"), "utf8"));
  assert.ok(!("llm-wiki-memory" in mcp.mcpServers), "our MCP server removed");
  assert.ok("other" in mcp.mcpServers, "the sibling MCP server preserved");
});

test("uninstall: a CLAUDE.md that was ONLY our block is deleted (we created it)", () => {
  const ws = freshWs();
  wireMemorySurfaces({ srcDir: SRC, workspaceDir: ws, home: HOME, selfObsEnabled: false });
  assert.ok(
    fs.existsSync(path.join(ws, "CLAUDE.md")),
    "install created CLAUDE.md with just the block",
  );

  uninstall({ workspaceDir: ws });
  assert.ok(!fs.existsSync(path.join(ws, "CLAUDE.md")), "a doc that was ONLY our block is removed");
});

test("uninstall: is idempotent — a second run removes nothing new", () => {
  const ws = freshWs();
  install(ws);
  uninstall({ workspaceDir: ws });
  const second = uninstall({ workspaceDir: ws });
  assert.equal(second.surfaces.pointers.length, 0, "no pointers left to remove");
  assert.equal(second.surfaces.docs.length, 0, "no doc block left to strip");
  assert.deepEqual(second.mcp.removed, [], "no MCP entry left to remove");
});

test("uninstall: a reinstall after uninstall is clean (pointers back, ONE @-include block)", () => {
  const ws = freshWs();
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "# Mine\n\nkeep.\n");
  install(ws);
  uninstall({ workspaceDir: ws });
  install(ws);

  assert.ok(pointerCount(ws) >= 8, "pointers restored on reinstall");
  const agents = fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
  assert.equal(
    (agents.match(/BEGIN llm-wiki-memory/g) || []).length,
    1,
    "exactly one @-include block after uninstall→reinstall (no duplicate)",
  );
  assert.match(agents, /# Mine/, "user content still preserved through the round-trip");
});

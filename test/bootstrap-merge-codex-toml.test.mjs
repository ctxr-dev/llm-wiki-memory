import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeCodexToml } from "../scripts/bootstrap/merge-codex-toml.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "codex-toml-"));
const read = (f) => fs.readFileSync(f, "utf8");

test("creates the file with our table when absent", () => {
  const dir = tmp();
  const f = path.join(dir, ".codex", "config.toml");
  const r = mergeCodexToml(f);
  assert.equal(r.action, "created");
  assert.match(
    read(f),
    /^\[mcp_servers\.llm-wiki-memory\]\ncommand = "node"\nargs = \[".*index\.mjs"\]\n$/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("appends our table to an existing config, preserving other tables", () => {
  const dir = tmp();
  const f = path.join(dir, "config.toml");
  fs.writeFileSync(f, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "foo"\n');
  const r = mergeCodexToml(f);
  assert.equal(r.action, "appended");
  const out = read(f);
  assert.match(out, /model = "gpt-5"/);
  assert.match(out, /\[mcp_servers\.other\]/);
  assert.match(out, /\[mcp_servers\.llm-wiki-memory\]/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("idempotent: a second run is byte-stable (unchanged)", () => {
  const dir = tmp();
  const f = path.join(dir, "config.toml");
  fs.writeFileSync(f, 'model = "gpt-5"\n');
  mergeCodexToml(f);
  const after1 = read(f);
  const r2 = mergeCodexToml(f);
  assert.equal(r2.action, "unchanged");
  assert.equal(r2.changed, false);
  assert.equal(read(f), after1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("idempotent from empty: create then unchanged", () => {
  const dir = tmp();
  const f = path.join(dir, "config.toml");
  mergeCodexToml(f);
  const after1 = read(f);
  const r2 = mergeCodexToml(f);
  assert.equal(r2.action, "unchanged");
  assert.equal(read(f), after1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("preserves a customized (wrapper) command, does not overwrite", () => {
  const dir = tmp();
  const f = path.join(dir, "config.toml");
  const wrapped =
    '[mcp_servers.llm-wiki-memory]\ncommand = "/usr/local/bin/prompt_security_mcp"\nargs = ["node", "x.mjs"]\n';
  fs.writeFileSync(f, wrapped);
  const r = mergeCodexToml(f);
  assert.equal(r.action, "preserved-customized");
  assert.equal(r.changed, false);
  assert.equal(read(f), wrapped);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("replaces a stale (non-customized) block in place, consuming dotted-child subtables", () => {
  const dir = tmp();
  const f = path.join(dir, "config.toml");
  fs.writeFileSync(
    f,
    '[mcp_servers.llm-wiki-memory]\ncommand = "node"\nargs = ["OLD.mjs"]\n\n[mcp_servers.llm-wiki-memory.env]\nFOO = "1"\n\n[other]\nk = 1\n',
  );
  const r = mergeCodexToml(f, "${HOME}/new.mjs");
  assert.equal(r.changed, true);
  const out = read(f);
  assert.doesNotMatch(out, /OLD\.mjs/);
  assert.doesNotMatch(out, /mcp_servers\.llm-wiki-memory\.env/, "stale child subtable consumed");
  assert.match(out, /args = \["\$\{HOME\}\/new\.mjs"\]/);
  assert.match(out, /\[other\]\nk = 1/, "unrelated table preserved");
  // exactly one of our tables
  assert.equal((out.match(/\[mcp_servers\.llm-wiki-memory\]/g) || []).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

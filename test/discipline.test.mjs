import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setupWorkspace, cleanup, SRC, runScript } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const { INSTRUCTIONS, buildSessionStartContext } = await import("../scripts/lib/discipline.mjs");

test("INSTRUCTIONS names the core discipline tools", () => {
  for (const needle of ["recall_lessons", "save_lesson", "save_to_dataset", "search_memory", "UNTRUSTED"]) {
    assert.ok(INSTRUCTIONS.includes(needle), `instructions mention ${needle}`);
  }
});

test("buildSessionStartContext embeds INSTRUCTIONS and the server name + compile note", () => {
  const ctx = buildSessionStartContext({ serverName: "my-mem", compileTriggered: true });
  assert.ok(ctx.includes("my-mem"), "names the server");
  assert.ok(ctx.includes(INSTRUCTIONS), "reuses the shared INSTRUCTIONS (single source)");
  assert.ok(ctx.includes("Compile was triggered"), "compile note present");
});

test("SessionStart hook output carries the shared discipline", () => {
  const r = runScript("scripts/hooks/session-start.mjs", [], {
    stdin: "{}",
    env: { CLAUDE_INVOKED_BY: "memory_compile" }, // suppress real compile spawn
  });
  assert.equal(r.status, 0, `hook exit 0: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("recall_lessons") && ctx.includes("save_lesson"), "discipline present in SessionStart context");
});

test("merge-marker.mjs is idempotent (one block after two runs)", () => {
  const f = path.join(dataDir, "AGENTS_test.md");
  fs.writeFileSync(f, "# Existing\n\nsome content\n");
  const run = () =>
    spawnSync(process.execPath, [path.join(SRC, "scripts/merge-marker.mjs"), f, "<!-- B -->", "<!-- E -->", "-"], {
      input: "pointer body v__N__",
      encoding: "utf8",
    });
  run();
  const second = spawnSync(
    process.execPath,
    [path.join(SRC, "scripts/merge-marker.mjs"), f, "<!-- B -->", "<!-- E -->", "-"],
    { input: "pointer body v2", encoding: "utf8" },
  );
  assert.equal(second.status, 0);
  const text = fs.readFileSync(f, "utf8");
  assert.equal(text.match(/<!-- B -->/g).length, 1, "exactly one begin marker");
  assert.equal(text.match(/<!-- E -->/g).length, 1, "exactly one end marker");
  assert.ok(text.includes("pointer body v2"), "content replaced on re-run");
  assert.ok(text.startsWith("# Existing"), "pre-existing content preserved");
});

test("MCP server surfaces INSTRUCTIONS to the client on initialize", async () => {
  const client = new Client({ name: "disc-test", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    env: { ...process.env },
    cwd: SRC,
  });
  await client.connect(transport);
  try {
    const instr = client.getInstructions();
    assert.ok(instr && instr.includes("recall_lessons") && instr.includes("save_lesson"), "server instructions delivered on connect");
  } finally {
    await client.close();
  }
});

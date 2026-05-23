import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeArgs } from "../scripts/lib/llm.mjs";
import { reentryEnv } from "../scripts/lib/reentry.mjs";

test("buildClaudeArgs: carries the MCP-less + tool-less isolation flags", () => {
  const args = buildClaudeArgs({ systemPrompt: "SYS", userPrompt: "USR" });
  assert.ok(args.includes("--strict-mcp-config"), "loads no project MCP");
  const mcpIdx = args.indexOf("--mcp-config");
  assert.notEqual(mcpIdx, -1, "passes an empty mcp config");
  assert.equal(args[mcpIdx + 1], '{"mcpServers":{}}');
  const allowedIdx = args.indexOf("--allowedTools");
  assert.notEqual(allowedIdx, -1, "passes an allow-list");
  assert.equal(args[allowedIdx + 1], "", "empty tool allow-list (no built-in tools)");
  assert.ok(args.includes("--max-turns=1"));
  assert.ok(args.includes("--output-format=json"));
});

test("buildClaudeArgs: system prompt precedes the user prompt; user prompt is last", () => {
  const args = buildClaudeArgs({ systemPrompt: "SYS", userPrompt: "USR" });
  const sysIdx = args.indexOf("--system-prompt");
  assert.notEqual(sysIdx, -1);
  assert.equal(args[sysIdx + 1], "SYS");
  assert.equal(args[args.length - 1], "USR");
});

test("buildClaudeArgs: omits --system-prompt when none is given; user prompt still last", () => {
  const args = buildClaudeArgs({ userPrompt: "USR" });
  assert.equal(args.includes("--system-prompt"), false);
  assert.equal(args[args.length - 1], "USR");
});

test("the distiller is forked under a re-entry guard so its session does not re-fire the hooks", () => {
  const env = reentryEnv("memory-distill", {});
  assert.equal(env.MEMORY_HOOK_REENTRY, "memory-distill");
  assert.equal(env.CLAUDE_INVOKED_BY, "memory-distill");
});

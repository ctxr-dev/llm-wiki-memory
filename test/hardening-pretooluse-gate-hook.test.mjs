import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_REL = "scripts/hooks/pretooluse-gate-memory-writes.mjs";

function runHook(payload, { rawInput, env } = {}) {
  const input = rawInput !== undefined ? rawInput : JSON.stringify(payload);
  return spawnSync("node", [HOOK_REL], {
    cwd: SRC,
    input,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function makeSettingsYaml(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-hook-settings-"));
  const file = path.join(dir, "settings.yaml");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function parseStdout(stdout) {
  return JSON.parse(stdout);
}

function makeTranscript(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-hook-"));
  const file = path.join(dir, "transcript.jsonl");
  const lines = records.map((r) => JSON.stringify(r)).join("\n");
  fs.writeFileSync(file, lines + "\n", "utf8");
  return { dir, file };
}

function userTurn(text) {
  return { role: "user", content: text };
}

function userTurnArray(text) {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}

test("save_lesson with explicit save phrase in latest user turn -> allow", () => {
  const { file } = makeTranscript([userTurn("save this as a lesson")]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "x", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const out = parseStdout(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
});

test("save_lesson without a save phrase in latest user turn -> ask", () => {
  const { file } = makeTranscript([userTurn("let's continue with the build")]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "x", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0);
  const out = parseStdout(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
});

test("save_to_dataset with dataset=knowledge -> untouched (exit 0, empty stdout)", () => {
  const { file } = makeTranscript([userTurn("save this as a lesson")]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_to_dataset",
    tool_input: { dataset: "knowledge", name: "x.md", text: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "", "untouched: empty stdout");
});

test("save_to_dataset with dataset=self_improvement + save phrase -> allow", () => {
  const { file } = makeTranscript([userTurn("save it")]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_to_dataset",
    tool_input: { dataset: "self_improvement", name: "x.md", text: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0);
  const out = parseStdout(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
});

test("save_to_dataset with dataset=self_improvement + no save phrase -> ask", () => {
  const { file } = makeTranscript([userTurn("keep going with the next step")]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_to_dataset",
    tool_input: { dataset: "self_improvement", name: "x.md", text: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0);
  const out = parseStdout(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
});

test("unrelated tool (Read) -> untouched (exit 0, empty stdout)", () => {
  const res = runHook({
    tool_name: "Read",
    tool_input: { file_path: "/tmp/x" },
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
});

test("malformed JSON stdin -> ask (fail-closed)", () => {
  const res = runHook(null, { rawInput: "{not valid json" });
  assert.equal(res.status, 0);
  const out = parseStdout(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
});

test("missing transcript_path on a gated tool -> ask", () => {
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "x", body: "y" },
  });
  assert.equal(res.status, 0);
  const out = parseStdout(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
});

test("transcript_path points to nonexistent file -> ask", () => {
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "x", body: "y" },
    transcript_path: "/tmp/does-not-exist-lwm-hook-xyz.jsonl",
  });
  assert.equal(res.status, 0);
  const out = parseStdout(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
});

test("transcript with only tool_result-shaped user records (no text) -> ask", () => {
  const { file } = makeTranscript([
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "abc", content: "result data" },
      ],
    },
  ]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "x", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0);
  const out = parseStdout(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
});

test("transcript with multiple user turns: latest has save phrase -> allow", () => {
  const { file } = makeTranscript([
    userTurn("let's get started"),
    { role: "assistant", content: "ok" },
    userTurn("now save this for me"),
  ]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "x", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0);
  const out = parseStdout(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
});

test("transcript with multiple user turns: older has phrase, latest doesn't -> ask", () => {
  const { file } = makeTranscript([
    userTurn("save this as a lesson"),
    { role: "assistant", content: "ok" },
    userTurn("now move on to the next step"),
  ]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "x", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0);
  const out = parseStdout(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
});

test("transcript with user content as array of text blocks is parsed", () => {
  const { file } = makeTranscript([
    userTurnArray("please remember this fact"),
  ]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "x", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0);
  const out = parseStdout(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
});

test("gate.claudeHookEnabled=false -> gated tool untouched (exit 0, empty stdout)", () => {
  const settingsFile = makeSettingsYaml("gate:\n  claudeHookEnabled: false\n");
  const { file } = makeTranscript([userTurn("keep going with the next step")]);
  const res = runHook(
    {
      tool_name: "mcp__llm-wiki-memory__save_lesson",
      tool_input: { title: "x", body: "y" },
      transcript_path: file,
    },
    { env: { MEMORY_SETTINGS_PATH: settingsFile } },
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(res.stdout, "", "disabled hook must behave as if not installed");
});

test("gate.claudeHookEnabled=false -> even malformed stdin is untouched (no ask)", () => {
  const settingsFile = makeSettingsYaml("gate:\n  claudeHookEnabled: false\n");
  const res = runHook(null, {
    rawInput: "{not valid json",
    env: { MEMORY_SETTINGS_PATH: settingsFile },
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(res.stdout, "", "disabled hook is a uniform no-op even on malformed input");
});

test("gate.claudeHookEnabled=true (explicit) -> gated tool still asks without a phrase", () => {
  const settingsFile = makeSettingsYaml("gate:\n  claudeHookEnabled: true\n");
  const { file } = makeTranscript([userTurn("keep going with the next step")]);
  const res = runHook(
    {
      tool_name: "mcp__llm-wiki-memory__save_lesson",
      tool_input: { title: "x", body: "y" },
      transcript_path: file,
    },
    { env: { MEMORY_SETTINGS_PATH: settingsFile } },
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const out = parseStdout(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
});

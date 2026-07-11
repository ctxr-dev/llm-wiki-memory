import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_REL = "scripts/hooks/pretooluse-gate-memory-writes.mjs";

// The hook now appends an L2 audit line via the shared ledger, whose path
// derives from MEMORY_DATA_DIR. Point it at a throwaway dir so the suite never
// touches a real install's state.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-hook-data-"));
process.env.MEMORY_DATA_DIR = TMP_DATA;
// A valid settings.yaml in the temp dir keeps the hook subprocess's settings
// reads off the shared shipped template (which settings.test.mjs transiently
// corrupts under concurrent `npm test`), preventing a latent audit-line flake.
fs.mkdirSync(path.join(TMP_DATA, "settings"), { recursive: true });
fs.writeFileSync(path.join(TMP_DATA, "settings", "settings.yaml"), "embed:\n  backend: lexical\n");
after(() => {
  fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

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

function assistantToolUse(name, input = {}, id = "tu_1") {
  return { role: "assistant", content: [{ type: "tool_use", id, name, input }] };
}

function toolResult(id) {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] };
}

// The REAL Claude Code transcript shape nests under `type` + `message.content`
// (not flat `role`/`content`). Locks the counting matcher to production format.
function nestedUserTurn(text) {
  return { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
}

function nestedAssistantToolUse(name, input = {}, id = "tu_n") {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  };
}

function nestedToolResult(id) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
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
      content: [{ type: "tool_result", tool_use_id: "abc", content: "result data" }],
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
  const { file } = makeTranscript([userTurnArray("please remember this fact")]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "x", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0);
  const out = parseStdout(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
});

test("gate.claudeHookEnabled=false -> gated tool untouched (exit 0, empty stdout, NO audit)", () => {
  const settingsFile = makeSettingsYaml("gate:\n  claudeHookEnabled: false\n");
  const { file } = makeTranscript([userTurn("keep going with the next step")]);
  const log = path.join(TMP_DATA, "state", ".save-gate-audit.log");
  const countL2 = () => {
    try {
      return fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.layer === "L2").length;
    } catch {
      return 0;
    }
  };
  const before = countL2();
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
  assert.equal(
    countL2(),
    before,
    "a disabled hook records NO audit line (untouched() runs before auditL2)",
  );
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

// ─── Per-lesson consent (default ON) ─────────────────────────────────────────

test("per-lesson ON: FIRST gated write in a turn with a save phrase -> allow", () => {
  const { file } = makeTranscript([userTurn("save these lessons please")]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "first", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(parseStdout(res.stdout).hookSpecificOutput.permissionDecision, "allow");
});

test("per-lesson ON: a COMPLETED prior gated write in the same turn -> ask (even with a phrase)", () => {
  // A save phrase already auto-allowed the first lesson; its tool_use + tool_result
  // (completed) sit in the transcript after the user turn, so the next one asks.
  const { file } = makeTranscript([
    userTurn("save these lessons please"),
    assistantToolUse(
      "mcp__llm-wiki-memory__save_lesson",
      { title: "first", body: "y" },
      "tu_first",
    ),
    toolResult("tu_first"),
  ]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "second", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(parseStdout(res.stdout).hookSpecificOutput.permissionDecision, "ask");
});

test("per-lesson ON: NESTED message.content transcript shape is parsed for counting -> ask on 2nd", () => {
  // Guards the counting path against a regression that only handled the flat
  // shape: with the real nested Claude Code records, a COMPLETED prior gated
  // write (tool_use + tool_result) must still force the 2nd write to ask.
  const { file } = makeTranscript([
    nestedUserTurn("save these lessons please"),
    nestedAssistantToolUse(
      "mcp__llm-wiki-memory__save_lesson",
      { title: "first", body: "y" },
      "tu_n1",
    ),
    nestedToolResult("tu_n1"),
  ]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "second", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(parseStdout(res.stdout).hookSpecificOutput.permissionDecision, "ask");
});

test("per-lesson ON: NESTED shape, no completed prior write -> allow (first lesson)", () => {
  // The same nested shape with only the user prose (no prior gated write) must
  // still allow — proving the nested parse isn't over-counting.
  const { file } = makeTranscript([nestedUserTurn("please save this as a lesson")]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "first", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(parseStdout(res.stdout).hookSpecificOutput.permissionDecision, "allow");
});

test("per-lesson ON: a prior gated tool_use with NO tool_result yet does NOT count -> allow", () => {
  // Robustness to transcript timing: if Claude Code has already appended the
  // CURRENT call's tool_use (no result yet), it must not be miscounted as a
  // prior completed write — otherwise the very first lesson would wrongly ask.
  const { file } = makeTranscript([
    userTurn("save these lessons"),
    assistantToolUse(
      "mcp__llm-wiki-memory__save_lesson",
      { title: "pending", body: "y" },
      "tu_pending",
    ),
  ]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "pending", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(parseStdout(res.stdout).hookSpecificOutput.permissionDecision, "allow");
});

test("per-lesson ON: a completed prior PATH-OVERRIDE write (dataset:knowledge + path:self_improvement) counts -> ask", () => {
  // Exercises isGatedSelfImprovementCall's path branch in the counting loop: a
  // prior write smuggled into self_improvement via a path override consumes the
  // turn's approval, so the next gated write must be confirmed.
  const { file } = makeTranscript([
    userTurn("save these lessons"),
    assistantToolUse(
      "mcp__llm-wiki-memory__save_to_dataset",
      { dataset: "knowledge", name: "k.md", path: "self_improvement/x" },
      "tu_path1",
    ),
    toolResult("tu_path1"),
  ]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "next", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(parseStdout(res.stdout).hookSpecificOutput.permissionDecision, "ask");
});

test("per-lesson ON: a completed prior NON-self_improvement write does not consume consent -> allow", () => {
  const { file } = makeTranscript([
    userTurn("save these"),
    assistantToolUse(
      "mcp__llm-wiki-memory__save_to_dataset",
      { dataset: "knowledge", name: "k.md" },
      "tu_k",
    ),
    toolResult("tu_k"),
  ]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "first lesson", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(parseStdout(res.stdout).hookSpecificOutput.permissionDecision, "allow");
});

test("per-lesson ON: a NEW user turn resets the count -> allow again", () => {
  const { file } = makeTranscript([
    userTurn("save these lessons"),
    assistantToolUse(
      "mcp__llm-wiki-memory__save_lesson",
      { title: "first", body: "y" },
      "tu_first",
    ),
    toolResult("tu_first"),
    userTurn("yes, save this next one too"),
  ]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "second", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(parseStdout(res.stdout).hookSpecificOutput.permissionDecision, "allow");
});

test("per-lesson ON: parallel tool_use (2 gated writes, no results) in one message all ride the phrase -> allow (documented limitation)", () => {
  // Locks the KNOWN LIMITATION in analyzeTranscript's comment: completion-keying
  // counts only RESOLVED prior writes, so two unresolved gated tool_use blocks in
  // a single assistant message do not consume consent. A future change to the
  // counting contract (e.g. counting unresolved tool_use) must update this test.
  const { file } = makeTranscript([
    userTurn("save these lessons"),
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "par1",
          name: "mcp__llm-wiki-memory__save_lesson",
          input: { title: "a", body: "y" },
        },
        {
          type: "tool_use",
          id: "par2",
          name: "mcp__llm-wiki-memory__save_lesson",
          input: { title: "b", body: "y" },
        },
      ],
    },
    // No tool_results: both are still in flight (parallel tool use).
  ]);
  const res = runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "c", body: "y" },
    transcript_path: file,
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(parseStdout(res.stdout).hookSpecificOutput.permissionDecision, "allow");
});

test("per-lesson OFF (legacy): a completed prior gated write in the turn with a phrase -> allow", () => {
  const settingsFile = makeSettingsYaml("gate:\n  perLessonConsent: false\n");
  const { file } = makeTranscript([
    userTurn("save these lessons please"),
    assistantToolUse(
      "mcp__llm-wiki-memory__save_lesson",
      { title: "first", body: "y" },
      "tu_first",
    ),
    toolResult("tu_first"),
  ]);
  const res = runHook(
    {
      tool_name: "mcp__llm-wiki-memory__save_lesson",
      tool_input: { title: "second", body: "y" },
      transcript_path: file,
    },
    { env: { MEMORY_SETTINGS_PATH: settingsFile } },
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(parseStdout(res.stdout).hookSpecificOutput.permissionDecision, "allow");
});

test("L2 audit line on allow carries a REDACTED trigger (secret scrubbed on the real hook path)", () => {
  // A secret pasted into the user turn must be scrubbed before it reaches the
  // ledger, proving redaction through the real hook -> recordGatedWrite wiring
  // (not just the unit test against recordGatedWrite directly).
  const token = "ghp_" + "A".repeat(25);
  const { file } = makeTranscript([userTurn(`save this as a lesson ${token}`)]);
  runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "x", body: "y" },
    transcript_path: file,
  });
  const log = path.join(TMP_DATA, "state", ".save-gate-audit.log");
  const raw = fs.readFileSync(log, "utf8");
  assert.ok(!raw.includes(token), "the raw secret in the trigger must NOT reach disk");
  // The ledger is shared across the suite, so match THIS turn's record by its
  // redacted token (an earlier test's allow record has no token).
  const l2 = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find(
      (r) =>
        r.layer === "L2" && r.status === "allow" && (r.trigger || "").includes("ghp_[REDACTED]"),
    );
  assert.ok(l2, "an L2 allow record with the scrubbed secret is written");
  assert.ok(l2.trigger.includes("save this as a lesson"), "the non-secret phrase is recorded");
  assert.ok(!l2.trigger.includes(token), "no raw token in the recorded trigger");
});

test("L2 audit records an 'ask' decision (no save phrase) via the real hook path", () => {
  // auditL2 runs for BOTH branches; an 'ask' must also reach the ledger, with no
  // trigger phrase. The ledger is shared+never-reset, so count the L2/ask records
  // BEFORE and AFTER and assert exactly one NEW one is attributable to THIS call
  // (a plain .find() could match an earlier test's identical record).
  const log = path.join(TMP_DATA, "state", ".save-gate-audit.log");
  const l2Asks = () => {
    try {
      return fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.layer === "L2" && r.status === "ask" && r.tool === "save_lesson");
    } catch {
      return [];
    }
  };
  const before = l2Asks().length;
  const { file } = makeTranscript([userTurn("let's keep building the feature")]);
  runHook({
    tool_name: "mcp__llm-wiki-memory__save_lesson",
    tool_input: { title: "x", body: "y" },
    transcript_path: file,
  });
  const after = l2Asks();
  assert.equal(after.length, before + 1, "exactly one NEW L2 ask record was appended by this call");
  assert.equal(
    after[after.length - 1].trigger,
    undefined,
    "an ask record carries no trigger phrase",
  );
});

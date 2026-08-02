import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC } from "./harness.mjs";

const HOOK = "scripts/hooks/pretooluse-deny-client-memory-path.mjs";

function runHook(payload, { raw } = {}) {
  const input = raw !== undefined ? raw : JSON.stringify(payload);
  return spawnSync("node", [HOOK], {
    cwd: SRC,
    input,
    encoding: "utf8",
  });
}

function parseDecision(stdout) {
  const obj = JSON.parse(stdout);
  return obj?.hookSpecificOutput;
}

test("Write into ~/.claude/projects/<ws>/memory/ denies", () => {
  const target = path.join(os.homedir(), ".claude", "projects", "test-ws", "memory", "test.md");
  const r = runHook({
    tool_name: "Write",
    tool_input: { file_path: target },
  });
  assert.equal(r.status, 0, `exit 0 (stderr=${r.stderr})`);
  const decision = parseDecision(r.stdout);
  assert.equal(decision.hookEventName, "PreToolUse");
  assert.equal(decision.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, /memory-path-deny/);
});

test("Write into ~/.claude/projects/<ws>/some-other-dir/ falls through untouched", () => {
  const target = path.join(
    os.homedir(),
    ".claude",
    "projects",
    "test-ws",
    "some-other-dir",
    "foo.md",
  );
  const r = runHook({
    tool_name: "Write",
    tool_input: { file_path: target },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("Edit on the same memory path denies", () => {
  const target = path.join(os.homedir(), ".claude", "projects", "test-ws", "memory", "note.md");
  const r = runHook({
    tool_name: "Edit",
    tool_input: { file_path: target },
  });
  assert.equal(r.status, 0);
  const decision = parseDecision(r.stdout);
  assert.equal(decision.permissionDecision, "deny");
});

test("NotebookEdit with notebook_path under memory/ denies", () => {
  const target = path.join(os.homedir(), ".claude", "projects", "X", "memory", "notebook.ipynb");
  const r = runHook({
    tool_name: "NotebookEdit",
    tool_input: { notebook_path: target },
  });
  assert.equal(r.status, 0);
  const decision = parseDecision(r.stdout);
  assert.equal(decision.permissionDecision, "deny");
});

test("Unrelated tool (Read) on a memory path falls through untouched", () => {
  const target = path.join(os.homedir(), ".claude", "projects", "test-ws", "memory", "test.md");
  const r = runHook({
    tool_name: "Read",
    tool_input: { file_path: target },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("Tilde-prefixed file_path is expanded and matched", () => {
  const target = "~/.claude/projects/test-ws/memory/tilde.md";
  const r = runHook({
    tool_name: "Write",
    tool_input: { file_path: target },
  });
  assert.equal(r.status, 0);
  const decision = parseDecision(r.stdout);
  assert.equal(decision.permissionDecision, "deny");
});

test("Missing file_path falls through untouched", () => {
  const r = runHook({
    tool_name: "Write",
    tool_input: {},
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("Non-string file_path falls through untouched", () => {
  const r = runHook({
    tool_name: "Write",
    tool_input: { file_path: 42 },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("Malformed JSON stdin fails open (untouched)", () => {
  const r = runHook(null, { raw: "{not valid json" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

// ─── engine-written state/ is agent-write-denied ─────────────────────────────
// The migration ledger decides whether bootstrap SKIPS a migration, so a
// hand-edited value there is a silent correctness bug. The same holds for the
// embed/consolidate throttles and the consent audit ledger, hence a directory
// rule rather than a per-file one.

const STATE_FILES = [
  ".migrations.json",
  ".embed-warm.json",
  ".embed-gc.json",
  ".consolidate.json",
  ".save-gate-audit.log",
];

test("Write/Edit/NotebookEdit into <home>/.llm-wiki-memory/state/ denies", () => {
  for (const tool of ["Write", "Edit", "NotebookEdit"]) {
    for (const name of STATE_FILES) {
      const target = path.join(os.homedir(), ".llm-wiki-memory", "state", name);
      const key = tool === "NotebookEdit" ? "notebook_path" : "file_path";
      const r = runHook({ tool_name: tool, tool_input: { [key]: target } });
      assert.equal(r.status, 0);
      const decision = parseDecision(r.stdout);
      assert.equal(decision.permissionDecision, "deny", `${tool} -> ${name}`);
      assert.match(decision.permissionDecisionReason, /memory-state-deny/);
    }
  }
});

test("the state-deny reason points at the CLI, and says reading is fine", () => {
  const target = path.join(os.homedir(), ".llm-wiki-memory", "state", ".migrations.json");
  const r = runHook({ tool_name: "Write", tool_input: { file_path: target } });
  const reason = parseDecision(r.stdout).permissionDecisionReason;
  assert.match(reason, /cli\.mjs migrations/, "names the supported command");
  assert.match(reason, /Reading these files is fine/, "does not block diagnosis");
});

test("a nested path under state/ is denied too (directory rule, not a file list)", () => {
  const target = path.join(os.homedir(), ".llm-wiki-memory", "state", "logs", "anything.log");
  const r = runHook({ tool_name: "Write", tool_input: { file_path: target } });
  assert.equal(parseDecision(r.stdout).permissionDecision, "deny");
});

test("the WIKI itself is NOT denied — only state/ is engine-written", () => {
  // Editing a leaf by file is sanctioned for large non-gated docs (rule 21), so
  // this hook must not creep into that.
  const target = path.join(os.homedir(), ".llm-wiki-memory", "wiki", "knowledge", "a.md");
  const r = runHook({ tool_name: "Write", tool_input: { file_path: target } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "", "falls through untouched");
});

test("a same-named state/ dir OUTSIDE any llm-wiki-memory tree is untouched", () => {
  const r = runHook({
    tool_name: "Write",
    tool_input: { file_path: path.join(os.homedir(), "someproject", "state", "x.json") },
  });
  assert.equal(r.stdout.trim(), "", "unrelated state dirs are none of our business");
});

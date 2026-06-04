import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setupWorkspace, cleanup, SRC } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const MOCK_RESPONSE = JSON.stringify({
  atoms: [
    {
      type: "self-improvement-lesson",
      title: "redistill-test-atom",
      body: "Mock atom from cli-redistill test.",
      tags: ["redistill"],
      metadata: {
        area: "testing",
        task_type: "investigation",
        error_pattern: "redistill",
      },
    },
  ],
});

const CLI = path.join(SRC, "scripts/cli.mjs");

const flush = await import("../scripts/hooks/flush.mjs");

function runCli(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      ...env,
      MEMORY_LLM_PROVIDER: "mock",
      MEMORY_LLM_MOCK_RESPONSE: MOCK_RESPONSE,
      MEMORY_DATA_DIR: dataDir,
    },
    encoding: "utf8",
  });
}

function makeSource(sessionId, body) {
  return { sessionId, cwd: dataDir, hookEvent: "PostCompact", body, turnCount: 4, capturedAtMs: Date.now() - 1_000 };
}

test("redistill: no args prints usage and exits 64", () => {
  const r = runCli(["redistill"]);
  assert.equal(r.status, 64, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /usage:.*redistill/i);
});

test("redistill --all on empty STATE_DIR reports 'nothing to process' and exits 0", () => {
  // Ensure no leftover stashes from earlier tests.
  const stateDir = path.join(dataDir, "state");
  if (fs.existsSync(stateDir)) {
    for (const f of fs.readdirSync(stateDir)) {
      if (f.startsWith("failed-distill-")) fs.rmSync(path.join(stateDir, f), { force: true });
    }
  }
  const r = runCli(["redistill", "--all"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.redistilled, 0);
});

test("redistill --session <id> resolves the right stash and rewrites the leaf", async () => {
  const sid = "cli-redistill-session-x";
  const source = makeSource(sid, "### User\n\nhello\n\n### Assistant\n\nworld");
  flush.writeFailedDistillStash({
    source,
    errors: [{ provider: "claude", model: null, error: "claude timed out" }],
    sessionId: sid,
  });

  const r = runCli(["redistill", "--session", sid]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.redistilled, 1);
  assert.equal(parsed.total, 1);
  assert.equal(parsed.results[0].audit.original_outcome, "distillation-failed");
});

test("redistill --leaf <path> uses the leaf's session_id frontmatter to find the stash", async () => {
  const sid = "cli-redistill-leaf-y";
  const source = makeSource(sid, "### User\n\nfoo\n\n### Assistant\n\nbar");
  flush.writeFailedDistillStash({
    source,
    errors: [],
    sessionId: sid,
  });

  // Synthesise a fake leaf with the session_id in the frontmatter.
  const leafPath = path.join(dataDir, "fake-failed-leaf.md");
  fs.writeFileSync(
    leafPath,
    `---\nfocus: x\n---\n\n# Daily flush PostCompact\n\n- captured_at_utc: 2026-06-02T00:00:00Z\n- hook_event: PostCompact\n- session_id: ${sid}\n- outcome: distillation-failed\n`,
  );

  const r = runCli(["redistill", "--leaf", leafPath]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.redistilled, 1);
});

test("redistill --leaf: missing leaf path exits 2 with clear error", () => {
  const r = runCli(["redistill", "--leaf", "/tmp/does-not-exist.md"]);
  assert.equal(r.status, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /not found/i);
});

test("redistill --leaf: a DIRECTORY exits 2 with a clean error (no EISDIR crash)", () => {
  // --leaf pointed at a dir must not throw an unhandled EISDIR; it must emit
  // a JSON error and exit 2 like the not-found path.
  const r = runCli(["redistill", "--leaf", dataDir]);
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /could not read leaf/i);
});

test("redistill --session: no matching stash exits 2 with clear error", () => {
  const r = runCli(["redistill", "--session", "no-such-session-zzz"]);
  assert.equal(r.status, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /no stash/i);
});

test("redistill --all sweeps every pending stash", async () => {
  // Two stashes; both should be processed.
  for (const sid of ["all-sweep-a", "all-sweep-b"]) {
    const source = makeSource(sid, "### User\n\nx\n\n### Assistant\n\ny");
    flush.writeFailedDistillStash({ source, errors: [], sessionId: sid });
  }
  const r = runCli(["redistill", "--all"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.redistilled >= 2, `expected to redistill at least 2, got ${parsed.redistilled}`);
});

// Pins the compile exit-code contract around LLM-provider availability:
//   - work pending + no provider reachable -> exit 69 (EX_UNAVAILABLE)
//   - nothing to promote                   -> exit 0 (no provider needed)
//   - work pending + provider answering    -> exit 0 (promotion proceeds)
//   - session-start hook stays exit 0 regardless (detached compile spawn)

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup, runScript } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const { renderDailyDocument } = await import("../scripts/hooks/flush.mjs");
const store = await import("../scripts/lib/wiki-store.mjs");

const ATOM = {
  type: "decision",
  title: "Use exit codes for provider failures",
  body: "Use exit codes for provider failures. Why: observability. How to apply: exit 69 on abort.",
  tags: ["infra", "cron"],
  metadata: { project_module: "testproj", task_type: "implementation" },
};

let seedCounter = 0;
function seedDaily() {
  seedCounter += 1;
  const name = `daily-2026-06-04-10000000${seedCounter}.md`;
  const text = renderDailyDocument({
    atoms: [ATOM],
    source: {
      sessionId: `seed-${seedCounter}`,
      cwd: "/tmp/proj",
      hookEvent: "session-end",
      capturedAtMs: Date.parse("2026-06-04T10:00:00Z"),
      body: "seed transcript body",
    },
  });
  return store.saveDocument({ name, text, datasetId: "daily" });
}

function listActiveDailies() {
  return store.listDocuments({ prefix: "daily-", enabled: "true", datasetId: "daily" }).documents;
}

test("no dailies + no provider -> exit 0 (nothing to do is not a failure)", () => {
  assert.equal(listActiveDailies().length, 0);
  const r = runScript("scripts/cli.mjs", ["compile", "--force"], {
    env: { MEMORY_LLM_PROVIDER: "mock", MEMORY_LLM_MOCK_RESPONSE: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no enabled daily-\* docs to promote/);
});

test("work pending + providers unavailable -> exit 69 with the documented abort line", () => {
  seedDaily();
  const r = runScript("scripts/cli.mjs", ["compile", "--force"], {
    env: { MEMORY_LLM_PROVIDER: "mock", MEMORY_LLM_MOCK_RESPONSE: "" },
  });
  assert.equal(r.status, 69, `expected EX_UNAVAILABLE, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /found \d+ daily doc\(s\) to promote/);
  assert.match(r.stderr, /compile\.mjs: aborting \(LLMProviderUnavailable\)/);
  assert.ok(listActiveDailies().length > 0, "daily stays queued for the next attempt");
});

test("work pending + provider answering -> exit 0 and the daily is promoted", () => {
  assert.ok(listActiveDailies().length > 0, "queued daily from the previous test");
  const r = runScript("scripts/cli.mjs", ["compile", "--force"], {
    env: {
      MEMORY_LLM_PROVIDER: "mock",
      MEMORY_LLM_MOCK_RESPONSE: JSON.stringify({ action: "create", reason: "test-recovery" }),
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /promoted \d+ daily doc\(s\)/);
  assert.equal(listActiveDailies().length, 0, "queue drained after recovery");
});

test("session-start hook exits 0 even when its detached compile would exit 69", () => {
  seedDaily();
  const r = runScript("scripts/hooks/session-start.mjs", [], {
    stdin: "{}",
    env: { MEMORY_LLM_PROVIDER: "mock", MEMORY_LLM_MOCK_RESPONSE: "" },
  });
  assert.equal(r.status, 0, `hook exit 0: ${r.stderr}`);
});

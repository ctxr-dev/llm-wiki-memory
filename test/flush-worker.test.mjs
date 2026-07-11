import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup, runScript } from "./harness.mjs";

// Hermetic integration test of the detached flush worker. The hook front
// (scripts/hooks/flush.mjs <mode>) stages context and spawns a DETACHED worker,
// then returns; the worker distils (mock provider) and writes the daily leaf
// out-of-band. We assert by polling the store until the worker has written the
// daily AND released its session lock (so a worker failure surfaces as a
// timeout whose message includes the .flush.log breadcrumb, not a hang).
const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const flushLog = path.join(dataDir, "state", ".flush.log");
function logTail() {
  try {
    return fs.readFileSync(flushLog, "utf8");
  } catch {
    return "(no .flush.log yet)";
  }
}

function findDailyForSession(sid) {
  const docs = store.listDocuments({
    prefix: "daily-",
    enabled: "true",
    datasetId: "daily",
  }).documents;
  for (const d of docs) {
    const { text } = store.readDocument({ documentId: d.id, datasetId: "daily" });
    if (text.includes(`session_id: ${sid}`)) return { id: d.id, text };
  }
  return null;
}

// Session ids used here are simple, so this mirrors flush.mjs:flushLockPath.
function flushLockPathFor(sid) {
  const safe = String(sid || "manual")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 80);
  return path.join(dataDir, "state", `.flush-${safe}.lock`);
}

async function waitForWorker(sid, timeoutMs = 20000) {
  const lock = flushLockPathFor(sid);
  const start = Date.now();
  for (;;) {
    const hit = findDailyForSession(sid);
    if (hit && !fs.existsSync(lock)) return hit;
    // Hard fail on timeout: returning the hit while the lock still exists would
    // let a leaked lock (or a never-finished worker) pass silently.
    if (Date.now() - start > timeoutMs) return null;
    await sleep(50);
  }
}

function writeTranscript(name, turns) {
  const file = path.join(dataDir, name);
  const lines = turns.map((t) =>
    JSON.stringify({
      type: t.role,
      message: { role: t.role, content: [{ type: "text", text: t.text }] },
    }),
  );
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

function runFront(sessionId, transcriptPath, env) {
  const hookInput = JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    hook_event_name: "SessionEnd",
    cwd: dataDir,
  });
  return runScript("scripts/hooks/flush.mjs", ["session-end"], {
    stdin: hookInput,
    // Clear inherited guards so the front runs (it skips when reentrant).
    env: { MEMORY_HOOK_REENTRY: "", CLAUDE_INVOKED_BY: "", ...env },
  });
}

const TURNS = [
  { role: "user", text: "Use feature flags for risky rollouts." },
  { role: "assistant", text: "Agreed; wrap new endpoints in a flag." },
];
const ATOM = {
  type: "decision",
  title: "Use feature flags for risky rollouts",
  body: "Use feature flags for risky rollouts. Why: limit blast radius. How to apply: wrap new endpoints.",
  tags: ["infra", "rollout"],
  metadata: { project_module: "testproj", language: "", task_type: "deploy" },
};

test("front exits 0 immediately and the detached worker writes a distilled daily", async () => {
  const t = writeTranscript("w-atoms.jsonl", TURNS);
  const r = runFront("w-atoms", t, {
    MEMORY_LLM_PROVIDER: "mock",
    MEMORY_LLM_MOCK_RESPONSE: JSON.stringify({ atoms: [ATOM] }),
    MEMORY_FLUSH_DISTILL_ATTEMPTS: "1",
  });
  assert.equal(r.status, 0, `front exit 0: ${r.stderr}`);
  const hit = await waitForWorker("w-atoms");
  assert.ok(hit, `worker wrote a daily; flush.log:\n${logTail()}`);
  assert.match(hit.text, /- outcome: distilled/);
  assert.match(hit.text, /### Atom · decision · Use feature flags/);
});

test("a clean empty distillation writes NO leaf (nothing to save → nothing on disk; breadcrumb only)", async () => {
  const t = writeTranscript("w-nothing.jsonl", TURNS);
  const r = runFront("w-nothing", t, {
    MEMORY_LLM_PROVIDER: "mock",
    MEMORY_LLM_MOCK_RESPONSE: JSON.stringify({ atoms: [] }),
    MEMORY_FLUSH_DISTILL_ATTEMPTS: "1",
  });
  assert.equal(r.status, 0, `front exit 0: ${r.stderr}`);
  // Detached worker — poll the breadcrumb directly. A flush-and-release
  // can finish faster than a 50 ms lock-file poll, so checking lock
  // existence is racy; the breadcrumb append is the durable signal.
  const start = Date.now();
  let saw = false;
  while (Date.now() - start < 20_000) {
    if (/nothing-durable \(no leaf written\)/.test(logTail())) {
      saw = true;
      break;
    }
    await sleep(50);
  }
  assert.ok(saw, `expected nothing-durable breadcrumb; got:\n${logTail()}`);
  const hit = findDailyForSession("w-nothing");
  assert.equal(hit, null, "no daily leaf should be written for a nothing-durable distillation");
});

test("a distiller error, after retries, falls back to the truncated raw context", async () => {
  const t = writeTranscript("w-error.jsonl", TURNS);
  // mock provider with no MOCK_RESPONSE -> mockResponse() throws every attempt.
  const r = runFront("w-error", t, {
    MEMORY_LLM_PROVIDER: "mock",
    MEMORY_FLUSH_DISTILL_ATTEMPTS: "2",
    MEMORY_FLUSH_DISTILL_RETRY_MS: "1",
  });
  assert.equal(r.status, 0, `front exit 0: ${r.stderr}`);
  const hit = await waitForWorker("w-error");
  assert.ok(hit, `raw fallback written; flush.log:\n${logTail()}`);
  assert.match(hit.text, /- outcome: distillation-failed/);
  assert.match(hit.text, /BEGIN UNTRUSTED MEMORY BODY/);
});

test("a rejected flush slot falls back to the daily category instead of losing the write", async () => {
  const t = writeTranscript("w-slot.jsonl", TURNS);
  const r = runFront("w-slot", t, {
    MEMORY_LLM_PROVIDER: "mock",
    MEMORY_LLM_MOCK_RESPONSE: JSON.stringify({ atoms: [ATOM] }),
    MEMORY_FLUSH_DISTILL_ATTEMPTS: "1",
    MEMORY_FLUSH_SLOT: "bogus-not-a-category",
  });
  assert.equal(r.status, 0, `front exit 0: ${r.stderr}`);
  // The bogus slot is rejected by writeMemory; the worker retries against daily,
  // so the distilled doc still lands (and is findable in the daily category).
  const hit = await waitForWorker("w-slot");
  assert.ok(hit, `daily written via fallback; flush.log:\n${logTail()}`);
  assert.match(hit.text, /- outcome: distilled/);
});

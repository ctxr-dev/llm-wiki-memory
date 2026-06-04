import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

// Map-reduce + recovery unit tests. The dispatcher's `mock` provider returns
// a canned JSON response, so we can drive distillByChunks deterministically
// from a synthesised source.body without spawning the worker as a subprocess.

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const MOCK_RESPONSE = JSON.stringify({
  atoms: [
    {
      type: "self-improvement-lesson",
      title: "lesson-from-mock",
      body: "Mock distiller produced a single recurring atom.",
      tags: ["mock", "test"],
      metadata: {
        area: "testing",
        task_type: "investigation",
        error_pattern: "mock-pattern",
      },
    },
  ],
});

// Force the env into a deterministic single-provider chain so test runs
// don't depend on host PATH or API keys.
process.env.MEMORY_LLM_PROVIDER = "mock";
process.env.MEMORY_LLM_MOCK_RESPONSE = MOCK_RESPONSE;

const flush = await import("../scripts/hooks/flush.mjs");
const store = await import("../scripts/lib/wiki-store.mjs");
const llm = await import("../scripts/lib/llm.mjs");
const chunker = await import("../scripts/lib/chunker.mjs");
const settings = await import("../scripts/lib/settings.mjs");

function makeTranscript(turnCount, charsPerTurn) {
  const parts = [];
  for (let i = 0; i < turnCount; i++) {
    const role = i % 2 === 0 ? "User" : "Assistant";
    parts.push(`### ${role}\n\n${"x".repeat(charsPerTurn)}`);
  }
  return parts.join("\n\n");
}

function makeSource(body) {
  return {
    sessionId: `unit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    cwd: dataDir,
    hookEvent: "PostCompact",
    body,
    turnCount: 10,
    capturedAtMs: Date.now() - 1_000,
  };
}

test("writeFailedDistillStash: persists owner-only stash with full body + audit", () => {
  const source = makeSource("### User\n\nhello\n\n### Assistant\n\nworld");
  const stashPath = flush.writeFailedDistillStash({
    source,
    errors: [{ provider: "anthropic", model: "fixture-m", error: "boom" }],
    sessionId: source.sessionId,
    audit: { chunks_total: 1, chunks_succeeded: 0, failed_chunks: [0] },
  });
  assert.ok(stashPath, "stash file should be returned");
  assert.ok(fs.existsSync(stashPath), `stash should exist at ${stashPath}`);
  const json = JSON.parse(fs.readFileSync(stashPath, "utf8"));
  assert.equal(json.source.body, source.body);
  assert.equal(json.errors[0].provider, "anthropic");
  assert.equal(json.audit.chunks_total, 1);
  assert.equal(json.redistill_attempts, 0);
  // 0600 mode on POSIX hosts.
  const mode = fs.statSync(stashPath).mode & 0o777;
  assert.equal(mode, 0o600, `stash should be owner-only, got ${mode.toString(8)}`);
  fs.rmSync(stashPath, { force: true });
});

test("listFailedDistillStashes + findStashForSession resolve newest stash by id", () => {
  const sessA = "unit-listing-a";
  const sessB = "unit-listing-b";
  const a1 = flush.writeFailedDistillStash({ source: makeSource("a1"), errors: [], sessionId: sessA });
  // ensure timestamp ordering by waiting a millisecond (Date.now() rolls forward fast enough)
  const b1 = flush.writeFailedDistillStash({ source: makeSource("b1"), errors: [], sessionId: sessB });
  const a2 = flush.writeFailedDistillStash({ source: makeSource("a2"), errors: [], sessionId: sessA });
  const all = flush.listFailedDistillStashes();
  assert.ok(all.includes(a1));
  assert.ok(all.includes(a2));
  assert.ok(all.includes(b1));
  // findStashForSession returns the newest for that session id.
  const newestA = flush.findStashForSession(sessA);
  assert.ok(newestA === a1 || newestA === a2, "newest should be one of the two stashes");
  // Cleanup.
  for (const p of [a1, a2, b1]) fs.rmSync(p, { force: true });
});

test("redistillFromStash: synthesised stash gets re-distilled, leaf overwrites with audit breadcrumb, stash deleted", async () => {
  const body = makeTranscript(4, 200);
  const source = makeSource(body);
  // Synthesise a stash exactly as flushSession's failure path would.
  const stashPath = flush.writeFailedDistillStash({
    source,
    errors: [{ provider: "claude", model: null, error: "claude timed out after 120000ms" }],
    sessionId: source.sessionId,
    audit: { chunks_total: 1, chunks_succeeded: 0, failed_chunks: [0], failure_reasons: [] },
  });

  const result = await flush.redistillFromStash(stashPath, { tag: "unit-redistill" });
  assert.ok(result?.audit, "redistill should return an audit object");
  assert.equal(result.audit.original_outcome, "distillation-failed");
  assert.equal(result.audit.redistill_attempts, 1);
  assert.ok(result.audit.redistilled_from, "should record redistilled_from timestamp");

  // Stash should be deleted on success.
  assert.equal(fs.existsSync(stashPath), false, "stash should be removed after successful redistill");

  // Leaf is now in the daily slot with the canned atom.
  const docs = store.listDocuments({ prefix: "daily-", enabled: "true", datasetId: "daily" }).documents;
  let leafText = "";
  for (const d of docs) {
    const { text } = store.readDocument({ documentId: d.id, datasetId: "daily" });
    if (text.includes(source.sessionId)) {
      leafText = text;
      break;
    }
  }
  assert.ok(leafText.length > 0, "redistilled leaf should be in the daily slot");
  assert.ok(/redistilled_from:/.test(leafText), "leaf frontmatter should carry redistilled_from breadcrumb");
  assert.ok(/redistill_attempts: 1/.test(leafText), "leaf should record redistill_attempts: 1");
  assert.ok(/original_outcome: distillation-failed/.test(leafText), "leaf should record original_outcome");
  assert.ok(/lesson-from-mock/.test(leafText), "leaf should contain the redistilled atom");
});

test("redistillFromStash: missing stash path throws clearly", async () => {
  await assert.rejects(
    () => flush.redistillFromStash("/tmp/does-not-exist-stash.json"),
    /stash file not found/i,
  );
});

test("redistillFromStash: malformed stash (no source.body) throws", async () => {
  const malformed = path.join(dataDir, "state", "failed-distill-malformed-1.json");
  fs.mkdirSync(path.dirname(malformed), { recursive: true });
  fs.writeFileSync(malformed, JSON.stringify({ source: { capturedAtMs: 1 } }), { mode: 0o600 });
  await assert.rejects(() => flush.redistillFromStash(malformed), /malformed stash/i);
  fs.rmSync(malformed, { force: true });
});

test("distillByChunks: bounded-parallelism pool processes every chunk exactly once with one failing chunk", async (t) => {
  const chunkTargetK = 3;
  const parallelism = 3;
  // Body large enough that ceil(len / targetK) clears the 4000-char chunk
  // floor, so the chunker actually splits into multiple chunks rather than
  // collapsing to the single-pass fast path.
  const body = makeTranscript(12, 1500);

  const chunks = chunker.chunkSource(body, { targetK: chunkTargetK });
  assert.ok(chunks.length >= 3, `body should split into >=3 chunks, got ${chunks.length}`);
  const chunkCount = chunks.length;

  const failChunkIndex = 1;

  settings.__setSettingsOverride({
    flush: { chunkParallelism: parallelism, chunkTargetK, distillAttempts: 1 },
  });
  // The mock fail-index counter is process-global and earlier tests advanced
  // it; reset so MEMORY_LLM_MOCK_FAIL_INDICES is relative to this test's first
  // call. With distillAttempts=1 and parallelism >= chunkCount, the pool
  // dispatches chunk i to mock-call index i, so failing index 1 fails exactly
  // the middle chunk; the reduce step's call lands at index chunkCount.
  llm.__resetMockCallIndex();
  const prevFailIndices = process.env.MEMORY_LLM_MOCK_FAIL_INDICES;
  const prevFailError = process.env.MEMORY_LLM_MOCK_FAIL_ERROR;
  process.env.MEMORY_LLM_MOCK_FAIL_INDICES = String(failChunkIndex);
  process.env.MEMORY_LLM_MOCK_FAIL_ERROR = "model_not_found: forced-chunk-fail";
  t.after(() => {
    settings.__clearSettingsOverride();
    llm.__resetMockCallIndex();
    if (prevFailIndices != null) process.env.MEMORY_LLM_MOCK_FAIL_INDICES = prevFailIndices;
    else delete process.env.MEMORY_LLM_MOCK_FAIL_INDICES;
    if (prevFailError != null) process.env.MEMORY_LLM_MOCK_FAIL_ERROR = prevFailError;
    else delete process.env.MEMORY_LLM_MOCK_FAIL_ERROR;
  });

  const source = makeSource(body);
  const stashPath = flush.writeFailedDistillStash({
    source,
    errors: [{ provider: "claude", model: null, error: "claude timed out" }],
    sessionId: source.sessionId,
    audit: { chunks_total: chunkCount, chunks_succeeded: 0, failed_chunks: [] },
  });

  const result = await flush.redistillFromStash(stashPath, { tag: "unit-chunk-pool" });
  const audit = result.audit;

  assert.equal(audit.chunks_total, chunkCount, "every chunk should be counted");
  // Exactly-once partition: the shared cursor must neither skip a chunk
  // (succeeded + failed < total) nor double-dispatch one (succeeded + failed >
  // total, or a duplicate index in failed_chunks).
  assert.equal(
    audit.chunks_succeeded + audit.failed_chunks.length,
    chunkCount,
    "succeeded + failed must partition the chunk set exactly",
  );
  assert.equal(audit.chunks_succeeded, chunkCount - 1, "all but the one failing chunk should succeed");
  assert.deepEqual(audit.failed_chunks, [failChunkIndex], "exactly the targeted chunk should fail, once");

  // The surviving good chunks' atoms reach the written leaf.
  assert.ok(result.written, "a leaf should be written when some chunks succeed");
  const docs = store.listDocuments({ prefix: "daily-", enabled: "true", datasetId: "daily" }).documents;
  let leafText = "";
  for (const d of docs) {
    const { text } = store.readDocument({ documentId: d.id, datasetId: "daily" });
    if (text.includes(source.sessionId)) {
      leafText = text;
      break;
    }
  }
  assert.ok(leafText.length > 0, "redistilled leaf should be in the daily slot");
  assert.ok(/lesson-from-mock/.test(leafText), "surviving atoms from the good chunks should be present");
  assert.ok(new RegExp(`chunks_succeeded: ${chunkCount - 1}`).test(leafText), "leaf audit should record the succeeded count");
  assert.ok(new RegExp(`failed_chunks: \\[${failChunkIndex}\\]`).test(leafText), "leaf audit should record the single failed chunk");
});

test("redistillFromStash: distill failure preserves stash with incremented attempt counter", async (t) => {
  // Force a distill failure by switching to a provider with no API key.
  const prev = process.env.MEMORY_LLM_PROVIDER;
  const prevMock = process.env.MEMORY_LLM_MOCK_RESPONSE;
  process.env.MEMORY_LLM_PROVIDER = "anthropic";
  delete process.env.MEMORY_LLM_MOCK_RESPONSE;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_MODEL = "fixture-m";
  t.after(() => {
    process.env.MEMORY_LLM_PROVIDER = prev;
    if (prevMock != null) process.env.MEMORY_LLM_MOCK_RESPONSE = prevMock;
    delete process.env.ANTHROPIC_MODEL;
  });

  const source = makeSource("### User\n\nbody\n\n### Assistant\n\nresp");
  const stashPath = flush.writeFailedDistillStash({
    source,
    errors: [{ provider: "claude", model: null, error: "claude timed out" }],
    sessionId: source.sessionId,
  });

  let caught;
  try {
    await flush.redistillFromStash(stashPath);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "redistill against a dead provider should throw");
  assert.ok(fs.existsSync(stashPath), "stash should be preserved on failure");
  const json = JSON.parse(fs.readFileSync(stashPath, "utf8"));
  assert.equal(json.redistill_attempts, 1, "attempt counter should advance after a failure");
  assert.ok(json.last_attempt_at_utc, "last_attempt_at_utc should be stamped");
  fs.rmSync(stashPath, { force: true });
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const MOCK_RESPONSE = JSON.stringify({
  atoms: [
    {
      type: "self-improvement-lesson",
      title: "gap-test-atom",
      body: "Atom from the gap-test mock.",
      tags: ["gap"],
      metadata: { area: "testing", task_type: "investigation", error_pattern: "gap" },
    },
  ],
});

process.env.MEMORY_LLM_PROVIDER = "mock";
process.env.MEMORY_LLM_MOCK_RESPONSE = MOCK_RESPONSE;

const llm = await import("../scripts/lib/llm.mjs");
const flush = await import("../scripts/hooks/flush.mjs");
const store = await import("../scripts/lib/wiki-store.mjs");
const { __setSettingsForTest, __clearSettingsForTest } =
  await import("../scripts/lib/settings.mjs");

function makeSource(sessionId, body) {
  return {
    sessionId,
    cwd: dataDir,
    hookEvent: "PostCompact",
    body,
    turnCount: 4,
    capturedAtMs: Date.now() - 1_000,
  };
}

function makeTranscript(turnCount, charsPerTurn) {
  const parts = [];
  for (let i = 0; i < turnCount; i++) {
    const role = i % 2 === 0 ? "User" : "Assistant";
    parts.push(`### ${role}\n\n${"x".repeat(charsPerTurn)}`);
  }
  return parts.join("\n\n");
}

// ─── looksLikeModelNotFound matrix ────────────────────────────────────────

test("looksLikeModelNotFound: matches every documented signal", () => {
  const positives = [
    "model_not_found: claude-x",
    "not_found_error: foo",
    "Model does not exist for this account",
    "invalid_model: gpt-99",
    "Model not found: anthropic.something",
    "Unknown model 'gpt-3.5-turbo-1106-2024-doesntexist'",
    "This model has been decommissioned and is no longer available",
    "deprecated_model: gpt-4-old",
  ];
  for (const msg of positives) {
    assert.equal(llm.looksLikeModelNotFound(new Error(msg)), true, `should match: ${msg}`);
  }
});

test("looksLikeModelNotFound: rejects unrelated errors (timeouts, auth, network)", () => {
  const negatives = [
    "claude timed out after 120000ms",
    "ANTHROPIC_API_KEY not set",
    "ECONNREFUSED connecting to api.openai.com",
    "Internal server error: 500",
    "fetch failed",
    "rate limited (429)",
  ];
  for (const msg of negatives) {
    assert.equal(llm.looksLikeModelNotFound(new Error(msg)), false, `should NOT match: ${msg}`);
  }
});

test("looksLikeModelNotFound: null / undefined / non-Error inputs return false", () => {
  assert.equal(llm.looksLikeModelNotFound(null), false);
  assert.equal(llm.looksLikeModelNotFound(undefined), false);
  assert.equal(llm.looksLikeModelNotFound({}), false);
  assert.equal(llm.looksLikeModelNotFound("plain string with no signals"), false);
});

// ─── Partial-chunk failure embeds raw text in the leaf body ───────────────

test("partial-chunk-failure: failed chunk's raw text lands in the leaf body, frontmatter records failed_chunks", async (t) => {
  // Build a body that the chunker will split into at least 3 chunks.
  __setSettingsForTest({ flush: { chunkTargetK: 3, distillAttempts: 1, distillRetryMs: 10 } });
  // Fail mock call index 1 (second call = second chunk).
  process.env.MEMORY_LLM_MOCK_FAIL_INDICES = "1";
  process.env.MEMORY_LLM_MOCK_FAIL_ERROR = "claude timed out";
  llm.__resetMockCallIndex();
  t.after(() => {
    __clearSettingsForTest();
    delete process.env.MEMORY_LLM_MOCK_FAIL_INDICES;
    delete process.env.MEMORY_LLM_MOCK_FAIL_ERROR;
    llm.__resetMockCallIndex();
  });

  const sessionId = "partial-failure-x";
  const source = makeSource(sessionId, makeTranscript(12, 2000));
  // Synthesise a stash and run redistill against it (uses the same flow as
  // the live worker without spawning a subprocess).
  const stashPath = flush.writeFailedDistillStash({ source, errors: [], sessionId });

  const result = await flush.redistillFromStash(stashPath, { tag: "partial-failure" });

  // At least one chunk failed (the second mock call), at least one succeeded.
  assert.ok(
    result.audit.failed_chunks.length >= 1,
    `expected ≥1 failed chunk, got ${JSON.stringify(result.audit.failed_chunks)}`,
  );
  assert.ok(result.audit.chunks_succeeded >= 1, `expected ≥1 succeeded chunk`);

  // Read the rewritten leaf and check the failed-chunk embed is present.
  const docs = store.listDocuments({
    prefix: "daily-",
    enabled: "true",
    datasetId: "daily",
  }).documents;
  let leafText = "";
  for (const d of docs) {
    const { text } = store.readDocument({ documentId: d.id, datasetId: "daily" });
    if (text.includes(`session_id: ${sessionId}`)) {
      leafText = text;
      break;
    }
  }
  assert.ok(leafText.length > 0, "leaf should exist");
  assert.match(leafText, /failed_chunks:/);
  assert.match(leafText, /BEGIN UNTRUSTED CHUNK/);
  assert.match(leafText, /END UNTRUSTED CHUNK/);
});

// ─── Tree-reduce recursion ────────────────────────────────────────────────

test("tree-reduce: when joined atoms exceed reduce_max_chars, the reducer recurses", async (t) => {
  // Force tree-reduce: a 200-char cap will be exceeded as soon as we
  // have more than a couple of atoms.
  __setSettingsForTest({
    flush: { chunkTargetK: 8, reduceMaxChars: 200, distillAttempts: 1, distillRetryMs: 10 },
  });
  llm.__resetMockCallIndex();
  t.after(() => {
    __clearSettingsForTest();
    llm.__resetMockCallIndex();
  });

  const sessionId = "tree-reduce-y";
  const body = makeTranscript(16, 2000);
  const source = makeSource(sessionId, body);
  const stashPath = flush.writeFailedDistillStash({ source, errors: [], sessionId });

  // The tree-reduce path should complete without throwing.
  const result = await flush.redistillFromStash(stashPath, { tag: "tree-reduce" });
  assert.ok(result.audit.chunks_total >= 2, "expected multi-chunk run");
  assert.equal(result.audit.chunks_succeeded, result.audit.chunks_total);
  // Atoms survive the tree-reduce (mock always returns the canned atom; the
  // recursive merge collapses duplicates back to a small set).
  const docs = store.listDocuments({
    prefix: "daily-",
    enabled: "true",
    datasetId: "daily",
  }).documents;
  let atomCount = 0;
  for (const d of docs) {
    const { text } = store.readDocument({ documentId: d.id, datasetId: "daily" });
    if (text.includes(`session_id: ${sessionId}`)) {
      const m = text.match(/^- atom_count: (\d+)$/m);
      atomCount = m ? Number(m[1]) : 0;
      break;
    }
  }
  assert.ok(atomCount >= 1, `expected ≥1 atom after tree-reduce, got ${atomCount}`);
});

// ─── Concurrent redistill races a live worker via the session lock ────────

test("redistill lock: a held session lock blocks redistillFromStash with ESESSIONBUSY", async () => {
  const { acquireLock } = await import("../scripts/lib/lock.mjs");
  const sessionId = "lock-busy-z";
  const source = makeSource(sessionId, "### User\n\nfoo\n\n### Assistant\n\nbar");
  const stashPath = flush.writeFailedDistillStash({ source, errors: [], sessionId });

  // Hold the lock as if a live flush worker were processing the same session.
  const lockPath = path.join(dataDir, "state", `.flush-${sessionId}.lock`);
  const heldLock = acquireLock(lockPath, { staleMs: 60_000, label: "test-holder" });
  assert.equal(heldLock.ok, true, "test should acquire the lock");

  let caught;
  try {
    await flush.redistillFromStash(stashPath, { tag: "race" });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "redistill should refuse when the session lock is held");
  assert.equal(caught.code, "ESESSIONBUSY");
  assert.match(caught.message, /busy/i);
  // Stash MUST remain — otherwise the operator loses recovery data when
  // the live worker doesn't itself produce an atom (e.g. another timeout).
  assert.ok(fs.existsSync(stashPath), "stash must be preserved on lock contention");

  heldLock.release();
  // Now redistill succeeds.
  const result = await flush.redistillFromStash(stashPath, { tag: "race-after-release" });
  assert.equal(result.audit.original_outcome, "distillation-failed");
  assert.equal(fs.existsSync(stashPath), false, "stash deleted after successful redistill");
});

// ─── Depth cap: adversarial LLM that returns input unchanged terminates ──

test("reduce depth cap: an LLM that echoes input back unchanged still terminates via deterministic dedup", async (t) => {
  // Mock provider returns enough DISTINCT atoms to keep the joined-input
  // size above the reduce cap even after dedup. Without the depth cap or
  // the joined-length sanity check, the original bug would have recursed
  // forever. With the protections in place, the depth cap (or the "did
  // not shrink" check) routes through deterministic dedup and returns.
  const ECHOING_RESPONSE = JSON.stringify({
    atoms: Array.from({ length: 8 }, (_, i) => ({
      type: "self-improvement-lesson",
      title: `echo-atom-${i}-${"x".repeat(150)}`,
      body: "Padding so the serialized atom list always exceeds the cap.",
      tags: ["echo"],
      metadata: { area: "testing", task_type: "investigation", error_pattern: `echo-${i}` },
    })),
  });
  const prevResp = process.env.MEMORY_LLM_MOCK_RESPONSE;
  process.env.MEMORY_LLM_MOCK_RESPONSE = ECHOING_RESPONSE;
  __setSettingsForTest({
    flush: { chunkTargetK: 4, reduceMaxChars: 200, distillAttempts: 1, distillRetryMs: 10 },
  });
  llm.__resetMockCallIndex();
  t.after(() => {
    process.env.MEMORY_LLM_MOCK_RESPONSE = prevResp;
    __clearSettingsForTest();
    llm.__resetMockCallIndex();
  });

  const sessionId = "depth-cap-v";
  const body = makeTranscript(8, 2000);
  const source = makeSource(sessionId, body);
  const stashPath = flush.writeFailedDistillStash({ source, errors: [], sessionId });

  // The test passes if and only if redistillFromStash returns at all —
  // an infinite-recursion regression would hang the test and fill /tmp.
  // node --test's per-test timeout (configurable) will surface the hang
  // as a test failure rather than a silent system stall.
  const before = Date.now();
  const result = await flush.redistillFromStash(stashPath, { tag: "depth-cap" });
  const elapsed = Date.now() - before;

  assert.ok(elapsed < 15_000, `reduce should terminate quickly, took ${elapsed}ms`);
  assert.ok(Array.isArray(result.audit.failed_chunks));
  // Atoms preserved — depth cap / shrink check falls back to deterministic
  // dedup, never drops atoms.
  const docs = store.listDocuments({
    prefix: "daily-",
    enabled: "true",
    datasetId: "daily",
  }).documents;
  let atomCount = 0;
  for (const d of docs) {
    const { text } = store.readDocument({ documentId: d.id, datasetId: "daily" });
    if (text.includes(`session_id: ${sessionId}`)) {
      const m = text.match(/^- atom_count: (\d+)$/m);
      atomCount = m ? Number(m[1]) : 0;
      break;
    }
  }
  assert.ok(atomCount >= 1, `expected ≥1 atom after depth-capped reduce, got ${atomCount}`);
});

// ─── Depth cap, driven directly: at the cap, dedup short-circuits the LLM ─

test("reduceMerge: at REDUCE_MAX_DEPTH it returns deterministicDedup(atoms) without calling the LLM", async (t) => {
  // Seed the mock with a sentinel atom. If reduceMerge reached callLLMChain on
  // the cap path, this atom would appear in the result. Asserting its absence
  // proves the depth cap short-circuited to deterministic dedup before any LLM
  // round-trip. The cap does NOT throw — it falls through to deterministic
  // dedup, preserving the atoms already collected.
  const SENTINEL_TITLE = "sentinel-from-llm-should-never-appear";
  const SENTINEL_RESPONSE = JSON.stringify({
    atoms: [
      {
        type: "self-improvement-lesson",
        title: SENTINEL_TITLE,
        body: "If this atom shows up, the cap path called the LLM.",
        tags: ["sentinel"],
        metadata: { area: "testing", task_type: "investigation", error_pattern: "sentinel" },
      },
    ],
  });
  const prevResp = process.env.MEMORY_LLM_MOCK_RESPONSE;
  process.env.MEMORY_LLM_MOCK_RESPONSE = SENTINEL_RESPONSE;
  llm.__resetMockCallIndex();
  t.after(() => {
    process.env.MEMORY_LLM_MOCK_RESPONSE = prevResp;
    llm.__resetMockCallIndex();
  });

  const atoms = [
    {
      type: "self-improvement-lesson",
      title: "alpha",
      body: "first",
      tags: [],
      metadata: { error_pattern: "ep-a" },
    },
    {
      type: "self-improvement-lesson",
      title: "alpha",
      body: "duplicate of first",
      tags: [],
      metadata: { error_pattern: "ep-a" },
    },
    {
      type: "self-improvement-lesson",
      title: "beta",
      body: "second",
      tags: [],
      metadata: { error_pattern: "ep-b" },
    },
  ];

  const result = await flush.reduceMerge({
    atoms,
    tag: "cap-direct",
    attempts: 1,
    retryMs: 0,
    systemPrompt: "s",
    baseHeader: "",
    sourceProvenances: [],
    depth: flush.REDUCE_MAX_DEPTH,
  });

  assert.deepEqual(result, flush.deterministicDedup(atoms));
  // The duplicate (same type|title|error_pattern as "alpha") collapsed.
  assert.equal(result.length, 2, `expected 2 atoms after dedup, got ${result.length}`);
  assert.ok(
    !result.some((a) => a.title === SENTINEL_TITLE),
    "sentinel atom must be absent — the cap path must not invoke the LLM",
  );
});

// ─── Stash filename collision: rapid serial writes never overwrite ───────

test("writeFailedDistillStash: rapid serial writes for same session+ms produce unique files", () => {
  const sessionId = "collision-w";
  const source = makeSource(sessionId, "body");
  const paths = [];
  for (let i = 0; i < 5; i++) {
    const p = flush.writeFailedDistillStash({ source, errors: [], sessionId });
    paths.push(p);
  }
  const unique = new Set(paths);
  assert.equal(
    unique.size,
    paths.length,
    `every write should produce a unique path; got ${paths.join(", ")}`,
  );
  // Cleanup.
  for (const p of paths) fs.rmSync(p, { force: true });
});

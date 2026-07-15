import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup, runScript } from "./harness.mjs";

// Edge cases from the capture-pipeline gap matrix: chunker boundary safety,
// stash recovery corners, and degenerate inputs. Mock provider, no real LLM.

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const MOCK_RESPONSE = JSON.stringify({
  atoms: [
    {
      type: "self-improvement-lesson",
      title: "edge-case-atom",
      body: "Atom produced by the mock distiller in the edge-case suite.",
      tags: ["mock", "edge"],
      metadata: { area: "testing", task_type: "investigation", error_pattern: "edge-pattern" },
    },
  ],
});
process.env.MEMORY_LLM_PROVIDER = "mock";
process.env.MEMORY_LLM_MOCK_RESPONSE = MOCK_RESPONSE;

const flush = await import("../scripts/hooks/flush.mjs");
const llm = await import("../scripts/lib/llm.mjs");
const { chunkTranscript, computeChunkSize, __testing } = await import("../scripts/lib/chunker.mjs");

const STATE_DIR = path.join(dataDir, "state");
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function makeSource(body, sessionId) {
  return {
    sessionId,
    cwd: dataDir,
    hookEvent: "PostCompact",
    body,
    turnCount: 10,
    capturedAtMs: Date.now() - 1_000,
  };
}

test("hard cut never splits a UTF-16 surrogate pair (lossless reassembly, no lone surrogates)", () => {
  const body = "🙂".repeat(3_000); // 6000 UTF-16 units, no headers, no paragraph breaks
  const chunks = chunkTranscript(body, { chunkSize: 4_001 }); // odd size: lands mid-pair without the guard
  assert.ok(chunks.length >= 2, "body actually chunked");
  for (const c of chunks) {
    assert.ok(c.text.length > 0, "no empty chunk");
    assert.equal(
      LONE_SURROGATE_RE.test(c.text),
      false,
      `chunk ${c.index} carries a lone surrogate`,
    );
  }
  assert.equal(chunks.map((c) => c.text).join(""), body, "reassembly is lossless");
});

test("surrogateSafe shifts only a mid-pair position", () => {
  const body = "a🙂b";
  assert.equal(__testing.surrogateSafe(body, 2), 3, "between hi and lo surrogate → shifted");
  assert.equal(__testing.surrogateSafe(body, 1), 1, "before the pair → untouched");
  assert.equal(__testing.surrogateSafe(body, 3), 3, "after the pair → untouched");
});

test("computeChunkSize guards degenerate inputs (Infinity/NaN/zero/negative/huge)", () => {
  const floor = __testing.MIN_CHUNK_FLOOR;
  assert.equal(computeChunkSize(10_000, Infinity), 10_000, "Infinity targetK coerces to 1");
  assert.equal(computeChunkSize(10_000, NaN), 10_000);
  assert.equal(computeChunkSize(10_000, 0), 10_000);
  assert.equal(computeChunkSize(10_000, -5), 10_000);
  assert.equal(computeChunkSize(Infinity, 5), floor, "non-finite body length → floor");
  const huge = computeChunkSize(Number.MAX_SAFE_INTEGER, 3);
  assert.ok(Number.isFinite(huge) && huge >= floor, "no overflow on MAX_SAFE_INTEGER");
});

test("body exactly at MIN_CHUNK_FLOOR stays a single chunk; one char over hard-cuts losslessly", () => {
  const atFloor = "a".repeat(__testing.MIN_CHUNK_FLOOR);
  assert.equal(chunkTranscript(atFloor, { chunkSize: __testing.MIN_CHUNK_FLOOR }).length, 1);
  const over = "a".repeat(__testing.MIN_CHUNK_FLOOR + 1);
  const chunks = chunkTranscript(over, { chunkSize: __testing.MIN_CHUNK_FLOOR });
  assert.equal(chunks.length, 2);
  assert.equal(chunks.map((c) => c.text).join(""), over);
});

test("header at position 0 only: chunking advances, no empty chunk, lossless", () => {
  const body = `### User\n\n${"x".repeat(9_000)}`;
  const chunks = chunkTranscript(body, { chunkSize: 4_000 });
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.text.length > 0);
  assert.equal(chunks.map((c) => c.text).join(""), body);
});

test("only column-0 headers match; any leading space disarms the header anchor", () => {
  for (const [indent, expectMatch] of [
    ["", true],
    [" ", false],
    ["  ", false],
    ["   ", false],
    ["    ", false],
    ["     ", false],
  ]) {
    const body = `intro line\n${indent}### User\nrest`;
    const pos = __testing.findNextHeaderAt(body, 0);
    if (expectMatch) assert.notEqual(pos, -1, `indent ${JSON.stringify(indent)} should match`);
    else assert.equal(pos, -1, `indent ${JSON.stringify(indent)} must NOT match`);
  }
});

test("a column-0 '### User' inside a code fence DOES match (chunker is fence-unaware by design)", () => {
  // Documented behaviour, not a bug: the raw-fallback path indents embedded
  // transcript content by 4 spaces precisely so this anchor cannot fire; a
  // fence in ordinary content may still be cut at — splitting a fence across
  // chunks degrades gracefully (each chunk is distilled separately).
  const body = "intro\n\n```\n### User\nfenced\n```\nrest";
  assert.notEqual(__testing.findNextHeaderAt(body, 0), -1);
});

test("multiple stashes for one session: findStashForSession picks the newest by timestamp", () => {
  const sessionId = "newest-wins-session";
  const src = makeSource("some failed body", sessionId);
  const first = flush.writeFailedDistillStash({
    source: src,
    errors: [{ index: 0, error: "boom" }],
    sessionId,
  });
  // Force a later millisecond timestamp on the second stash.
  const later = flush.writeFailedDistillStash({
    source: src,
    errors: [{ index: 0, error: "boom-2" }],
    sessionId,
  });
  assert.ok(first && later && first !== later, "two distinct stash files");
  const tsOf = (p) => Number.parseInt(path.basename(p).split("-").at(-2), 10);
  const expected = tsOf(later) >= tsOf(first) ? later : first;
  assert.equal(flush.findStashForSession(sessionId), expected, "newest stash wins");
});

test(
  "stash write failure: no throw, falsy return (double-failure path stays survivable)",
  {
    skip:
      process.platform === "win32" &&
      "POSIX file-mode/permission semantics not emulable on Windows",
  },
  () => {
    fs.chmodSync(STATE_DIR, 0o555);
    try {
      const out = flush.writeFailedDistillStash({
        source: makeSource("body that cannot be stashed", "unwritable-session"),
        errors: [{ index: 0, error: "boom" }],
        sessionId: "unwritable-session",
      });
      assert.ok(!out, "returns falsy instead of throwing when the state dir is unwritable");
    } finally {
      fs.chmodSync(STATE_DIR, 0o755);
    }
  },
);

test("redistill of a whitespace-only body does not crash", async () => {
  const sessionId = "whitespace-body-session";
  const stash = flush.writeFailedDistillStash({
    source: makeSource("   \n\n  ", sessionId),
    errors: [{ index: 0, error: "original failure" }],
    sessionId,
  });
  assert.ok(stash);
  llm.__resetMockCallIndex();
  const out = await flush.redistillFromStash(stash, { tag: "edge-whitespace" });
  assert.ok(out && typeof out.outcome === "string", "returns a structured outcome");
  assert.equal(fs.existsSync(stash), false, "stash resolved (success or clean nothing-durable)");
});

test("redistill with all-empty atoms: nothing-durable, no leaf, stash cleared", async () => {
  const sessionId = "empty-atoms-session";
  const stash = flush.writeFailedDistillStash({
    source: makeSource(`### User\n\n${"y".repeat(500)}`, sessionId),
    errors: [{ index: 0, error: "original failure" }],
    sessionId,
  });
  const prev = process.env.MEMORY_LLM_MOCK_RESPONSE;
  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({ atoms: [] });
  try {
    llm.__resetMockCallIndex();
    const out = await flush.redistillFromStash(stash, { tag: "edge-empty-atoms" });
    assert.equal(out.written, false, "no leaf written");
    assert.match(out.outcome, /no atoms .*stash cleared/, "clean nothing-durable outcome");
    assert.equal(fs.existsSync(stash), false, "stash cleared");
  } finally {
    process.env.MEMORY_LLM_MOCK_RESPONSE = prev;
  }
});

test("failed redistill increments the stash attempt counter on every retry (audit stacking)", async () => {
  const sessionId = "stacking-session";
  const stash = flush.writeFailedDistillStash({
    source: makeSource("body that keeps failing", sessionId),
    errors: [{ index: 0, error: "original failure" }],
    sessionId,
  });
  const prevFail = process.env.MEMORY_LLM_MOCK_FAIL_INDICES;
  const prevErr = process.env.MEMORY_LLM_MOCK_FAIL_ERROR;
  process.env.MEMORY_LLM_MOCK_FAIL_INDICES = "0,1,2,3,4,5,6,7,8,9,10,11";
  process.env.MEMORY_LLM_MOCK_FAIL_ERROR = "still broken";
  try {
    for (const expected of [1, 2]) {
      llm.__resetMockCallIndex();
      await assert.rejects(() => flush.redistillFromStash(stash, { tag: "edge-stacking" }));
      const json = JSON.parse(fs.readFileSync(stash, "utf8"));
      assert.equal(json.redistill_attempts, expected, `attempt counter incremented to ${expected}`);
      assert.equal(
        json.source.body,
        "body that keeps failing",
        "source body preserved verbatim across retries",
      );
      assert.ok(json.last_error, "last_error recorded");
    }
  } finally {
    if (prevFail === undefined) delete process.env.MEMORY_LLM_MOCK_FAIL_INDICES;
    else process.env.MEMORY_LLM_MOCK_FAIL_INDICES = prevFail;
    if (prevErr === undefined) delete process.env.MEMORY_LLM_MOCK_FAIL_ERROR;
    else process.env.MEMORY_LLM_MOCK_FAIL_ERROR = prevErr;
  }
});

test("cli redistill --all quarantines a corrupt stash and still processes the valid one", async () => {
  const sessionId = "sweep-valid-session";
  const valid = flush.writeFailedDistillStash({
    source: makeSource(`### User\n\n${"z".repeat(300)}`, sessionId),
    errors: [{ index: 0, error: "original failure" }],
    sessionId,
  });
  const corrupt = path.join(STATE_DIR, `failed-distill-corrupt-${Date.now()}.json`);
  fs.writeFileSync(corrupt, "{this is not json", { mode: 0o600 });

  llm.__resetMockCallIndex();
  const r = runScript("scripts/cli.mjs", ["redistill", "--all"]);
  assert.ok(
    fs.existsSync(`${corrupt}.corrupt`),
    `corrupt stash quarantined (stdout: ${r.stdout} stderr: ${r.stderr})`,
  );
  assert.equal(fs.existsSync(corrupt), false, "corrupt original renamed away");
  assert.equal(fs.existsSync(valid), false, "valid stash processed and cleared by the sweep");
});

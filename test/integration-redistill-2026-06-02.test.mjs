import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

// Reproducer for the 2026-06-02 distillation-failed incident.
//
// On that day, the post-compact daily leaf at
// `wiki/daily/2026/06/02/daily-2026-06-02-081314342.md` was written with
// outcome=distillation-failed because every claude CLI attempt timed out at
// 120 s, and the previous fallback path silently truncated the redacted
// transcript to the last 8 000 chars — dropping ~72 K of context.
//
// This test proves the recovery story end-to-end:
//   1. Synthesise a stash containing the FULL original-style transcript body
//      (the real leaf only has the last-8 K window, so we reconstruct a
//      realistic ~80 K body from that fragment by repetition + padding).
//   2. Run `redistillFromStash` against the mock provider (canned atoms).
//   3. Assert the new leaf carries:
//      - atoms (atom_count > 0)
//      - audit breadcrumb: redistilled_from, redistill_attempts, original_outcome
//      - chunks_total / chunks_succeeded reflect the map-reduce flow
//      - failed_chunks is empty (mock provider always succeeds)
//   4. The stash file is deleted on success.

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const MOCK_RESPONSE = JSON.stringify({
  atoms: [
    {
      type: "self-improvement-lesson",
      title: "recovered-from-2026-06-02",
      body: "Recovered atom from the integration reproducer.",
      tags: ["recovery", "integration"],
      metadata: {
        area: "daily-distillation",
        task_type: "investigation",
        error_pattern: "claude-timeout",
      },
    },
  ],
});

process.env.MEMORY_LLM_PROVIDER = "mock";
process.env.MEMORY_LLM_MOCK_RESPONSE = MOCK_RESPONSE;
// Force map-reduce: chunk a synthesised ~80 K body into ~5 pieces.
const flush = await import("../scripts/hooks/flush.mjs");
const store = await import("../scripts/lib/wiki-store.mjs");
const { __setSettingsForTest } = await import("../scripts/lib/settings.mjs");
__setSettingsForTest({ flush: { chunkTargetK: 5 } });

// Build a realistic redacted-style transcript ~80 K chars long with `### User`
// / `### Assistant` headers so the chunker has real turn boundaries.
function buildRealisticBody({ turnCount = 40, charsPerTurn = 2000 } = {}) {
  const parts = [];
  for (let i = 0; i < turnCount; i++) {
    const role = i % 2 === 0 ? "User" : "Assistant";
    const filler = `Turn-${i}-content: ` + "x".repeat(charsPerTurn - 16);
    parts.push(`### ${role}\n\n${filler}`);
  }
  return parts.join("\n\n");
}

test("integration: 2026-06-02 reproducer — redistill recovers atoms via map-reduce over a chunked body", async () => {
  const sessionId = "incident-2026-06-02-repro";
  const capturedAtMs = Date.parse("2026-06-02T08:13:14.342Z");
  assert.ok(Number.isFinite(capturedAtMs), "fixture timestamp should parse");

  const body = buildRealisticBody({ turnCount: 40, charsPerTurn: 2000 });
  assert.ok(body.length >= 80_000, `synthesised body should be ≥ 80K chars, got ${body.length}`);

  const source = {
    sessionId,
    cwd: dataDir,
    hookEvent: "PostCompact",
    body,
    turnCount: 40,
    capturedAtMs,
  };

  // Synthesise the same kind of stash the new flush path writes when every
  // chunk fails (the historical-incident equivalent).
  const stashPath = flush.writeFailedDistillStash({
    source,
    errors: [
      { provider: "claude", model: null, error: "claude timed out after 120000ms" },
      { provider: "claude", model: null, error: "claude timed out after 120000ms" },
      { provider: "claude", model: null, error: "claude timed out after 120000ms" },
    ],
    sessionId,
    audit: {
      chunks_total: 1,
      chunks_succeeded: 0,
      failed_chunks: [0],
      provider_chain_tried: ["claude:(default)"],
      final_provider: null,
      failure_reasons: [],
    },
  });
  assert.ok(fs.existsSync(stashPath), `stash should be written at ${stashPath}`);

  const result = await flush.redistillFromStash(stashPath, { tag: "integration-2026-06-02" });

  // Audit breadcrumb shape.
  assert.equal(result.audit.original_outcome, "distillation-failed");
  assert.equal(result.audit.redistill_attempts, 1);
  assert.ok(result.audit.redistilled_from, "redistilled_from timestamp should be stamped");
  assert.equal(result.audit.redistilled_from, new Date(capturedAtMs).toISOString());
  // Map-reduce ran: chunks_total >= 2.
  assert.ok(result.audit.chunks_total >= 2, `expected map-reduce (chunks_total >= 2), got ${result.audit.chunks_total}`);
  assert.equal(result.audit.chunks_succeeded, result.audit.chunks_total, "every chunk should succeed against mock provider");
  assert.deepEqual(result.audit.failed_chunks, []);

  // Stash deleted on success.
  assert.equal(fs.existsSync(stashPath), false, "stash should be removed after a successful redistill");

  // Daily leaf has the recovered atom + audit fields in frontmatter.
  const docs = store.listDocuments({ prefix: "daily-", enabled: "true", datasetId: "daily" }).documents;
  let leafText = "";
  for (const d of docs) {
    const { text } = store.readDocument({ documentId: d.id, datasetId: "daily" });
    if (text.includes(`session_id: ${sessionId}`)) {
      leafText = text;
      break;
    }
  }
  assert.ok(leafText.length > 0, "redistilled daily leaf should be in the store");
  assert.ok(/redistilled_from:/.test(leafText), "leaf frontmatter should record redistilled_from");
  assert.ok(/redistill_attempts: 1/.test(leafText), "leaf should record redistill_attempts: 1");
  assert.ok(/original_outcome: distillation-failed/.test(leafText), "leaf should record original_outcome");
  assert.ok(/chunks_total: \d+/.test(leafText), "leaf should record chunks_total");
  assert.ok(/recovered-from-2026-06-02/.test(leafText), "leaf should contain the recovered atom title");
  // Atom count from the header line; the mock returns one atom per chunk and
  // the reduce step preserves them. Just assert > 0.
  const atomCountMatch = leafText.match(/^- atom_count: (\d+)$/m);
  assert.ok(atomCountMatch, "leaf should declare an atom_count");
  assert.ok(Number(atomCountMatch[1]) >= 1, `atom_count should be ≥ 1, got ${atomCountMatch[1]}`);
});

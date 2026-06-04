import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeChunkSize,
  chunkTranscript,
  chunkSource,
  __testing,
} from "../scripts/lib/chunker.mjs";

const { MIN_CHUNK_FLOOR } = __testing;

function makeTurns(n, charsPerTurn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const role = i % 2 === 0 ? "User" : "Assistant";
    const filler = "x".repeat(charsPerTurn);
    out.push(`### ${role}\n\n${filler}`);
  }
  return out.join("\n\n");
}

test("computeChunkSize: standard case rounds up to fit target K", () => {
  assert.equal(computeChunkSize(100_000, 5), 20_000);
  assert.equal(computeChunkSize(80_000, 5), 16_000);
});

test("computeChunkSize: tiny body still gets minimum floor", () => {
  assert.equal(computeChunkSize(1_000, 5), MIN_CHUNK_FLOOR);
  assert.equal(computeChunkSize(0, 5), MIN_CHUNK_FLOOR);
});

test("computeChunkSize: degenerate inputs coerce to safe values", () => {
  assert.equal(computeChunkSize(-100, 5), MIN_CHUNK_FLOOR);
  assert.equal(computeChunkSize(20_000, 0), Math.max(MIN_CHUNK_FLOOR, 20_000)); // K=0 collapses to 1 -> single chunk
  assert.equal(computeChunkSize(NaN, NaN), MIN_CHUNK_FLOOR);
});

test("chunkTranscript: empty body returns empty array", () => {
  assert.deepEqual(chunkTranscript(""), []);
  assert.deepEqual(chunkTranscript(null), []);
});

test("chunkTranscript: short body returns single chunk equal to body", () => {
  const body = "### User\n\nhello\n\n### Assistant\n\nworld";
  const chunks = chunkTranscript(body, { chunkSize: 10_000 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, body);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[0].end, body.length);
});

test("chunkTranscript: body just above chunk size splits at the next turn header", () => {
  // Turn 1: 2000 chars; Turn 2: 2000 chars. chunkSize 2500 -> after the
  // first 2000 chars + header overhead the cursor is past the cap, so the
  // cut should fall at the start of Turn 2's header.
  const turn1 = `### User\n\n${"a".repeat(2000)}`;
  const turn2 = `### Assistant\n\n${"b".repeat(2000)}`;
  const body = `${turn1}\n\n${turn2}`;
  const chunks = chunkTranscript(body, { chunkSize: 2500 });
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].text.startsWith("### User"));
  assert.ok(chunks[1].text.startsWith("### Assistant"));
  // Reassembly is lossless.
  assert.equal(chunks[0].text + chunks[1].text, body);
});

test("chunkTranscript: many turns -> chunk count matches expectation", () => {
  // 10 turns × 2000 chars filler each + headers ≈ 20k+ chars total.
  const body = makeTurns(10, 2000);
  const chunks = chunkTranscript(body, { chunkSize: 5_000 });
  // Each chunk ≥ 5K and ends at a turn boundary; expect ~4 chunks (give
  // or take one depending on how headers align).
  assert.ok(chunks.length >= 3 && chunks.length <= 6, `expected 3-6 chunks, got ${chunks.length}`);
  // Reassembly is lossless.
  assert.equal(chunks.map((c) => c.text).join(""), body);
  // Every chunk except possibly the last starts on a turn header.
  for (let i = 0; i < chunks.length - 1; i++) {
    assert.ok(/^### (User|Assistant)/.test(chunks[i].text), `chunk ${i} should start on a header`);
  }
});

test("chunkTranscript: body with NO turn headers but WITH paragraph breaks splits on paragraphs", () => {
  // Simulates a post-compact-summary body: numbered bullets / paragraphs
  // separated by blank lines, no `### Role` headers. The chunker should
  // cut on paragraph boundaries so the LLM doesn't receive an oversized
  // single blob (which it would likely reject with prose-not-JSON).
  const paragraph = "x".repeat(4_000);
  const body = Array.from({ length: 6 }, () => paragraph).join("\n\n");
  const chunks = chunkTranscript(body, { chunkSize: 8_000 });
  assert.ok(chunks.length >= 2, `expected paragraph-based chunking, got ${chunks.length} chunks`);
  // Reassembly is lossless.
  assert.equal(chunks.map((c) => c.text).join(""), body);
  // No chunk is dramatically larger than the cap (paragraph boundaries
  // approximate the cap; first chunk may include a single paragraph that
  // overshoots, but never by more than one paragraph).
  for (const c of chunks) {
    assert.ok(c.text.length <= 10_000, `chunk ${c.index} should be ≤ ~cap, got ${c.text.length}`);
  }
});

test("chunkTranscript: body with NO turn headers AND NO paragraph breaks hard-cuts at the target", () => {
  // A single giant prose blob with no structural boundaries at all. We
  // cannot preserve semantics, but we still must chunk — never submit one
  // oversized blob that risks LLMOutputInvalid.
  const body = "x".repeat(50_000);
  const chunks = chunkTranscript(body, { chunkSize: 10_000 });
  assert.ok(chunks.length >= 3, `expected hard-cut chunking, got ${chunks.length} chunks`);
  assert.equal(chunks.map((c) => c.text).join(""), body);
  // Each non-final chunk is exactly chunkSize.
  for (let i = 0; i < chunks.length - 1; i++) {
    assert.equal(chunks[i].text.length, 10_000, `chunk ${i} should be exactly chunkSize`);
  }
});

test("chunkTranscript: literal '### User' inside indented content (transcript fenced fallback) does not double-split", () => {
  // The raw-fallback path prefixes every line with 4 spaces, so an embedded
  // `### User` in there appears as `    ### User`. The chunker's regex is
  // anchored on line-start `^### ...` so it must NOT match the indented
  // string.
  const body =
    `### User\n\n${"a".repeat(3_000)}\n\n    ### User\n\n${"b".repeat(3_000)}\n\n### Assistant\n\n${"c".repeat(3_000)}`;
  const chunks = chunkTranscript(body, { chunkSize: 4_000 });
  // 4K cap, only 2 real headers: User at 0, Assistant somewhere mid-body.
  // The indented "    ### User" must not act as a boundary.
  for (const chunk of chunks) {
    const trimmedHead = chunk.text.replace(/^\s+/, "").slice(0, 8);
    if (chunk.index > 0) {
      assert.ok(trimmedHead.startsWith("### "), `non-first chunk should start with a header, got: ${chunk.text.slice(0, 40)}`);
    }
  }
  assert.equal(chunks.map((c) => c.text).join(""), body);
});

test("chunkTranscript: body of exactly chunkSize returns single chunk", () => {
  const body = "a".repeat(10_000);
  const chunks = chunkTranscript(body, { chunkSize: 10_000 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text.length, 10_000);
});

test("chunkTranscript: zero chunkSize coerces to floor; behaviour is deterministic", () => {
  // Defensive: malicious env override shouldn't infinite-loop.
  const body = "### User\n\n" + "a".repeat(20_000);
  const chunks = chunkTranscript(body, { chunkSize: 0 });
  assert.ok(chunks.length >= 1);
  assert.equal(chunks.map((c) => c.text).join(""), body);
});

test("chunkSource: delegates to chunkTranscript with computed size", () => {
  const body = makeTurns(8, 3_000);
  const chunks = chunkSource(body, { targetK: 4 });
  assert.ok(chunks.length >= 2);
  // Reassembly is lossless.
  assert.equal(chunks.map((c) => c.text).join(""), body);
});

test("chunkSource: empty body returns empty array", () => {
  assert.deepEqual(chunkSource(""), []);
});

test("findNextHeaderAt: returns -1 past EOF", () => {
  const body = "### User\n\nhello";
  assert.equal(__testing.findNextHeaderAt(body, body.length + 10), -1);
});

test("findPrevParagraphBreak: finds the nearest \\n\\n at or before position", () => {
  const body = "para1\n\npara2\n\npara3";
  assert.equal(__testing.findPrevParagraphBreak(body, body.length), body.lastIndexOf("\n\n") + 2);
  assert.equal(__testing.findPrevParagraphBreak("no-breaks-here", 5), -1);
});

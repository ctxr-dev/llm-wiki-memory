import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampSearchResponse,
  SEARCH_PER_HIT_CHARS,
  SEARCH_TOTAL_BUDGET,
} from "../scripts/lib/search-clamp.mjs";

const big = (n) => "word ".repeat(Math.ceil(n / 5)).slice(0, n);
const rec = (id, len, score = 0.9) => ({
  documentId: id,
  documentName: id,
  score,
  content: big(len),
});

test("per-hit cap clips an oversized body and annotates it", () => {
  const out = clampSearchResponse({ records: [rec("a", 5000)] });
  const r = out.records[0];
  assert.ok(r.content.length <= SEARCH_PER_HIT_CHARS + 4, `clipped near cap, got ${r.content.length}`);
  assert.equal(r.truncated, true);
  assert.equal(r.fullChars, 5000);
  assert.equal(out.truncated, true);
  // identity preserved so the agent can fetch the whole leaf
  assert.equal(r.documentId, "a");
  assert.equal(r.score, 0.9);
});

test("a single huge body cannot overflow — capped regardless of size", () => {
  const out = clampSearchResponse({ records: [rec("huge", 200_000)] });
  assert.ok(out.records[0].content.length <= SEARCH_PER_HIT_CHARS + 4);
  assert.equal(out.records[0].fullChars, 200_000);
});

test("small bodies pass through untouched, no truncated flag", () => {
  const out = clampSearchResponse({ records: [rec("s", 120)] });
  assert.equal(out.records[0].content.length, 120);
  assert.equal(out.records[0].truncated, undefined);
  assert.equal(out.truncated, undefined);
});

test("total budget drops bodies of the lowest-ranked tail but keeps the hits", () => {
  const records = Array.from({ length: 60 }, (_, i) => rec(`h${i}`, SEARCH_PER_HIT_CHARS - 1, 1 - i / 100));
  const out = clampSearchResponse({ records });
  assert.equal(out.records.length, 60, "every hit retained (name+score), even when body dropped");
  const totalChars = out.records.reduce((s, r) => s + r.content.length, 0);
  assert.ok(totalChars <= SEARCH_TOTAL_BUDGET + SEARCH_PER_HIT_CHARS, `within budget, got ${totalChars}`);
  const dropped = out.records.filter((r) => r.content === "" && r.truncated);
  assert.ok(dropped.length > 0, "tail bodies dropped once budget spent");
  assert.ok(dropped.every((r) => r.documentId && typeof r.score === "number"), "dropped hits keep identity");
});

test("fullContent:true opts out entirely", () => {
  const input = { records: [rec("a", 5000)] };
  const out = clampSearchResponse(input, { fullContent: true });
  assert.equal(out, input, "returns the original object untouched");
});

test("maxChars tunes the per-hit width", () => {
  const out = clampSearchResponse({ records: [rec("a", 5000)] }, { maxChars: 150 });
  assert.ok(out.records[0].content.length <= 154, `respects maxChars, got ${out.records[0].content.length}`);
});

test("perHitDefault override (recall uses a wider window)", () => {
  const out = clampSearchResponse({ records: [rec("a", 5000)] }, { perHitDefault: 1500 });
  assert.ok(out.records[0].content.length > SEARCH_PER_HIT_CHARS, "wider than the search default");
  assert.ok(out.records[0].content.length <= 1504);
});

test("non-record shapes pass through unharmed", () => {
  assert.deepEqual(clampSearchResponse(null), null);
  assert.deepEqual(clampSearchResponse({ ok: true }), { ok: true });
  const empty = { records: [] };
  assert.deepEqual(clampSearchResponse(empty), empty);
});

test("missing/empty content is tolerated", () => {
  const out = clampSearchResponse({ records: [{ documentId: "x", score: 0.5 }] });
  assert.equal(out.records[0].content, "");
  assert.equal(out.records[0].truncated, undefined);
});

const glanceRec = (id, len) => ({
  datasetId: "plans",
  documentId: id,
  documentName: id,
  score: 0.8,
  priority: "P1",
  content: big(len),
  brief: "A short brief here",
  type: "plan",
  status: "in-progress",
  progress: { total: 8, done: 3, label: "3/8" },
  tags: ["a", "b"],
});

test("sections=[frontmatter] drops the body and keeps the glance fields", () => {
  const out = clampSearchResponse({ records: [glanceRec("a", 5000)] }, { sections: ["frontmatter"] });
  const r = out.records[0];
  assert.equal(r.content, undefined, "body dropped");
  assert.equal(r.truncated, undefined);
  assert.equal(r.fullChars, undefined);
  assert.equal(r.brief, "A short brief here");
  assert.equal(r.type, "plan");
  assert.equal(r.status, "in-progress");
  assert.deepEqual(r.progress, { total: 8, done: 3, label: "3/8" });
  assert.deepEqual(r.tags, ["a", "b"]);
  assert.equal(r.documentId, "a");
  assert.equal(r.priority, "P1");
});

test("sections=[frontmatter,body] keeps BOTH the excerpted body and the glance fields", () => {
  const out = clampSearchResponse({ records: [glanceRec("a", 5000)] }, { sections: ["frontmatter", "body"] });
  const r = out.records[0];
  assert.ok(r.content.length <= SEARCH_PER_HIT_CHARS + 4, "body still excerpted");
  assert.equal(r.truncated, true);
  assert.equal(r.brief, "A short brief here");
  assert.equal(r.type, "plan");
});

test("sections=[body] behaves like the default (excerpt)", () => {
  const out = clampSearchResponse({ records: [rec("a", 5000)] }, { sections: ["body"] });
  assert.ok(out.records[0].content.length <= SEARCH_PER_HIT_CHARS + 4);
  assert.equal(out.records[0].truncated, true);
});

test("frontmatter-only takes precedence over fullContent (body still dropped)", () => {
  const out = clampSearchResponse(
    { records: [glanceRec("a", 5000)] },
    { sections: ["frontmatter"], fullContent: true },
  );
  assert.equal(out.records[0].content, undefined);
  assert.equal(out.records[0].brief, "A short brief here");
});

test("sections omitted adds NO glance fields (byte-identical shape)", () => {
  const out = clampSearchResponse({ records: [rec("a", 120)] });
  const r = out.records[0];
  assert.equal(r.brief, undefined);
  assert.equal(r.type, undefined);
  assert.equal(r.status, undefined);
  assert.deepEqual(Object.keys(r).sort(), ["content", "documentId", "documentName", "score"].sort());
});

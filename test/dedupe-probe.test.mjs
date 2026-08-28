import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Lexical backend: deterministic, no model download. The probe's decision logic
// is what is under test, not the embedding model's exact cosines, so the
// thresholds are passed in per case rather than read from settings.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dedupe-probe-test-"));
process.env.MEMORY_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, "settings"), { recursive: true });
fs.writeFileSync(
  path.join(TMP, "settings", "settings.yaml"),
  "embed:\n  backend: lexical\n  model: test/plain-model\n",
);
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { probeForDuplicate, duplicateRefusal } = await import("../scripts/lib/dedupe-probe.mjs");

const BANDS = { enabled: true, probeThreshold: 0.7, duplicateThreshold: 0.975 };

// Inject the search so each band is reachable deterministically. The real search
// path is exercised by the MCP tests; here the point is that a given top score
// maps to the right verdict.
const topHit = (hit) => async () => ({ records: hit ? [hit] : [] });
const throwing = async () => {
  throw new Error("embedding backend unavailable");
};

test("dedupe disabled short-circuits without embedding anything", async () => {
  const v = await probeForDuplicate({
    dataset: "knowledge",
    name: "a.md",
    text: "body",
    thresholds: { ...BANDS, enabled: false },
  });
  assert.equal(v.verdict, "none");
  assert.match(String(v.reason), /disabled/);
});

test("a probe error FAILS OPEN, so a backend outage never silently drops a save", async () => {
  const v = await probeForDuplicate({
    dataset: "knowledge",
    name: "a.md",
    text: "body",
    thresholds: BANDS,
    search: throwing,
  });
  // The cost of a missed duplicate is one extra leaf consolidate can merge. The
  // cost of a refused save is lost work, so an outage must not refuse.
  assert.equal(v.verdict, "none");
  assert.match(String(v.reason), /embedding backend unavailable/);
});

test("no hit at all is a silent save", async () => {
  const search = topHit(null);
  const v = await probeForDuplicate({
    dataset: "knowledge",
    name: "a.md",
    text: "body",
    thresholds: BANDS,
    search,
  });
  assert.deepEqual(v, { verdict: "none", score: 0 });
});

test("below the probe threshold is a silent save", async () => {
  const search = topHit({ documentId: "knowledge/x/y.md", documentName: "y.md", score: 0.42 });
  const v = await probeForDuplicate({
    dataset: "knowledge",
    name: "a.md",
    text: "body",
    thresholds: BANDS,
    search,
  });
  assert.equal(v.verdict, "none");
  assert.equal(v.score, 0.42);
});

test("between the thresholds the save proceeds and reports its neighbour", async () => {
  const search = topHit({ documentId: "knowledge/x/y.md", documentName: "y.md", score: 0.83 });
  const v = await probeForDuplicate({
    dataset: "knowledge",
    name: "a.md",
    text: "body",
    thresholds: BANDS,
    search,
  });
  assert.equal(v.verdict, "related");
  assert.equal(v.documentId, "knowledge/x/y.md");
});

test("at or above the duplicate threshold the save is refused and names the leaf", async () => {
  const search = topHit({ documentId: "knowledge/x/y.md", documentName: "y.md", score: 0.981 });
  const v = await probeForDuplicate({
    dataset: "knowledge",
    name: "a.md",
    text: "body",
    thresholds: BANDS,
    search,
  });
  assert.equal(v.verdict, "duplicate");
  const msg = duplicateRefusal(v);
  assert.match(msg, /duplicate-suspected/);
  assert.match(msg, /y\.md/, "the refusal must name the existing leaf");
  assert.match(msg, /allowDuplicate:true/, "and both ways forward");
  assert.match(msg, /upserts in place/);
});

test("the exact threshold value is INCLUSIVE, so the band edge is not a gap", async () => {
  const search = topHit({ documentId: "k/x.md", documentName: "x.md", score: 0.975 });
  const v = await probeForDuplicate({
    dataset: "knowledge",
    name: "a.md",
    text: "body",
    thresholds: BANDS,
    search,
  });
  assert.equal(v.verdict, "duplicate");
});

test("an upsert of the SAME name is never reported as a duplicate of itself", async () => {
  // Otherwise every legitimate edit of an existing leaf would be refused.
  const search = topHit({ documentId: "k/a.md", documentName: "a.md", score: 0.999 });
  const v = await probeForDuplicate({
    dataset: "knowledge",
    name: "a.md",
    text: "revised body",
    thresholds: BANDS,
    search,
  });
  assert.equal(v.verdict, "none");
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const { priorityForAtomType, normalisePriority, priorityRank, enforceP0Scarcity } = await import(
  "../scripts/lib/datasets.mjs"
);
const store = await import("../scripts/lib/wiki-store.mjs");
const { rerankWithinBands } = store;
const { clampSearchResponse } = await import("../scripts/lib/search-clamp.mjs");
const recall = await import("../scripts/lib/recall.mjs");

// ── rubric + helpers (pure) ──────────────────────────────────────────────────

test("priorityForAtomType: rubric defaults, NEVER P0", () => {
  for (const t of ["feedback-rule", "decision", "bug-root-cause", "pattern-gotcha", "investigation"]) {
    assert.equal(priorityForAtomType(t), "P1", t);
  }
  for (const t of ["reference", "project-lore", "daily-capture"]) {
    assert.equal(priorityForAtomType(t), "P2", t);
  }
  assert.equal(priorityForAtomType("plan", { lifecycle: "in-progress" }), "P1");
  assert.equal(priorityForAtomType("plan", { lifecycle: "done" }), "P2");
  assert.equal(priorityForAtomType("plan", { lifecycle: "archived" }), "P2");
  assert.equal(priorityForAtomType("totally-unknown"), "P2");
  for (const t of ["feedback-rule", "reference", "plan", "investigation", "x"]) {
    assert.notEqual(priorityForAtomType(t), "P0", `${t} must never rubric to P0`);
  }
});

test("normalisePriority: case-insensitive valid, null otherwise", () => {
  assert.equal(normalisePriority("p0"), "P0");
  assert.equal(normalisePriority(" P1 "), "P1");
  assert.equal(normalisePriority("P9"), null);
  assert.equal(normalisePriority(""), null);
  assert.equal(normalisePriority(undefined), null);
});

test("priorityRank: P0 < P1 < P2; unknown sorts as P2", () => {
  assert.ok(priorityRank("P0") < priorityRank("P1"));
  assert.ok(priorityRank("P1") < priorityRank("P2"));
  assert.equal(priorityRank("???"), priorityRank("P2"));
});

test("enforceP0Scarcity: P0 coerced to P1 unless explicitly allowed", () => {
  assert.deepEqual(enforceP0Scarcity("P0", false), { priority: "P1", coerced: true });
  assert.deepEqual(enforceP0Scarcity("P0", true), { priority: "P0", coerced: false });
  assert.deepEqual(enforceP0Scarcity("P1", false), { priority: "P1", coerced: false });
  assert.deepEqual(enforceP0Scarcity(undefined, false), { priority: undefined, coerced: false });
});

test("normaliseMeta: fills rubric when absent, honours valid (incl P0), rubric on invalid; always present", () => {
  assert.equal(store.normaliseMeta({ atom_type: "reference", area: "x" }).priority, "P2");
  assert.equal(store.normaliseMeta({ atom_type: "feedback-rule", area: "x" }).priority, "P1");
  assert.equal(store.normaliseMeta({ atom_type: "reference", area: "x", priority: "P0" }).priority, "P0");
  assert.equal(store.normaliseMeta({ atom_type: "feedback-rule", area: "x", priority: "junk" }).priority, "P1");
});

// ── retrieval ranking (pure) ─────────────────────────────────────────────────

test("rerankWithinBands: priority breaks ties WITHIN a band; relevance preserved across larger gaps", () => {
  const hits = [
    { id: "a", score: 0.90, priority: "P2" }, // gap to next > band -> stays first
    { id: "b", score: 0.80, priority: "P2" },
    { id: "c", score: 0.78, priority: "P1" }, // within band of b -> ordered above it
    { id: "d", score: 0.50, priority: "P0" }, // out of band -> NOT promoted despite P0
  ];
  assert.deepEqual(rerankWithinBands(hits, 0.05).map((h) => h.id), ["a", "c", "b", "d"]);
});

test("rerankWithinBands: band<=0 disables; equal-priority ties keep cosine order (stable)", () => {
  const hits = [{ id: "a", score: 0.9, priority: "P2" }, { id: "b", score: 0.89, priority: "P1" }];
  assert.deepEqual(rerankWithinBands(hits, 0).map((h) => h.id), ["a", "b"]);
  const eq = [{ id: "x", score: 0.9, priority: "P1" }, { id: "y", score: 0.89, priority: "P1" }];
  assert.deepEqual(rerankWithinBands(eq, 0.05).map((h) => h.id), ["x", "y"]);
});

test("clampSearchResponse: trims LOWEST-priority bodies first; never drops a hit; preserves order + priority", () => {
  const big = (c) => c.repeat(9000); // 9000 chars; TOTAL budget is 16000
  // P0 is LAST in array — original-order spend would empty it; priority-aware spend protects it.
  const recs = {
    records: [
      { documentId: "p2a", priority: "P2", content: big("a") },
      { documentId: "p2b", priority: "P2", content: big("c") },
      { documentId: "p0", priority: "P0", content: big("b") },
    ],
  };
  const out = clampSearchResponse(recs, { maxChars: 9000 }); // perHit big so only TOTAL budget bites
  assert.deepEqual(out.records.map((r) => r.documentId), ["p2a", "p2b", "p0"], "output order preserved");
  const len = Object.fromEntries(out.records.map((r) => [r.documentId, r.content.length]));
  assert.ok(len.p0 > 0, "P0 body protected (spent first) even though it was last in the array");
  assert.ok(len.p2a === 0 || len.p2b === 0, "a P2 body was emptied first under budget");
  assert.ok(out.records.every((r) => r.priority), "priority annotation preserved");
});

// ── integration (real wiki via harness) ──────────────────────────────────────

test("integration: a written leaf's priority is rubric-filled and exposed by search", async () => {
  store.writeMemory({
    name: "IntRule.md",
    text: "integration feedback rule body with unique zzqq lexical terms for the match",
    datasetId: "knowledge",
    metadata: { atom_type: "feedback-rule", area: "intg" },
  });
  const res = await store.searchMemoryFiltered({
    query: "integration feedback rule unique zzqq lexical terms match",
    datasetId: "knowledge",
    limit: 5,
  });
  const hit = res.records.find((r) => /intrule/i.test(r.documentName));
  assert.ok(hit, `found the leaf; got ${JSON.stringify(res.records.map((r) => r.documentName))}`);
  assert.equal(hit.priority, "P1", "feedback-rule rubric priority exposed on the record");
});

test("integration: backfillPriority stamps a legacy leaf by rubric; idempotent", () => {
  const w = store.writeMemory({
    name: "Legacy.md",
    text: "a legacy reference leaf body that will have its priority stripped for backfill",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "intg" },
  });
  const abs = path.join(wiki, w.created.document.id);
  fs.writeFileSync(abs, fs.readFileSync(abs, "utf8").replace(/\n\s*priority:\s*\S+/, "")); // strip
  assert.ok(store.backfillPriority({ dryRun: true }).stamped >= 1, "dry-run finds the stripped leaf");
  assert.ok(store.backfillPriority({ dryRun: false }).stamped >= 1, "backfill stamps it");
  assert.match(fs.readFileSync(abs, "utf8"), /priority:\s*P2/, "reference restamped P2");
  assert.equal(store.backfillPriority({ dryRun: true }).stamped, 0, "idempotent: nothing left");
});

test("integration: gated saveLesson renders the user-picked priority (P0) into frontmatter", () => {
  const r = recall.saveLesson({
    title: "Priority lesson sample",
    body: "a lesson body long enough to be meaningful",
    metadata: { area: "intg", task_type: "implementation", error_pattern: "sample-trap", priority: "P0" },
  });
  const leaf = fs.readFileSync(path.join(wiki, r.created.document.id), "utf8");
  assert.match(leaf, /priority:\s*P0/, "gated lesson keeps the user-picked P0");
});

test("metadataForDify: passes priority through when present, omits when absent", async () => {
  const { metadataForDify } = await import("../scripts/lib/datasets.mjs");
  assert.equal(metadataForDify({ type: "feedback-rule", metadata: { priority: "P0", area: "x" } }).priority, "P0");
  assert.equal(metadataForDify({ type: "reference", metadata: { area: "x" } }).priority, undefined);
});

test("integration: recallLessons exposes priority on its records", async () => {
  recall.saveLesson({
    title: "Recall prio lesson",
    body: "a lesson body used to verify recall exposes the priority field",
    metadata: { area: "recallprio", task_type: "implementation", error_pattern: "recall-prio-trap" },
  });
  const out = await recall.recallLessons({ query: "recall priority exposure lesson", area: "recallprio" });
  const hit = out.records.find((r) => /recall.prio/i.test(r.documentName));
  assert.ok(hit, `lesson recalled; got ${JSON.stringify(out.records.map((r) => r.documentName))}`);
  assert.equal(hit.priority, "P1", "self-improvement-lesson default rubric P1 exposed on the recall record");
});

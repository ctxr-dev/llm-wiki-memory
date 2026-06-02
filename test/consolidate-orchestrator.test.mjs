// Integration tests for the consolidate orchestrator with seeded leaves.
// Complements consolidate-smoke.test.mjs (which covers dry-run / throttle /
// lock / pure helpers) by exercising the per-leaf loop on real wiki state.
//
// LLM is disabled in every call (`llm:false`) — LLM-specific behaviour is
// covered in its own suite.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const { consolidateMemory } = await import("../scripts/consolidate.mjs");
const store = await import("../scripts/lib/wiki-store.mjs");

function seedLeaf({ name, text, datasetId, metadata }) {
  return store.saveDocument({ name, text, datasetId, metadata });
}

const FROZEN_NOW = new Date("2026-06-02T12:00:00Z");

test("working set: only self_improvement+knowledge leaves enter the per-leaf loop", async () => {
  // Two refinement-category leaves (unique bodies — nothing to dedupe here).
  seedLeaf({
    name: "ws-lesson.md",
    text: "# Lesson\n\nUse index-rebuild-one on hot paths.",
    datasetId: "self_improvement",
    metadata: {
      project_module: "wstest",
      area: "infra",
      task_type: "implementation",
      error_pattern: "full-rebuild-hot-path",
    },
  });
  seedLeaf({
    name: "ws-knowledge.md",
    text: "# Note\n\nStdio MCP server registration lives in .mcp.json.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "wstest", area: "infra" },
  });
  // Identical-body PAIRS in plans + investigations. If those categories were
  // wrongly admitted to the per-leaf loop, dedupe-by-sha256 would archive one
  // leaf from each pair. They MUST NOT — only self_improvement + knowledge
  // are refinement categories, so plans/investigations stay fully active.
  const planDupBody = "# Plan dup\n\nIdentical body across both plan leaves so sha256 would fire IF plans entered the working set.";
  seedLeaf({
    name: "ws-plan-dup-a.md",
    text: planDupBody,
    datasetId: "plans",
    metadata: { atom_type: "plan", project_module: "wstest", area: "infra" },
  });
  seedLeaf({
    name: "ws-plan-dup-b.md",
    text: planDupBody,
    datasetId: "plans",
    metadata: { atom_type: "plan", project_module: "wstest", area: "infra" },
  });
  const invDupBody = "# Inv dup\n\nIdentical body across both investigation leaves so sha256 would fire IF investigations entered the working set.";
  seedLeaf({
    name: "ws-inv-dup-a.md",
    text: invDupBody,
    datasetId: "investigations",
    metadata: { atom_type: "investigation", project_module: "wstest", area: "infra" },
  });
  seedLeaf({
    name: "ws-inv-dup-b.md",
    text: invDupBody,
    datasetId: "investigations",
    metadata: { atom_type: "investigation", project_module: "wstest", area: "infra" },
  });

  const activePlansBefore = store.listDocuments({ datasetId: "plans", enabled: true }).documents.map((d) => d.id).sort();
  const activeInvBefore = store.listDocuments({ datasetId: "investigations", enabled: true }).documents.map((d) => d.id).sort();
  assert.equal(activePlansBefore.length, 2, "two plans leaves seeded");
  assert.equal(activeInvBefore.length, 2, "two investigations leaves seeded");

  const r = await consolidateMemory({
    dryRun: false,
    llm: false,
    passes: ["dedupe-by-sha256"],
    now: FROZEN_NOW,
  });

  assert.equal(r.ok, true);
  assert.equal(r.workingSetSize, 2, "only self_improvement + knowledge enter the loop");

  // Positive ids assertion: every plans/investigations leaf remains active
  // and unchanged. If those categories had wrongly entered the per-leaf loop,
  // the seeded duplicate pairs would have had a loser disabled here.
  const activePlansAfter = store.listDocuments({ datasetId: "plans", enabled: true }).documents.map((d) => d.id).sort();
  const activeInvAfter = store.listDocuments({ datasetId: "investigations", enabled: true }).documents.map((d) => d.id).sort();
  assert.deepEqual(activePlansAfter, activePlansBefore, "plans leaves untouched — plans is not in the working set");
  assert.deepEqual(activeInvAfter, activeInvBefore, "investigations leaves untouched — investigations is not in the working set");
  const disabled = store.listDocuments({ enabled: false }).documents;
  assert.equal(disabled.length, 0, "no leaves were disabled (no dupes in self_improvement+knowledge)");
  assert.equal(r.totals.archived, 0, "report agrees: zero archives");
  assert.equal(r.totals.flagged, 0, "report agrees: zero pairs flagged");
});

test("passes allow-list: only the listed pass executes", async () => {
  const r = await consolidateMemory({
    dryRun: true,
    llm: false,
    passes: ["dedupe-by-sha256"],
    now: FROZEN_NOW,
  });
  assert.equal(r.ok, true);

  for (const [name, report] of Object.entries(r.passes)) {
    if (name === "dedupe-by-sha256") {
      continue;
    }
    assert.equal(
      report.archived + report.touched + report.merged + report.refreshed + report.flagged,
      0,
      `pass ${name} should be a no-op when not in the allow-list`,
    );
  }
});

test("empty wiki + passes:[] (all off): returns ok with totals zero", async () => {
  const emptyWs = setupWorkspace({ projectModule: "emptytest" });
  try {
    const { consolidateMemory: consolidateEmpty } = await import(
      `../scripts/consolidate.mjs?empty=${Date.now()}`
    );
    const r = await consolidateEmpty({
      dryRun: true,
      llm: false,
      passes: [],
      now: FROZEN_NOW,
    });
    assert.equal(r.ok, true);
    assert.equal(r.totals.archived, 0);
    assert.equal(r.totals.touched, 0);
    assert.equal(r.totals.merged, 0);
    assert.equal(r.totals.refreshed, 0);
    assert.equal(r.totals.flagged, 0);
    assert.equal(r.totals.errors, 0);
  } finally {
    cleanup(emptyWs.dataDir);
  }
});

test("frozen-clock determinism: two dry-runs over same state produce identical action counts", async () => {
  // ONE identical-body pair in self_improvement so dedupe-by-sha256 fires
  // deterministically. Without an actual duplicate the counts would all be
  // zero and `assert.deepEqual({zeros}, {zeros})` would be vacuously true.
  // Different `error_pattern`s ensure dedupe-by-lesson-key does NOT also
  // match this pair — sha256 owns the dedupe credit here.
  const dupBody = "# Det dup\n\nIdentical body across det-dup-a and det-dup-b so sha256 dedupe fires deterministically.";
  seedLeaf({
    name: "det-dup-a.md",
    text: dupBody,
    datasetId: "self_improvement",
    metadata: {
      project_module: "dettest",
      area: "infra",
      task_type: "implementation",
      error_pattern: "deterministic-dup-a",
    },
  });
  seedLeaf({
    name: "det-dup-b.md",
    text: dupBody,
    datasetId: "self_improvement",
    metadata: {
      project_module: "dettest",
      area: "infra",
      task_type: "implementation",
      error_pattern: "deterministic-dup-b",
    },
  });
  // A unique-bodied knowledge leaf so the working set covers both refinement
  // categories (parallels the rest of the fixture).
  seedLeaf({
    name: "det-knowledge.md",
    text: "# Det K\n\nUnique knowledge body so the working set spans both refinement categories.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "dettest", area: "infra" },
  });

  const opts = {
    dryRun: true,
    llm: false,
    passes: ["dedupe-by-sha256", "dedupe-by-lesson-key", "staleness-flag"],
    now: FROZEN_NOW,
  };

  const r1 = await consolidateMemory(opts);
  const r2 = await consolidateMemory(opts);

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);

  // Sanity: the assertion below is NOT vacuous — sha256 actually fired.
  assert.ok(r1.totals.flagged > 0, "dedupe-by-sha256 flagged the seeded duplicate pair (not vacuous)");
  assert.ok(r1.totals.archived > 0, "dedupe-by-sha256 marked a loser for archive (not vacuous)");
  assert.equal(r1.passes["dedupe-by-sha256"].flagged, 1, "exactly one pair flagged by sha256");
  assert.equal(r1.passes["dedupe-by-sha256"].archived, 1, "exactly one loser would be archived by sha256");

  const projection = (r) => ({
    archived: r.totals.archived,
    touched: r.totals.touched,
    merged: r.totals.merged,
    flagged: r.totals.flagged,
    workingSetSize: r.workingSetSize,
  });

  assert.deepEqual(
    projection(r1),
    projection(r2),
    "two dry-runs over the same state must produce identical action counts",
  );

  for (const passName of Object.keys(r1.passes)) {
    const p1 = r1.passes[passName];
    const p2 = r2.passes[passName];
    assert.equal(p1.archived, p2.archived, `${passName}.archived stable`);
    assert.equal(p1.touched, p2.touched, `${passName}.touched stable`);
    assert.equal(p1.merged, p2.merged, `${passName}.merged stable`);
    assert.equal(p1.flagged, p2.flagged, `${passName}.flagged stable`);
  }

  // Materialise the archive once and confirm the deterministic loser. The two
  // dry-runs above each queued the same (keeper, loser) pair internally;
  // running once non-dryRun reveals which documentId would be archived.
  // pickKeeper ties on frontmatter.updated (same calendar day) and breaks the
  // tie by lex-ascending documentId — det-dup-a < det-dup-b, so det-dup-b is
  // the loser.
  const disabledBefore = store.listDocuments({ enabled: false }).documents;
  assert.equal(disabledBefore.length, 0, "no leaves disabled before the materialising run");

  const r3 = await consolidateMemory({ ...opts, dryRun: false });
  assert.equal(r3.ok, true);
  assert.equal(
    r3.passes["dedupe-by-sha256"].archived,
    r1.passes["dedupe-by-sha256"].archived,
    "non-dryRun archive count matches dryRun's — same pair, same outcome",
  );

  const disabledAfter = store.listDocuments({ enabled: false }).documents;
  const disabledNames = disabledAfter.map((d) => d.name).sort();
  assert.deepEqual(
    disabledNames,
    ["det-dup-b.md"],
    "deterministic loser is det-dup-b.md — same documentId archived in both dryRuns and the materialising run",
  );
});

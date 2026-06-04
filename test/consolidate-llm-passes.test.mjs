import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

// Lexical embed backend + LLM_WIKI_FIXED_TIMESTAMP are already set by the
// harness. We enable LLM-merge by default; individual tests turn it off via
// MEMORY_CONSOLIDATE_LLM_PASSES=off.
process.env.MEMORY_LLM_PROVIDER = "mock";

const store = await import("../scripts/lib/wiki-store.mjs");
const { consolidateMemory } = await import("../scripts/consolidate.mjs");
const { __setSettingsForTest, __clearSettingsForTest } = await import("../scripts/lib/settings.mjs");

const STATE_FILE = path.join(dataDir, "state", ".consolidate.json");

// ─── helpers ───────────────────────────────────────────────────────────────

function clearState() {
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch {
    /* best effort */
  }
}

function resetLlmEnv() {
  delete process.env.MEMORY_LLM_MOCK_RESPONSE;
  delete process.env.MEMORY_LLM_MOCK_FILE;
  __clearSettingsForTest();
}

after(() => resetLlmEnv());

// Soft-delete every active leaf in the test wiki so each test starts from a
// clean working set. Cheaper + deterministic vs nuking + re-initialising the
// hosted wiki between tests.
function purgeActiveLeaves() {
  for (const cat of ["self_improvement", "knowledge"]) {
    const { documents } = store.listDocuments({ datasetId: cat });
    for (const d of documents) {
      try {
        store.deleteDocument({ documentId: d.id });
      } catch {
        /* best effort */
      }
    }
  }
}

function seedSelfImprovementLeaf({ name, text, metadata }) {
  const r = store.saveDocument({
    name,
    text,
    datasetId: "self_improvement",
    metadata: { project_module: "billing", task_type: "refactor", ...metadata },
  });
  if (!r.ok) throw new Error(`seed failed for ${name}: ${JSON.stringify(r)}`);
  return r.created.document.id;
}

function activeIds(category) {
  const { documents } = store.listDocuments({ datasetId: category, enabled: true });
  return documents.map((d) => d.id).sort();
}

function readLeaf(documentId) {
  return store.readLeafForConsolidate({ documentId });
}

// ─── 3A: llm-merge-near-duplicates ─────────────────────────────────────────

test("3A merge: action='merge' rewrites keeper body and archives loser", async () => {
  purgeActiveLeaves();
  clearState();
  resetLlmEnv();

  const ID_A = seedSelfImprovementLeaf({
    name: "lesson-merge-a-2026-06-01-000000000.md",
    text: "# Always await async writes\n\nAwait async write calls.\nWhy: missing-await race.",
    metadata: { error_pattern: "merge-test-a" },
  });
  const ID_B = seedSelfImprovementLeaf({
    name: "lesson-merge-b-2026-06-01-000000000.md",
    text: "# Always await async writes\n\nAwait async write calls.\nWhy: missing-await race.",
    metadata: { error_pattern: "merge-test-a" },
  });

  // dedupe-by-sha256 keeper selection: equal `updated` → lex-ascending id wins.
  const [keeperId, loserId] = [ID_A, ID_B].sort();

  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    action: "merge",
    merged_body: "NEW CONTENT after merge",
    keeper_id: keeperId,
    loser_id: loserId,
    reason: "fold duplicate into keeper",
  });

  const r = await consolidateMemory({
    llm: true,
    now: new Date("2026-06-02T00:00:00Z"),
    passes: ["dedupe-by-sha256", "llm-merge-near-duplicates"],
  });
  assert.equal(r.ok, true);

  const keeper = readLeaf(keeperId);
  const loser = readLeaf(loserId);
  assert.ok(keeper, "keeper still on disk");
  assert.ok(loser, "loser still on disk");
  assert.match(keeper.text, /NEW CONTENT/, "keeper body rewritten with merged content");
  assert.equal(keeper.active, true, "keeper remains active");
  assert.equal(loser.active, false, "loser archived");
  assert.equal(loser.memory.status, "archived");
  assert.equal(loser.memory.supersedes_id, keeperId, "loser supersedes_id points at keeper");
});

test("3A merge: action='keep-keeper-unchanged' leaves keeper text, archives loser", async () => {
  purgeActiveLeaves();
  clearState();
  resetLlmEnv();

  const ORIGINAL = "# Use parameterised SQL\n\nUse parameterised SQL queries.\nWhy: sql-injection.";
  const ID_A = seedSelfImprovementLeaf({
    name: "lesson-keep-a-2026-06-01-000000000.md",
    text: ORIGINAL,
    metadata: { error_pattern: "keep-test-a" },
  });
  const ID_B = seedSelfImprovementLeaf({
    name: "lesson-keep-b-2026-06-01-000000000.md",
    text: ORIGINAL,
    metadata: { error_pattern: "keep-test-a" },
  });
  const [keeperId, loserId] = [ID_A, ID_B].sort();

  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    action: "keep-keeper-unchanged",
    keeper_id: keeperId,
    loser_id: loserId,
    reason: "keeper already says it all",
  });

  const r = await consolidateMemory({
    llm: true,
    now: new Date("2026-06-02T00:00:00Z"),
    passes: ["dedupe-by-sha256", "llm-merge-near-duplicates"],
  });
  assert.equal(r.ok, true);

  const keeper = readLeaf(keeperId);
  const loser = readLeaf(loserId);
  assert.equal(keeper.text.trim(), ORIGINAL.trim(), "keeper body unchanged");
  assert.equal(keeper.active, true);
  assert.equal(loser.active, false, "loser archived");
});

test("3A merge: action='skip' keeps BOTH leaves active", async () => {
  purgeActiveLeaves();
  clearState();
  resetLlmEnv();

  const ID_A = seedSelfImprovementLeaf({
    name: "lesson-skip-a-2026-06-01-000000000.md",
    text: "# Cache invalidation\n\nInvalidate caches on writes.\nWhy: stale-reads.",
    metadata: { error_pattern: "skip-test-a" },
  });
  const ID_B = seedSelfImprovementLeaf({
    name: "lesson-skip-b-2026-06-01-000000000.md",
    text: "# Cache invalidation\n\nInvalidate caches on writes.\nWhy: stale-reads.",
    metadata: { error_pattern: "skip-test-a" },
  });
  const [keeperId, loserId] = [ID_A, ID_B].sort();

  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    action: "skip",
    keeper_id: keeperId,
    loser_id: loserId,
    reason: "false positive — different domains",
  });

  const r = await consolidateMemory({
    llm: true,
    now: new Date("2026-06-02T00:00:00Z"),
    passes: ["dedupe-by-sha256", "llm-merge-near-duplicates"],
  });
  assert.equal(r.ok, true);

  const keeper = readLeaf(keeperId);
  const loser = readLeaf(loserId);
  assert.equal(keeper.active, true, "keeper stays active");
  assert.equal(loser.active, true, "loser stays active (skip path)");
});

test("3A merge: hallucinated keeper_id falls back to deterministic archive (no merge)", async () => {
  purgeActiveLeaves();
  clearState();
  resetLlmEnv();

  const ORIGINAL = "# Validate webhook signatures\n\nVerify HMAC on every webhook.\nWhy: forgery.";
  const ID_A = seedSelfImprovementLeaf({
    name: "lesson-hallu-a-2026-06-01-000000000.md",
    text: ORIGINAL,
    metadata: { error_pattern: "hallu-test-a" },
  });
  const ID_B = seedSelfImprovementLeaf({
    name: "lesson-hallu-b-2026-06-01-000000000.md",
    text: ORIGINAL,
    metadata: { error_pattern: "hallu-test-a" },
  });
  const [keeperId, loserId] = [ID_A, ID_B].sort();

  // Wrong keeper_id (a totally fabricated path) → hallucination guard fires;
  // callJSON has no schema-level reason to retry (the schema accepts any
  // non-empty string), the orchestrator catches LLMOutputInvalid and falls
  // back to deterministic archive without merge.
  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    action: "merge",
    merged_body: "SHOULD NOT APPEAR",
    keeper_id: "self_improvement/fake/refactor/ghost-leaf.md",
    loser_id: loserId,
    reason: "intentionally wrong keeper id",
  });

  const r = await consolidateMemory({
    llm: true,
    now: new Date("2026-06-02T00:00:00Z"),
    passes: ["dedupe-by-sha256", "llm-merge-near-duplicates"],
  });
  assert.equal(r.ok, true);

  const keeper = readLeaf(keeperId);
  const loser = readLeaf(loserId);
  assert.equal(keeper.active, true, "keeper still active");
  assert.ok(!/SHOULD NOT APPEAR/.test(keeper.text), "keeper body NOT rewritten on fallback");
  assert.equal(loser.active, false, "loser still archived via deterministic finalize");
});

test("3E: MEMORY_CONSOLIDATE_LLM_PASSES=off skips 3A; sha256 dedup still archives loser", async () => {
  purgeActiveLeaves();
  clearState();
  resetLlmEnv();

  const ORIGINAL = "# Idempotent retries\n\nMake retries idempotent.\nWhy: double-charge.";
  const ID_A = seedSelfImprovementLeaf({
    name: "lesson-off-a-2026-06-01-000000000.md",
    text: ORIGINAL,
    metadata: { error_pattern: "off-test-a" },
  });
  const ID_B = seedSelfImprovementLeaf({
    name: "lesson-off-b-2026-06-01-000000000.md",
    text: ORIGINAL,
    metadata: { error_pattern: "off-test-a" },
  });
  const [keeperId, loserId] = [ID_A, ID_B].sort();

  __setSettingsForTest({ consolidate: { llmPassesEnabled: false } });
  // Mock response must NOT be consumed; set a poison value to detect a leak.
  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    action: "merge",
    merged_body: "POISON — LLM SHOULD NOT RUN",
    keeper_id: keeperId,
    loser_id: loserId,
    reason: "trip-wire",
  });

  const r = await consolidateMemory({
    llm: true, // overridden by env knob (env-off wins via consolidateLlmPassesEnabled())
    now: new Date("2026-06-02T00:00:00Z"),
    passes: ["dedupe-by-sha256", "llm-merge-near-duplicates"],
  });
  assert.equal(r.ok, true);

  const keeper = readLeaf(keeperId);
  const loser = readLeaf(loserId);
  assert.equal(keeper.active, true, "keeper still active");
  assert.ok(!/POISON/.test(keeper.text), "LLM merge did NOT run (keeper body untouched)");
  assert.equal(loser.active, false, "loser archived by deterministic dedup-by-sha256");
});

// ─── 3B: llm-semantic-refresh ──────────────────────────────────────────────

function seedStaleLeaf({ name, text, errorPattern }) {
  const id = seedSelfImprovementLeaf({
    name,
    text,
    metadata: { error_pattern: errorPattern },
  });
  store.updateDocMetadata({
    documentId: id,
    metadata: { stale: true, last_recalled_at: "2026-05-30T12:00:00Z" },
  });
  return id;
}

test("3B refresh: action='keep' with stale_after=false clears the stale flag", async () => {
  purgeActiveLeaves();
  clearState();
  resetLlmEnv();

  const id = seedStaleLeaf({
    name: "lesson-refresh-keep-2026-06-01-000000000.md",
    text: "# Lock files outlive bundler upgrades\n\nKeep package-lock.json in VCS.\nWhy: reproducible-builds.",
    errorPattern: "refresh-keep",
  });

  const before = readLeaf(id);
  assert.equal(before.memory.stale, true, "seeded as stale");

  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    action: "keep",
    leaf_id: id,
    stale_after: false,
    reason: "still load-bearing",
  });

  const r = await consolidateMemory({
    llm: true,
    now: new Date("2026-06-02T00:00:00Z"),
    passes: ["llm-semantic-refresh"],
  });
  assert.equal(r.ok, true);

  const after = readLeaf(id);
  assert.equal(after.memory.stale, false, "stale flag cleared");
  assert.equal(after.active, true);
});

test("3B refresh: action='rewrite' rewrites body, clears stale, stamps last_refreshed_at", async () => {
  purgeActiveLeaves();
  clearState();
  resetLlmEnv();

  const id = seedStaleLeaf({
    name: "lesson-refresh-rewrite-2026-06-01-000000000.md",
    text: "# Old style: callback-based fetch\n\nUse callbacks for HTTP.\nWhy: pre-async-era.",
    errorPattern: "refresh-rewrite",
  });

  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    action: "rewrite",
    leaf_id: id,
    rewritten_body: "X new modernised body",
    stale_after: false,
    reason: "rewritten with current idiom",
  });

  const r = await consolidateMemory({
    llm: true,
    now: new Date("2026-06-02T00:00:00Z"),
    passes: ["llm-semantic-refresh"],
  });
  assert.equal(r.ok, true);

  const after = readLeaf(id);
  assert.match(after.text, /X new modernised body/, "body rewritten");
  assert.equal(after.memory.stale, false, "stale cleared");
  assert.ok(after.memory.last_refreshed_at, "last_refreshed_at stamped");
  assert.equal(after.active, true);
});

test("3B refresh: action='archive' archives the leaf", async () => {
  purgeActiveLeaves();
  clearState();
  resetLlmEnv();

  const id = seedStaleLeaf({
    name: "lesson-refresh-archive-2026-06-01-000000000.md",
    text: "# Deprecated polling pattern\n\nPoll every 100ms.\nWhy: legacy-cause.",
    errorPattern: "refresh-archive",
  });

  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    action: "archive",
    leaf_id: id,
    archive_reason: "superseded by websocket pattern",
    stale_after: true,
    reason: "obsolete",
  });

  const r = await consolidateMemory({
    llm: true,
    now: new Date("2026-06-02T00:00:00Z"),
    passes: ["llm-semantic-refresh"],
  });
  assert.equal(r.ok, true);

  const after = readLeaf(id);
  assert.equal(after.active, false, "leaf archived");
  assert.equal(after.memory.status, "archived");
});

test("3B refresh: MEMORY_CONSOLIDATE_REFRESH_MAX_PER_RUN=2 caps to 2 of 4 stale leaves", async () => {
  purgeActiveLeaves();
  clearState();
  resetLlmEnv();

  // Seed 4 stale leaves. The orchestrator processes recently-recalled first;
  // give each a distinct last_recalled_at so the sort is deterministic.
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const id = seedSelfImprovementLeaf({
      name: `lesson-cap-${i}-2026-06-01-000000000.md`,
      text: `# Stale leaf ${i}\n\nLegacy body ${i}.\nWhy: aged-out-${i}.`,
      metadata: { error_pattern: `refresh-cap-${i}` },
    });
    store.updateDocMetadata({
      documentId: id,
      metadata: {
        stale: true,
        // Earlier index → earlier last_recalled_at → processed LATER (sort desc).
        last_recalled_at: new Date(Date.UTC(2026, 4, 25 + i, 0, 0, 0)).toISOString(),
      },
    });
    ids.push(id);
  }

  __setSettingsForTest({ consolidate: { refreshMaxPerRun: 2 } });

  // The mock returns ONE canned JSON; the schema only requires `leaf_id` to
  // match the loop's current leaf. A single response can't satisfy two
  // distinct leaves AND the strict id check, so we accept either outcome:
  //   - both calls match (cap=2) → 2 touched/refreshed/archived
  //   - id check throws → both calls treated as errors (still counted)
  // The invariant we ASSERT here is that the orchestrator made AT MOST 2
  // attempts (cap honoured): the total of touched+refreshed+archived+errors
  // for the 3B pass must equal 2.
  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    action: "keep",
    // Use the most-recently-recalled id (i=3) — guaranteed to be the first
    // processed under the desc sort.
    leaf_id: ids[3],
    stale_after: false,
    reason: "kept",
  });

  const r = await consolidateMemory({
    llm: true,
    now: new Date("2026-06-02T00:00:00Z"),
    passes: ["llm-semantic-refresh"],
  });
  assert.equal(r.ok, true);

  const refreshReport = r.passes["llm-semantic-refresh"];
  const processed =
    refreshReport.touched + refreshReport.refreshed + refreshReport.archived + refreshReport.errors;
  assert.equal(processed, 2, `cap honoured: exactly 2 processed (got ${processed}); report=${JSON.stringify(refreshReport)}`);
});

// LLM-only cosine merge band (consolidate.cosineBandFloor):
//   - pairs in [bandFloor, threshold) are flagged ONLY when the LLM can
//     adjudicate them this run;
//   - in the band, an unreachable LLM means keep-both (skip), NEVER the
//     deterministic fallback-archive that >=threshold pairs keep;
//   - default-off: without the setting, sub-threshold pairs are invisible.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

process.env.MEMORY_LLM_PROVIDER = "mock";

const store = await import("../scripts/lib/wiki-store.mjs");
const { consolidateMemory } = await import("../scripts/consolidate.mjs");
const { __setSettingsForTest, __clearSettingsForTest } =
  await import("../scripts/lib/settings.mjs");
const { __resetMockCallIndex } = await import("../scripts/lib/llm.mjs");

const STATE_FILE = path.join(dataDir, "state", ".consolidate.json");

function clearState() {
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch {
    /* best effort */
  }
}

function resetEnv() {
  delete process.env.MEMORY_LLM_MOCK_RESPONSE;
  delete process.env.MEMORY_LLM_MOCK_FAIL_INDICES;
  __resetMockCallIndex();
  __clearSettingsForTest();
}
after(() => resetEnv());

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

function seed(name, text, errorPattern) {
  const r = store.saveDocument({
    name,
    text,
    datasetId: "self_improvement",
    metadata: {
      project_module: "billing",
      task_type: "refactor",
      area: "billing",
      error_pattern: errorPattern,
    },
  });
  if (!r.ok) throw new Error(`seed failed: ${JSON.stringify(r)}`);
  return r.created.document.id;
}

function readLeaf(documentId) {
  return store.readLeafForConsolidate({ documentId });
}

// Mostly-overlapping bodies: high lexical cosine but reliably below the
// 0.995 lexical threshold, landing in a [0.8, 0.995) band.
const BODY_X =
  "# Retry budget rule\n\nGive every outbound call a retry budget. Why: cascading retries amplify outages across services. How to apply: cap retries at two and add jitter between attempts. Budget exhaustion must surface as an error metric.";
const BODY_Y =
  "# Retry budget rule\n\nGive every outbound call a retry budget. Why: cascading retries amplify outages across services. How to apply: cap retries at two and add jitter between attempts. Exhausted budgets should page the on-call.";
const BODY_SAME =
  "# Idempotency keys\n\nUse idempotency keys on all mutating endpoints. Why: replays must be safe. How to apply: hash request identity into the key.";

// MERGE_SCHEMA requires keeper_id/loser_id; pickKeeper resolves equal
// `updated` dates by lex-ascending documentId, so the sorted pair is the
// (keeper, loser) the orchestrator will use.
const mergeResponseFor = (idA, idB) => {
  const [keeperId, loserId] = [idA, idB].sort();
  return JSON.stringify({
    action: "merge",
    merged_body: "MERGED BAND CONTENT",
    keeper_id: keeperId,
    loser_id: loserId,
    reason: "band pair judged duplicate",
  });
};
const MERGE_RESPONSE = JSON.stringify({
  action: "merge",
  merged_body: "MERGED BAND CONTENT",
  keeper_id: "placeholder-keeper",
  loser_id: "placeholder-loser",
  reason: "band pair judged duplicate",
});

const FLAGGED_BAND = (r) => {
  const p = r.passes["dedupe-by-cosine"] || {};
  return (p.entities || []).filter((e) => String(e.reason || "").includes("(band)"));
};

test("default-off: sub-threshold near-dups are invisible without cosineBandFloor", async () => {
  purgeActiveLeaves();
  clearState();
  resetEnv();
  process.env.MEMORY_LLM_MOCK_RESPONSE = MERGE_RESPONSE;
  const a = seed("lesson-band-off-a-2026-06-01-000000000.md", BODY_X, "band-off-a");
  const b = seed("lesson-band-off-b-2026-06-01-000000000.md", BODY_Y, "band-off-b");
  const r = await consolidateMemory({
    llm: true,
    now: new Date("2026-06-05T00:00:00Z"),
    passes: ["dedupe-by-cosine", "llm-merge-near-duplicates"],
  });
  assert.equal(r.ok, true);
  assert.equal(FLAGGED_BAND(r).length, 0, "no band flags when the setting is absent");
  assert.equal(readLeaf(a).active, true);
  assert.equal(readLeaf(b).active, true);
});

test("band merge: in-band pair is LLM-adjudicated; merge rewrites keeper and archives loser", async () => {
  purgeActiveLeaves();
  clearState();
  resetEnv();
  __setSettingsForTest({ consolidate: { cosineBandFloor: 0.8 } });
  const a = seed("lesson-band-merge-a-2026-06-01-000000000.md", BODY_X, "band-merge-a");
  const b = seed("lesson-band-merge-b-2026-06-01-000000000.md", BODY_Y, "band-merge-b");
  process.env.MEMORY_LLM_MOCK_RESPONSE = mergeResponseFor(a, b);
  const r = await consolidateMemory({
    llm: true,
    now: new Date("2026-06-05T00:00:00Z"),
    passes: ["dedupe-by-cosine", "llm-merge-near-duplicates"],
  });
  assert.equal(r.ok, true);
  assert.ok(
    FLAGGED_BAND(r).length >= 1,
    `band flag recorded: ${JSON.stringify(r.passes["dedupe-by-cosine"]?.entities)}`,
  );
  const leaves = [readLeaf(a), readLeaf(b)];
  const active = leaves.filter((l) => l.active);
  const archived = leaves.filter((l) => !l.active);
  assert.equal(active.length, 1, "one keeper");
  assert.equal(archived.length, 1, "one archived loser");
  assert.match(active[0].text, /MERGED BAND CONTENT/);
  assert.ok(archived[0].memory.supersedes_id, "loser carries supersedes_id");
});

test("band + LLM dies: pair is SKIPPED (both active), never blind-archived", async () => {
  purgeActiveLeaves();
  clearState();
  resetEnv();
  __setSettingsForTest({ consolidate: { cosineBandFloor: 0.8 } });
  process.env.MEMORY_LLM_MOCK_RESPONSE = MERGE_RESPONSE;
  process.env.MEMORY_LLM_MOCK_FAIL_INDICES = "0,1,2,3,4,5,6,7";
  const a = seed("lesson-band-fail-a-2026-06-01-000000000.md", BODY_X, "band-fail-a");
  const b = seed("lesson-band-fail-b-2026-06-01-000000000.md", BODY_Y, "band-fail-b");
  const r = await consolidateMemory({
    llm: true,
    now: new Date("2026-06-05T00:00:00Z"),
    passes: ["dedupe-by-cosine", "llm-merge-near-duplicates"],
  });
  assert.equal(r.ok, true);
  assert.equal(readLeaf(a).active, true, "leaf A survives the LLM outage");
  assert.equal(readLeaf(b).active, true, "leaf B survives the LLM outage");
});

test(">=threshold + LLM dies: deterministic fallback-archive is UNCHANGED", async () => {
  purgeActiveLeaves();
  clearState();
  resetEnv();
  __setSettingsForTest({ consolidate: { cosineBandFloor: 0.8 } });
  process.env.MEMORY_LLM_MOCK_RESPONSE = MERGE_RESPONSE;
  process.env.MEMORY_LLM_MOCK_FAIL_INDICES = "0,1,2,3,4,5,6,7";
  const a = seed("lesson-thresh-a-2026-06-01-000000000.md", BODY_SAME, "thresh-a");
  const b = seed("lesson-thresh-b-2026-06-01-000000000.md", BODY_SAME, "thresh-b");
  const r = await consolidateMemory({
    llm: true,
    now: new Date("2026-06-05T00:00:00Z"),
    passes: ["dedupe-by-cosine", "llm-merge-near-duplicates"],
  });
  assert.equal(r.ok, true);
  const actives = [readLeaf(a), readLeaf(b)].filter((l) => l.active);
  assert.equal(
    actives.length,
    1,
    "identical pair still collapses deterministically on LLM failure",
  );
});

test("no-LLM run: band pairs are never flagged; >=threshold pairs still archive", async () => {
  purgeActiveLeaves();
  clearState();
  resetEnv();
  __setSettingsForTest({ consolidate: { cosineBandFloor: 0.8 } });
  // Poison trip-wire: if anything consults the mock in a no-LLM run, the
  // response would be consumed — assert it is not.
  process.env.MEMORY_LLM_MOCK_RESPONSE = MERGE_RESPONSE;
  const a = seed("lesson-nollm-band-a-2026-06-01-000000000.md", BODY_X, "nollm-a");
  const b = seed("lesson-nollm-band-b-2026-06-01-000000000.md", BODY_Y, "nollm-b");
  const c = seed("lesson-nollm-same-a-2026-06-01-000000000.md", BODY_SAME, "nollm-c");
  const d = seed("lesson-nollm-same-b-2026-06-01-000000000.md", BODY_SAME, "nollm-d");
  const r = await consolidateMemory({
    llm: false,
    now: new Date("2026-06-05T00:00:00Z"),
    passes: ["dedupe-by-cosine", "llm-merge-near-duplicates"],
  });
  assert.equal(r.ok, true);
  assert.equal(FLAGGED_BAND(r).length, 0, "band inactive without LLM");
  assert.equal(readLeaf(a).active, true);
  assert.equal(readLeaf(b).active, true);
  const sameActives = [readLeaf(c), readLeaf(d)].filter((l) => l.active);
  assert.equal(sameActives.length, 1, ">=threshold pair archived deterministically");
  assert.match(readLeaf(a).text, /Retry budget/, "leaf content untouched");
});

test("dry-run with band: decisions reported, nothing written", async () => {
  purgeActiveLeaves();
  clearState();
  resetEnv();
  __setSettingsForTest({ consolidate: { cosineBandFloor: 0.8 } });
  process.env.MEMORY_LLM_MOCK_RESPONSE = MERGE_RESPONSE;
  const a = seed("lesson-band-dry-a-2026-06-01-000000000.md", BODY_X, "band-dry-a");
  const b = seed("lesson-band-dry-b-2026-06-01-000000000.md", BODY_Y, "band-dry-b");
  const r = await consolidateMemory({
    llm: true,
    dryRun: true,
    now: new Date("2026-06-05T00:00:00Z"),
    passes: ["dedupe-by-cosine", "llm-merge-near-duplicates"],
  });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.ok(FLAGGED_BAND(r).length >= 1, "band candidate visible in the dry-run report");
  assert.equal(readLeaf(a).active, true, "dry-run wrote nothing");
  assert.equal(readLeaf(b).active, true);
  assert.ok(!readLeaf(a).text.includes("MERGED BAND CONTENT"));
});

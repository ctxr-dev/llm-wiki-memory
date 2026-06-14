// End-to-end coverage for the three deterministic dedup passes in
// scripts/consolidate.mjs:
//   1. dedupe-by-sha256       — byte-identical leaves collapse to one keeper
//   2. dedupe-by-lesson-key   — self_improvement leaves sharing the composite
//      (project_module|area|task_type|error_pattern) collapse; empty
//      error_pattern is a sentinel that skips the pass; knowledge never runs it.
//   3. dedupe-by-cosine       — cluster pairs above the cosine threshold
//      collapse; the lexical backend auto-bumps the threshold to 0.995 so only
//      very-near-identical bodies trigger an archive.
//
// All runs disable LLM passes (llm:false) so finalize uses the deterministic
// "archive the loser, stamp memory.supersedes_id with the keeper id" path.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { setupWorkspace, cleanup } from "./harness.mjs";

// embed.backend = "lexical" is set by setupWorkspace via the test settings.yaml.

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const consolidateMod = await import("../scripts/consolidate.mjs");
const { consolidateMemory } = consolidateMod;

const NOW = new Date("2026-06-02T12:00:00Z");

function absFor(documentId) {
  return path.join(wiki, String(documentId).split("/").join(path.sep));
}

// Overwrite frontmatter.updated (and other fields) on an existing leaf so the
// keeper-selection tie-breaker is fully controlled by the test. Returns the
// (possibly unchanged) documentId.
function stampFrontmatter(documentId, patch) {
  const abs = absFor(documentId);
  const raw = fs.readFileSync(abs, "utf8");
  const parsed = matter(raw);
  const data = { ...parsed.data, ...patch };
  fs.writeFileSync(abs, matter.stringify(`\n${parsed.content.trim()}\n`, data, { lineWidth: -1 }));
  return documentId;
}

function readMemoryBlock(documentId) {
  const abs = absFor(documentId);
  const parsed = matter(fs.readFileSync(abs, "utf8"));
  return parsed.data?.memory || {};
}

function archivedCount(datasetId) {
  return store.listDocuments({ datasetId, enabled: false }).documents.length;
}

function activeIds(datasetId) {
  return store
    .listDocuments({ datasetId, enabled: true })
    .documents.map((d) => d.id)
    .sort();
}

// Run the dedup passes only (deterministic), with LLM disabled. The cluster
// passes need searchMemoryFiltered to surface the candidate, so we keep
// "dedupe-by-*" enabled. Other corpus passes are intentionally turned off to
// keep the working set untouched by orphan-archive / staleness side effects.
async function runDedupPasses({ passes }) {
  return consolidateMemory({
    dryRun: false,
    llm: false,
    passes,
    now: NOW,
  });
}

let seedCounter = 0;
function uniqueName(prefix) {
  seedCounter += 1;
  return `${prefix}-${seedCounter}-2026-05-22-120000000.md`;
}

// ─── (A) dedupe-by-sha256 ──────────────────────────────────────────────────

test("dedupe-by-sha256: two identical bodies → one archived, supersedes_id points to keeper", async () => {
  const body = "# SHA Dup A\n\nidentical body — two leaves with the same bytes should collapse to one keeper.";
  const aRes = store.saveDocument({
    name: uniqueName("lesson-sha-a"),
    text: body,
    datasetId: "self_improvement",
    metadata: {
      atom_type: "self-improvement-lesson",
      area: "shaDupA",
      task_type: "implementation",
      error_pattern: "sha-dup-pair-a",
    },
  });
  const bRes = store.saveDocument({
    name: uniqueName("lesson-sha-a"),
    text: body,
    datasetId: "self_improvement",
    metadata: {
      atom_type: "self-improvement-lesson",
      area: "shaDupA",
      task_type: "implementation",
      // distinct error_pattern so the lesson-key pass is not what archives
      // them (this test isolates the sha256 pass).
      error_pattern: "sha-dup-pair-a-other",
    },
  });
  const idA = aRes.created.document.id;
  const idB = bRes.created.document.id;
  assert.notEqual(idA, idB, "two distinct leaf ids were created");

  // Pin keeper: B is newer (2026-06-01) than A (2026-05-01).
  stampFrontmatter(idA, { updated: "2026-05-01" });
  stampFrontmatter(idB, { updated: "2026-06-01" });

  const beforeArchived = archivedCount("self_improvement");

  const r = await runDedupPasses({ passes: ["dedupe-by-sha256"] });
  assert.equal(r.ok, true, "consolidate ok");

  const afterArchived = archivedCount("self_improvement");
  assert.equal(
    afterArchived - beforeArchived,
    1,
    `exactly one new archived leaf (was ${beforeArchived}, now ${afterArchived})`,
  );

  const activeNow = activeIds("self_improvement");
  assert.ok(activeNow.includes(idB), "newer leaf B kept active");
  assert.ok(!activeNow.includes(idA), "older leaf A archived");

  const memA = readMemoryBlock(idA);
  assert.equal(memA.status, "archived", "A is archived");
  assert.equal(memA.supersedes_id, idB, "A.supersedes_id points to keeper B");
});

test("dedupe-by-sha256: keeper takes the MAX priority of the merged pair (P1 loser bumps P2 keeper)", async () => {
  const body = "# Prio Merge\n\nidentical body; the keeper must inherit the HIGHER priority of the merged pair.";
  const keeperRes = store.saveDocument({
    name: uniqueName("lesson-prio-keep"),
    text: body,
    datasetId: "self_improvement",
    metadata: {
      atom_type: "self-improvement-lesson",
      area: "prioMerge",
      task_type: "implementation",
      error_pattern: "prio-merge-keep",
      priority: "P2", // keeper starts LOWER
    },
  });
  const loserRes = store.saveDocument({
    name: uniqueName("lesson-prio-keep"),
    text: body,
    datasetId: "self_improvement",
    metadata: {
      atom_type: "self-improvement-lesson",
      area: "prioMerge",
      task_type: "implementation",
      error_pattern: "prio-merge-lose",
      priority: "P1", // loser is HIGHER -> must bump the keeper
    },
  });
  const keeperId = keeperRes.created.document.id;
  const loserId = loserRes.created.document.id;
  stampFrontmatter(keeperId, { updated: "2026-06-01" }); // newer -> survives as keeper
  stampFrontmatter(loserId, { updated: "2026-05-01" }); // older -> archived loser
  assert.equal(readMemoryBlock(keeperId).priority, "P2", "keeper starts P2");

  const r = await runDedupPasses({ passes: ["dedupe-by-sha256"] });
  assert.equal(r.ok, true);

  assert.ok(!activeIds("self_improvement").includes(loserId), "loser archived");
  assert.equal(readMemoryBlock(keeperId).priority, "P1", "keeper bumped P2 -> P1 (max of the pair)");
});

test("dedupe-by-sha256: three identical bodies → newest survives, two archived (chained supersedes)", async () => {
  const body = "# SHA Trio\n\nthe three bodies are byte-identical, only the keeper survives.";
  const leaves = ["2026-04-01", "2026-05-01", "2026-06-01"].map((updated, i) => {
    const res = store.saveDocument({
      name: uniqueName("lesson-sha-trio"),
      text: body,
      datasetId: "self_improvement",
      metadata: {
        atom_type: "self-improvement-lesson",
        area: "shaDupTrio",
        task_type: "implementation",
        error_pattern: `sha-trio-${i}`,
      },
    });
    const id = res.created.document.id;
    stampFrontmatter(id, { updated });
    return { id, updated };
  });
  const [oldest, middle, newest] = leaves;

  const beforeArchived = archivedCount("self_improvement");
  const r = await runDedupPasses({ passes: ["dedupe-by-sha256"] });
  assert.equal(r.ok, true);

  const afterArchived = archivedCount("self_improvement");
  assert.equal(
    afterArchived - beforeArchived,
    2,
    `exactly two new archived leaves (was ${beforeArchived}, now ${afterArchived})`,
  );

  const activeNow = new Set(activeIds("self_improvement"));
  assert.ok(activeNow.has(newest.id), "newest leaf kept active");
  assert.ok(!activeNow.has(oldest.id), "oldest leaf archived");
  assert.ok(!activeNow.has(middle.id), "middle leaf archived");

  // The per-leaf loop walks leaves in lex-ascending documentId order. The
  // working-set first sees `oldest`, whose cluster includes `middle` and
  // `newest`. pickKeeper picks the newer date for each pair, and once a leaf
  // is queued as loser it is added to touchedThisRun so a later iteration
  // cannot re-pair it. The deterministic outcome is therefore:
  //   - oldest is archived first, pointing to whichever cluster member won
  //     against it (middle, by date — newer than oldest);
  //   - middle is then archived in its own loop iteration, pointing to newest;
  //   - newest is the surviving keeper.
  // Both archived leaves end up with a supersedes_id that itself archived
  // resolves transitively back to `newest`.
  const oldestSupersedes = readMemoryBlock(oldest.id).supersedes_id;
  const middleSupersedes = readMemoryBlock(middle.id).supersedes_id;
  assert.ok(
    oldestSupersedes === middle.id || oldestSupersedes === newest.id,
    `oldest.supersedes_id points to a same-content peer (got ${oldestSupersedes})`,
  );
  assert.equal(middleSupersedes, newest.id, "middle supersedes_id → newest (the only newer peer)");
});

// ─── (B) dedupe-by-lesson-key ──────────────────────────────────────────────

test("dedupe-by-lesson-key: same composite key + different bodies → older archived", async () => {
  // Two leaves with the SAME (project_module, area, task_type, error_pattern)
  // but different bodies. Bodies are still semantically similar enough that
  // the lexical cluster surfaces them as members of each other's cluster.
  // Bodies share most tokens so the lexical cluster surfaces them as
  // members of each other's cluster (cluster score-threshold default 0.75).
  // The bodies are NOT byte-identical (so the sha256 pass would not also
  // claim this; we restrict the run to dedupe-by-lesson-key anyway).
  const sharedTokens =
    "tickets must include trace id when filed otherwise triage cannot proceed downstream";
  const bodyA = `# Lesson Key A\n\n${sharedTokens} alpha\n`;
  const bodyB = `# Lesson Key A\n\n${sharedTokens} beta\n`;
  const aRes = store.saveDocument({
    name: uniqueName("lesson-key-pair"),
    text: bodyA,
    datasetId: "self_improvement",
    metadata: {
      atom_type: "self-improvement-lesson",
      area: "lessonKeyZone",
      task_type: "debugging",
      error_pattern: "missing-trace-id-on-ticket",
    },
  });
  const bRes = store.saveDocument({
    name: uniqueName("lesson-key-pair"),
    text: bodyB,
    datasetId: "self_improvement",
    metadata: {
      atom_type: "self-improvement-lesson",
      area: "lessonKeyZone",
      task_type: "debugging",
      error_pattern: "missing-trace-id-on-ticket",
    },
  });
  const idA = aRes.created.document.id;
  const idB = bRes.created.document.id;
  stampFrontmatter(idA, { updated: "2026-05-01" });
  stampFrontmatter(idB, { updated: "2026-06-01" });

  const beforeArchived = archivedCount("self_improvement");

  // Only the lesson-key pass; explicitly turn off sha256 + cosine so this
  // test cannot be satisfied by a different pass.
  const r = await runDedupPasses({ passes: ["dedupe-by-lesson-key"] });
  assert.equal(r.ok, true);

  const afterArchived = archivedCount("self_improvement");
  assert.equal(
    afterArchived - beforeArchived,
    1,
    `exactly one new archive from lesson-key (was ${beforeArchived}, now ${afterArchived})`,
  );

  const activeNow = new Set(activeIds("self_improvement"));
  assert.ok(activeNow.has(idB), "newer leaf kept");
  assert.ok(!activeNow.has(idA), "older leaf archived");
  assert.equal(readMemoryBlock(idA).supersedes_id, idB, "supersedes_id → keeper");
});

test("dedupe-by-lesson-key: empty error_pattern → sentinel skip leaves both active", async () => {
  // Two self_improvement leaves with NO error_pattern: lessonKey() returns ""
  // and the pass short-circuits for them, so neither is archived even though
  // the other facets match.
  const bodyA = "# Empty EP A\n\nbody alpha for the empty-error-pattern sentinel test.";
  const bodyB = "# Empty EP B\n\nbody beta for the empty-error-pattern sentinel test, very similar to alpha alpha alpha.";

  const aRes = store.saveDocument({
    name: uniqueName("lesson-empty-ep"),
    text: bodyA,
    datasetId: "self_improvement",
    // saveDocument calls inferFacets; we deliberately omit error_pattern AND
    // pass placementOverride-style metadata through saveDocument is not
    // possible without going through writeMemory with placementOverride.
    // Instead we let inferFacets pick a placement, then patch the frontmatter
    // memory block below to clear error_pattern.
    metadata: {
      atom_type: "self-improvement-lesson",
      area: "emptyEpZone",
      task_type: "planning",
    },
  });
  const bRes = store.saveDocument({
    name: uniqueName("lesson-empty-ep"),
    text: bodyB,
    datasetId: "self_improvement",
    metadata: {
      atom_type: "self-improvement-lesson",
      area: "emptyEpZone",
      task_type: "planning",
    },
  });
  const idA = aRes.created.document.id;
  const idB = bRes.created.document.id;

  // Force empty error_pattern via direct frontmatter rewrite and pin updated
  // dates so a future pass cannot ambiguously select.
  function clearEp(id, updated) {
    const abs = absFor(id);
    const parsed = matter(fs.readFileSync(abs, "utf8"));
    const memory = { ...(parsed.data.memory || {}) };
    delete memory.error_pattern;
    fs.writeFileSync(
      abs,
      matter.stringify(`\n${parsed.content.trim()}\n`, { ...parsed.data, updated, memory }, { lineWidth: -1 }),
    );
  }
  clearEp(idA, "2026-05-01");
  clearEp(idB, "2026-06-01");

  const beforeArchived = archivedCount("self_improvement");

  const r = await runDedupPasses({ passes: ["dedupe-by-lesson-key"] });
  assert.equal(r.ok, true);

  const afterArchived = archivedCount("self_improvement");
  assert.equal(
    afterArchived - beforeArchived,
    0,
    `no new archived leaves — empty error_pattern is a sentinel skip (was ${beforeArchived}, now ${afterArchived})`,
  );

  const activeNow = new Set(activeIds("self_improvement"));
  assert.ok(activeNow.has(idA), "leaf A still active");
  assert.ok(activeNow.has(idB), "leaf B still active");
});

test("dedupe-by-lesson-key: knowledge-category leaves never run this pass", async () => {
  // Two knowledge leaves that, IF the pass ran on them, would share a lesson
  // key. Since lessonKey() only fires for self_improvement, both stay active.
  const body = "# Knowledge twin\n\ntwo knowledge leaves that share faux lesson-key facets.";
  const aRes = store.saveDocument({
    name: uniqueName("knowledge-twin"),
    text: body + " variant-alpha",
    datasetId: "knowledge",
    metadata: {
      atom_type: "reference",
      area: "knowledgeLessonKeyZone",
      task_type: "implementation",
      error_pattern: "knowledge-not-eligible-for-lesson-key",
    },
  });
  const bRes = store.saveDocument({
    name: uniqueName("knowledge-twin"),
    text: body + " variant-beta",
    datasetId: "knowledge",
    metadata: {
      atom_type: "reference",
      area: "knowledgeLessonKeyZone",
      task_type: "implementation",
      error_pattern: "knowledge-not-eligible-for-lesson-key",
    },
  });
  const idA = aRes.created.document.id;
  const idB = bRes.created.document.id;
  stampFrontmatter(idA, { updated: "2026-05-01" });
  stampFrontmatter(idB, { updated: "2026-06-01" });

  const beforeArchived = archivedCount("knowledge");

  const r = await runDedupPasses({ passes: ["dedupe-by-lesson-key"] });
  assert.equal(r.ok, true);

  const afterArchived = archivedCount("knowledge");
  assert.equal(
    afterArchived - beforeArchived,
    0,
    "lesson-key pass MUST NOT touch knowledge leaves",
  );
  const activeNow = new Set(activeIds("knowledge"));
  assert.ok(activeNow.has(idA), "knowledge leaf A active");
  assert.ok(activeNow.has(idB), "knowledge leaf B active");
});

// ─── (C) dedupe-by-cosine ──────────────────────────────────────────────────

test("dedupe-by-cosine: lexical-near-identical bodies collapse; mild variations don't", async () => {
  // Lexical backend + threshold 0.995. Two bodies built from the same token
  // bag (differ only by punctuation / one identical extra token) score 1.0,
  // so they collapse. A third body with different tokens stays below the
  // threshold and is left alone.
  //
  // We use unique error_pattern values so the lesson-key pass — even if it
  // accidentally fires — does not also claim this archive.
  const sharedTokens =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi";
  const bodyKeeper = `# Cosine Pair\n\n${sharedTokens}\n`;
  const bodyTwin = `# Cosine Pair!\n\n${sharedTokens}\n`; // same tokens after lowercase+split → cosine 1.0
  const bodyMild =
    "# Cosine Mild\n\ntotally unrelated phrase with brand new vocabulary nouns verbs adjectives sentinels barricades.";

  const aRes = store.saveDocument({
    name: uniqueName("lesson-cos-keeper"),
    text: bodyKeeper,
    datasetId: "self_improvement",
    metadata: {
      atom_type: "self-improvement-lesson",
      area: "cosineZoneA",
      task_type: "implementation",
      error_pattern: "cosine-keeper-uniq",
    },
  });
  const bRes = store.saveDocument({
    name: uniqueName("lesson-cos-twin"),
    text: bodyTwin,
    datasetId: "self_improvement",
    metadata: {
      atom_type: "self-improvement-lesson",
      area: "cosineZoneA",
      task_type: "implementation",
      error_pattern: "cosine-twin-uniq",
    },
  });
  const cRes = store.saveDocument({
    name: uniqueName("lesson-cos-mild"),
    text: bodyMild,
    datasetId: "self_improvement",
    metadata: {
      atom_type: "self-improvement-lesson",
      area: "cosineZoneA",
      task_type: "implementation",
      error_pattern: "cosine-mild-uniq",
    },
  });
  const idKeeper = aRes.created.document.id;
  const idTwin = bRes.created.document.id;
  const idMild = cRes.created.document.id;

  // Pin keeper newest so it wins the tiebreak.
  stampFrontmatter(idKeeper, { updated: "2026-06-01" });
  stampFrontmatter(idTwin, { updated: "2026-05-01" });
  stampFrontmatter(idMild, { updated: "2026-05-01" });

  const beforeArchived = archivedCount("self_improvement");

  // Cosine only, LLM off. The lexical backend bumps threshold to 0.995, so
  // only the byte-equal-after-tokenisation twin should clear it.
  const r = await runDedupPasses({ passes: ["dedupe-by-cosine"] });
  assert.equal(r.ok, true);

  const afterArchived = archivedCount("self_improvement");
  // Exactly one new archive: the twin. The mild leaf scores well below 0.995.
  assert.equal(
    afterArchived - beforeArchived,
    1,
    `cosine pass archived exactly the twin (was ${beforeArchived}, now ${afterArchived})`,
  );

  const activeNow = new Set(activeIds("self_improvement"));
  assert.ok(activeNow.has(idKeeper), "keeper survived");
  assert.ok(activeNow.has(idMild), "mild-variation leaf survived (below cosine threshold)");
  assert.ok(!activeNow.has(idTwin), "twin archived by cosine pass");

  assert.equal(
    readMemoryBlock(idTwin).supersedes_id,
    idKeeper,
    "twin.supersedes_id points to keeper",
  );
});

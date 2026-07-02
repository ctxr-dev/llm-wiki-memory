import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const { setupWorkspace, cleanup } = await import("./harness.mjs");

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

// Simplify the layout so seeded leaves don't require a `subject` facet — same
// approach as truncateArchivedBody.test.mjs. EVERY category declares
// `consolidate:` explicitly — the orchestrator refuses to run otherwise.
fs.writeFileSync(
  path.join(wiki, ".layout", "layout.yaml"),
  `mode: hosted
layout:
  - path: knowledge
    placement_facets: [area, atom_type]
    max_depth: 5
    consolidate: refine
  - path: self_improvement
    placement_facets: [area, task_type]
    max_depth: 5
    consolidate: refine
  - path: plans
    placement_facets: [area]
    max_depth: 5
    consolidate: none
  - path: investigations
    placement_facets: [area]
    max_depth: 5
    consolidate: none
  - path: daily
    placement_strategy: daily-date
    max_depth: 5
    consolidate: none
`,
);

const store = await import("../scripts/lib/wiki-store.mjs");
store._resetLayoutCacheForTests();

const { consolidateMemory } = await import("../scripts/consolidate.mjs");

// Frozen "now" for time-sensitive assertions across this whole file.
const NOW = new Date("2026-06-02T12:00:00Z");

function absFor(documentId) {
  return path.join(wiki, String(documentId).split("/").join(path.sep));
}

function readFm(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  return matter(raw);
}

// Stamp the on-disk `frontmatter.updated` (top-level) to simulate an aged leaf.
// `dateIso` may be a full ISO or YYYY-MM-DD; we store YYYY-MM-DD to match how
// renderLeaf writes it.
function setUpdated(absPath, dateIso) {
  const raw = fs.readFileSync(absPath, "utf8");
  const parsed = matter(raw);
  parsed.data.updated = String(dateIso).slice(0, 10);
  fs.writeFileSync(absPath, matter.stringify(parsed.content, parsed.data));
}

// Stamp arbitrary nested `memory.*` keys on disk (for last_recalled_at,
// status, consolidate_truncated_at, stale, etc.).
function setMemory(absPath, patch) {
  const raw = fs.readFileSync(absPath, "utf8");
  const parsed = matter(raw);
  parsed.data.memory = { ...(parsed.data.memory || {}), ...patch };
  fs.writeFileSync(absPath, matter.stringify(parsed.content, parsed.data));
}

let leafCounter = 0;
function uniqName(prefix) {
  leafCounter += 1;
  return `${prefix}-${leafCounter}-2026-05-22-120000000.md`;
}

function seedSelfImprovement({ name, body, metadata } = {}) {
  const res = store.writeMemory({
    name: name || uniqName("self-improvement-fixture"),
    text: body ?? "# Self-improvement fixture\n\nbody content.",
    datasetId: "self_improvement",
    metadata: {
      area: "auth",
      task_type: "debugging",
      error_pattern: `ep-${leafCounter}`,
      project_module: "testproj",
      ...(metadata || {}),
    },
  });
  return { documentId: res.created.document.id, absPath: absFor(res.created.document.id) };
}

function seedKnowledge({ name, body, metadata } = {}) {
  const res = store.writeMemory({
    name: name || uniqName("knowledge-fixture"),
    text: body ?? "# Knowledge fixture\n\nbody content.",
    datasetId: "knowledge",
    metadata: {
      area: "infra",
      atom_type: "pattern-gotcha",
      project_module: "testproj",
      ...(metadata || {}),
    },
  });
  return { documentId: res.created.document.id, absPath: absFor(res.created.document.id) };
}

// ─── (1) staleness-flag ────────────────────────────────────────────────────

test("staleness-flag: self_improvement leaf 7mo old with no last_recalled_at -> stale flips true", async () => {
  const { documentId, absPath } = seedSelfImprovement({
    name: uniqName("si-stale-flip"),
    body: "# stale candidate\n\nold lesson body.",
  });
  // 7 months before NOW: 2025-11-02. Default stale-after-months = 6.
  setUpdated(absPath, "2025-11-02");

  const before = readFm(absPath);
  assert.notEqual(before.data.memory.stale, true, "starts NOT stale");
  assert.ok(!before.data.memory.last_recalled_at);

  const r = await consolidateMemory({
    llm: false,
    now: NOW,
    passes: ["staleness-flag"],
  });
  assert.equal(r.ok, true);

  const fm = readFm(absFor(documentId));
  assert.equal(fm.data.memory.stale, true, `flipped to stale (got ${JSON.stringify(fm.data.memory.stale)})`);
});

test("staleness-flag: self_improvement leaf with recent `updated` + stale:true -> unflips", async () => {
  const { documentId, absPath } = seedSelfImprovement({
    name: uniqName("si-stale-unflip"),
    body: "# unflip candidate\n\nbody.",
  });
  // Recent `updated` (1mo before NOW, within staleAfterMonths=6) with a stale
  // flag left over — stalenessFlag must clear it.
  setUpdated(absPath, "2026-05-02");
  setMemory(absPath, { stale: true });

  const r = await consolidateMemory({
    llm: false,
    now: NOW,
    passes: ["staleness-flag"],
  });
  assert.equal(r.ok, true);

  const fm = readFm(absFor(documentId));
  assert.equal(fm.data.memory.stale, false, "stale flipped back to false after a recent update");
});

test("staleness-flag: knowledge leaf 7mo old NEVER gets the stale flag", async () => {
  const { documentId, absPath } = seedKnowledge({
    name: uniqName("k-no-stale"),
    body: "# knowledge no-stale\n\nbody.",
    metadata: { atom_type: "decision" }, // durable atom_type: NEVER stale-flagged
  });
  setUpdated(absPath, "2025-11-02");

  const before = readFm(absPath);
  assert.ok(!("stale" in before.data.memory), "knowledge starts without a stale field");

  const r = await consolidateMemory({
    llm: false,
    now: NOW,
    passes: ["staleness-flag"],
  });
  assert.equal(r.ok, true);

  const fm = readFm(absFor(documentId));
  assert.notEqual(
    fm.data.memory.stale,
    true,
    "knowledge leaf with atom_type=decision was NOT marked stale (durable type)",
  );
});

test("staleness-flag: knowledge leaf 7mo old with atom_type=pattern-gotcha IS marked stale", async () => {
  // I-1 (review round 2): bug-root-cause / feedback-rule / pattern-gotcha
  // knowledge atoms ARE eligible for stale-flagging (and therefore the
  // llm-semantic-refresh pass can revisit them). Durable atom_types
  // (decision / reference / project-lore) remain excluded.
  const { documentId, absPath } = seedKnowledge({
    name: uniqName("k-pattern-stale"),
    body: "# stale pattern\n\nold gotcha.",
    metadata: { atom_type: "pattern-gotcha" },
  });
  setUpdated(absPath, "2025-11-02");

  const r = await consolidateMemory({
    llm: false,
    now: NOW,
    passes: ["staleness-flag"],
  });
  assert.equal(r.ok, true);

  const fm = readFm(absFor(documentId));
  assert.equal(
    fm.data.memory.stale,
    true,
    "knowledge leaf with eligible atom_type was flagged stale",
  );
});

// ─── (2) prune-orphan-leaves ───────────────────────────────────────────────

test("prune-orphan-leaves: archives an unlinked, ancient, never-recalled pattern-gotcha", async () => {
  const { documentId, absPath } = seedKnowledge({
    name: uniqName("k-orphan"),
    body: "# orphan\n\nno links, never recalled.",
    metadata: { atom_type: "pattern-gotcha" },
  });
  // > 365 days old (default orphan TTL).
  setUpdated(absPath, "2024-01-01");

  const r = await consolidateMemory({
    llm: false,
    now: NOW,
    passes: ["prune-orphan-leaves"],
  });
  assert.equal(r.ok, true);

  const fm = readFm(absFor(documentId));
  assert.equal(fm.data.memory.status, "archived", "orphan archived");
  assert.ok(fm.data.memory.consolidated_at, "consolidated_at stamped");
});

test("prune-orphan-leaves: a [[name-of-A]] link from B keeps A alive even when old", async () => {
  // Seed A first, then seed B with a body that references A by its leaf name.
  const a = seedKnowledge({
    name: uniqName("k-linked-A"),
    body: "# anchor A\n\ndocs about A.",
    metadata: { atom_type: "pattern-gotcha" },
  });
  setUpdated(a.absPath, "2024-01-01"); // ancient
  const aName = path.basename(a.absPath);

  const b = seedKnowledge({
    name: uniqName("k-linked-B"),
    body: `# refs A\n\nsee [[${aName}]] for the gotcha.`,
    metadata: { atom_type: "pattern-gotcha" },
  });
  // Keep B fresh so B itself is not orphaned (it has no inbound either).
  setUpdated(b.absPath, "2026-05-30");

  const r = await consolidateMemory({
    llm: false,
    now: NOW,
    passes: ["prune-orphan-leaves"],
  });
  assert.equal(r.ok, true);

  const fmA = readFm(a.absPath);
  assert.notEqual(fmA.data.memory.status, "archived", "linked A stayed active");
});

test("prune-orphan-leaves: excludes atom_type=reference even when ancient and unlinked", async () => {
  const { documentId, absPath } = seedKnowledge({
    name: uniqName("k-orphan-reference"),
    body: "# reference\n\nlong-lived reference, no inbound.",
    metadata: { atom_type: "reference" },
  });
  setUpdated(absPath, "2024-01-01");

  const r = await consolidateMemory({
    llm: false,
    now: NOW,
    passes: ["prune-orphan-leaves"],
  });
  assert.equal(r.ok, true);

  const fm = readFm(absFor(documentId));
  assert.notEqual(fm.data.memory.status, "archived", "reference is NOT orphan-pruned");
});

// ─── (3) compress-archived ─────────────────────────────────────────────────

const FOOTER_RE =
  /\n\n\[truncated by consolidate at (.+?); original sha256 preserved in frontmatter\.source\.hash\]\n$/;

test("compress-archived: archived leaf with big body + old `updated` is truncated + stamped", async () => {
  const bigBody = "# big archived\n\n" + "a".repeat(5000);
  const { documentId, absPath } = seedKnowledge({
    name: uniqName("k-compress-big"),
    body: bigBody,
    metadata: { atom_type: "reference" },
  });
  // Archive (sets memory.status=archived) and age it past the default
  // archive-age-days (30).
  const disabled = store.disableDocument({ documentId, datasetId: "knowledge" });
  assert.equal(disabled.ok, true);
  setUpdated(absPath, "2026-04-01"); // ~60 days before NOW

  const r = await consolidateMemory({
    llm: false,
    now: NOW,
    passes: ["compress-archived"],
  });
  assert.equal(r.ok, true);

  const fm = readFm(absFor(documentId));
  assert.match(fm.content, FOOTER_RE, "footer present");
  assert.ok(fm.data.memory.consolidate_truncated_at, "consolidate_truncated_at stamped");
  const head = fm.content.replace(FOOTER_RE, "");
  assert.ok(head.length <= 1200, `head <= default body cap (got ${head.length})`);
});

test("compress-archived: already-truncated leaf is a no-op", async () => {
  const bigBody = "# already truncated\n\n" + "b".repeat(5000);
  const { documentId, absPath } = seedKnowledge({
    name: uniqName("k-compress-noop"),
    body: bigBody,
    metadata: { atom_type: "reference" },
  });
  store.disableDocument({ documentId, datasetId: "knowledge" });
  setUpdated(absPath, "2026-04-01");
  setMemory(absPath, { consolidate_truncated_at: "2026-05-01T00:00:00.000Z" });

  const beforeBytes = fs.readFileSync(absPath, "utf8");

  const r = await consolidateMemory({
    llm: false,
    now: NOW,
    passes: ["compress-archived"],
  });
  assert.equal(r.ok, true);

  const afterBytes = fs.readFileSync(absPath, "utf8");
  assert.equal(afterBytes, beforeBytes, "file unchanged on second compress pass");

  const fm = readFm(absPath);
  assert.equal(
    fm.data.memory.consolidate_truncated_at,
    "2026-05-01T00:00:00.000Z",
    "existing stamp preserved",
  );
});

test("compress-archived: active leaf with a big body is NEVER touched", async () => {
  const bigBody = "# active big\n\n" + "c".repeat(5000);
  const { documentId, absPath } = seedKnowledge({
    name: uniqName("k-compress-active"),
    body: bigBody,
    metadata: { atom_type: "reference" },
  });
  // Active (NOT disabled); old `updated` to clear the age filter if the pass
  // mistakenly looked at active leaves.
  setUpdated(absPath, "2026-04-01");

  const beforeBytes = fs.readFileSync(absPath, "utf8");

  const r = await consolidateMemory({
    llm: false,
    now: NOW,
    passes: ["compress-archived"],
  });
  assert.equal(r.ok, true);

  const afterBytes = fs.readFileSync(absPath, "utf8");
  assert.equal(afterBytes, beforeBytes, "active leaf body untouched by compress");

  const fm = readFm(absPath);
  assert.ok(!fm.data.memory.consolidate_truncated_at, "no stamp on the active leaf");
  assert.notEqual(fm.data.memory.status, "archived", "still active");
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();

// Pin a deterministic no-subject layout so placement is purely
// area/atom_type/task_type. Mirrors wiki-store.test.mjs convention.
fs.writeFileSync(
  path.join(wiki, ".layout", "layout.yaml"),
  `mode: hosted
layout:
  - path: knowledge
    placement_facets: [area, atom_type]
    max_depth: 5
  - path: self_improvement
    placement_facets: [area, task_type]
    max_depth: 5
  - path: plans
    placement_facets: [area]
    max_depth: 5
  - path: investigations
    placement_facets: [area]
    max_depth: 5
  - path: daily
    placement_strategy: daily-date
    max_depth: 5
`,
);

const store = await import("../scripts/lib/wiki-store.mjs");
const { __setSettingsForTest, __clearSettingsForTest } = await import("../scripts/lib/settings.mjs");
store._resetLayoutCacheForTests();

after(() => cleanup(dataDir));

// Per-test settings overrides — the recall-touch knobs live in
// settings.yaml's `recall:` section, but tests need quick overrides without
// touching disk. Each test that mutates them is paired with the seam.
function setRecallTouch({ enabled, minHours } = {}) {
  const recall = {};
  if (enabled !== undefined) recall.touchEnabled = enabled;
  if (minHours !== undefined) recall.touchMinHours = minHours;
  __setSettingsForTest({ recall });
}
function restoreTouchEnv() {
  __clearSettingsForTest();
}
function snapshotTouchEnv() { return {}; }

function readLeafMemory(documentId) {
  const abs = path.join(wiki, ...String(documentId).split("/"));
  const raw = fs.readFileSync(abs, "utf8");
  const parsed = matter(raw);
  return (parsed.data && parsed.data.memory) || {};
}

function seedLeaf({ name, text, area, atomType = "reference", tags = [] }) {
  const r = store.writeMemory({
    name,
    text,
    datasetId: "knowledge",
    metadata: { atom_type: atomType, area, tags: tags.join(",") },
  });
  assert.ok(r.created, `seed ${name} created`);
  return r.created.document.id;
}

test("(1) first search above threshold stamps last_recalled_at and recall_count=1", async () => {
  const envSnap = snapshotTouchEnv();
  __clearSettingsForTest();

  const id = seedLeaf({
    name: "recall-touch-stamp-first.md",
    text: "# First touch\n\nIndex rebuild on hot paths is expensive and should be avoided.",
    area: "perf",
  });

  const before = readLeafMemory(id);
  assert.equal(before.last_recalled_at, undefined, "no last_recalled_at before search");
  assert.equal(before.recall_count, undefined, "no recall_count before search");

  const res = await store.searchMemoryFiltered({
    query: "index rebuild hot paths expensive avoided",
    datasetId: "knowledge",
    filters: { area: "perf" },
    scoreThreshold: 0,
  });
  assert.ok(res.records.length >= 1, "search returned the leaf");
  assert.ok(res.records.some((r) => r.documentId === id), "target leaf in records");

  const after1 = readLeafMemory(id);
  assert.ok(
    typeof after1.last_recalled_at === "string" && after1.last_recalled_at.length > 0,
    `last_recalled_at stamped (got: ${JSON.stringify(after1.last_recalled_at)})`,
  );
  assert.equal(after1.recall_count, 1, "recall_count === 1 after first touch");

  restoreTouchEnv(envSnap);
});

test("(2) second search within 24h is throttled (no update)", async () => {
  const envSnap = snapshotTouchEnv();
  __clearSettingsForTest();

  const id = seedLeaf({
    name: "recall-touch-throttled.md",
    text: "# Throttle me\n\nCircuit breakers protect downstream services from cascading failures.",
    area: "resilience",
  });

  // First search to populate stamp.
  const r1 = await store.searchMemoryFiltered({
    query: "circuit breakers protect downstream cascading failures",
    datasetId: "knowledge",
    filters: { area: "resilience" },
    scoreThreshold: 0,
  });
  assert.ok(r1.records.some((r) => r.documentId === id), "first search hit");
  const after1 = readLeafMemory(id);
  const stamp1 = after1.last_recalled_at;
  const count1 = after1.recall_count;
  assert.ok(stamp1, "stamp set after first search");
  assert.equal(count1, 1, "recall_count===1 after first search");

  // Second search WITHOUT advancing time. Throttle window default 24h.
  const r2 = await store.searchMemoryFiltered({
    query: "circuit breakers protect downstream cascading failures",
    datasetId: "knowledge",
    filters: { area: "resilience" },
    scoreThreshold: 0,
  });
  assert.ok(r2.records.some((r) => r.documentId === id), "second search hit");
  const after2 = readLeafMemory(id);
  assert.equal(after2.last_recalled_at, stamp1, "last_recalled_at unchanged (throttled)");
  assert.equal(after2.recall_count, count1, "recall_count unchanged (throttled)");

  restoreTouchEnv(envSnap);
});

test("(3) once the throttle window has elapsed, the next search bumps recall_count", async () => {
  const envSnap = snapshotTouchEnv();
  // Use a 1h throttle window and back-date the leaf's last_recalled_at by 2h
  // to step past the window deterministically (no real wall-clock advance
  // needed).
  setRecallTouch({ minHours: 1 });

  const id = seedLeaf({
    name: "recall-touch-elapsed.md",
    text: "# Elapsed window\n\nIdempotent retries require deterministic request identifiers across attempts.",
    area: "reliability",
  });

  const r1 = await store.searchMemoryFiltered({
    query: "idempotent retries deterministic request identifiers",
    datasetId: "knowledge",
    filters: { area: "reliability" },
    scoreThreshold: 0,
  });
  assert.ok(r1.records.some((r) => r.documentId === id));
  const after1 = readLeafMemory(id);
  assert.equal(after1.recall_count, 1, "count is 1 after first touch");

  // Back-date the stamp by 2 hours so the 1h throttle window is past.
  const abs = path.join(wiki, ...id.split("/"));
  const raw = fs.readFileSync(abs, "utf8");
  const parsed = matter(raw);
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  parsed.data.memory = { ...parsed.data.memory, last_recalled_at: twoHoursAgo };
  fs.writeFileSync(abs, matter.stringify(`\n${parsed.content.trim()}\n`, parsed.data, { lineWidth: -1 }));

  const r2 = await store.searchMemoryFiltered({
    query: "idempotent retries deterministic request identifiers",
    datasetId: "knowledge",
    filters: { area: "reliability" },
    scoreThreshold: 0,
  });
  assert.ok(r2.records.some((r) => r.documentId === id));
  const after2 = readLeafMemory(id);
  assert.equal(after2.recall_count, 2, "recall_count bumped to 2 after window elapsed");
  assert.notEqual(
    after2.last_recalled_at,
    twoHoursAgo,
    "last_recalled_at re-stamped after window elapsed",
  );

  restoreTouchEnv(envSnap);
});

test("(4) MEMORY_RECALL_TOUCH=off writes nothing; last_recalled_at stays absent", async () => {
  const envSnap = snapshotTouchEnv();
  setRecallTouch({ enabled: false });

  const id = seedLeaf({
    name: "recall-touch-disabled.md",
    text: "# Disabled\n\nBackpressure signals must propagate end-to-end across queue boundaries.",
    area: "queues",
  });

  const res = await store.searchMemoryFiltered({
    query: "backpressure signals propagate queue boundaries",
    datasetId: "knowledge",
    filters: { area: "queues" },
    scoreThreshold: 0,
  });
  assert.ok(res.records.some((r) => r.documentId === id), "leaf still returned by search");

  const mem = readLeafMemory(id);
  assert.equal(mem.last_recalled_at, undefined, "no stamp when MEMORY_RECALL_TOUCH=off");
  assert.equal(mem.recall_count, undefined, "no count when MEMORY_RECALL_TOUCH=off");

  restoreTouchEnv(envSnap);
});

test("(5) below-threshold record is NOT touched", async () => {
  const envSnap = snapshotTouchEnv();
  __clearSettingsForTest();

  const id = seedLeaf({
    name: "recall-touch-below-threshold.md",
    text: "# Below threshold\n\nQuokkas are small marsupials that live on Rottnest Island in Australia.",
    area: "trivia",
  });

  // Threshold of 1.1 is unreachable by cosine similarity (max is 1.0), so any
  // record that survives the .filter(scoreThreshold) above will never trip the
  // touch. We pass an unrelated query to drive scores down too. Either way:
  // any record present in `records` must NOT be touched if its score < threshold.
  // The implementation applies the threshold in BOTH the records filter AND the
  // touch gate, so records that come through always satisfy the threshold; we
  // verify the touch-gate path by checking with a high threshold that records
  // is empty AND the seed leaf remains untouched.
  const res = await store.searchMemoryFiltered({
    query: "unrelated query about distributed consensus protocols",
    datasetId: "knowledge",
    filters: { area: "trivia" },
    scoreThreshold: 1.1,
  });
  assert.equal(res.records.length, 0, "nothing exceeds threshold of 1.1");

  const mem = readLeafMemory(id);
  assert.equal(mem.last_recalled_at, undefined, "below-threshold leaf NOT touched");
  assert.equal(mem.recall_count, undefined, "below-threshold leaf NOT touched");

  restoreTouchEnv(envSnap);
});

test("(6) errors during touch do NOT propagate to the caller", async () => {
  const envSnap = snapshotTouchEnv();
  __clearSettingsForTest();

  const id = seedLeaf({
    name: "recall-touch-error-swallow.md",
    text: "# Error swallow\n\nSaga compensations must be commutative under retry to keep state convergent.",
    area: "sagas",
  });

  // The recall-touch path calls updateDocMetadata, which persists the leaf via
  // writeFileAtomic — write-to-temp, then fs.renameSync(tmp, leaf) to publish.
  // It NEVER calls fs.writeFileSync, so patch the rename: throw when it
  // publishes to THIS leaf, simulating a failed frontmatter write. The SEARCH
  // itself must still succeed and return records (touch is best-effort).
  const targetAbs = path.join(wiki, ...id.split("/"));
  const originalRename = fs.renameSync;
  let throwsObserved = 0;
  fs.renameSync = function patched(from, to) {
    try {
      if (path.resolve(String(to)) === path.resolve(targetAbs)) {
        throwsObserved += 1;
        throw new Error("simulated touch write failure");
      }
    } catch (e) {
      if (e && e.message === "simulated touch write failure") throw e;
      // ignore resolve errors and fall through to the real rename
    }
    return originalRename.call(this, from, to);
  };

  let res;
  try {
    res = await store.searchMemoryFiltered({
      query: "saga compensations commutative under retry convergent",
      datasetId: "knowledge",
      filters: { area: "sagas" },
      scoreThreshold: 0,
    });
  } finally {
    fs.renameSync = originalRename;
  }

  assert.ok(res, "search returned a result envelope despite touch error");
  assert.ok(
    res.records.some((r) => r.documentId === id),
    "search records include the leaf even though touch threw",
  );
  assert.ok(throwsObserved >= 1, "the patched write WAS invoked (touch path attempted)");

  // The frontmatter write was rejected, so the stamp must NOT be present on disk.
  const mem = readLeafMemory(id);
  assert.equal(mem.last_recalled_at, undefined, "stamp absent because the write threw");

  restoreTouchEnv(envSnap);
});

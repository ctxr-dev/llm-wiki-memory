import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const recall = await import("../scripts/lib/recall.mjs");
const store = await import("../scripts/lib/wiki-store.mjs");

test("saveLesson requires project_module, task_type, error_pattern", () => {
  assert.throws(
    () => recall.saveLesson({ title: "x", body: "y", metadata: { project_module: "auth" } }),
    /requires/,
  );
});

test("saveLesson lands in self_improvement and is recallable", async () => {
  const r = recall.saveLesson({
    title: "Always await async database calls",
    body: "Always await async database calls before reading results.",
    metadata: {
      project_module: "testproj",
      task_type: "implementation",
      error_pattern: "missing-await-async",
    },
    tags: ["async", "database"],
  });
  assert.ok(r.created, "lesson created");
  assert.equal(r.datasetSlot, "self_improvement");

  const out = await recall.recallLessons({
    query: "await async database",
    project_module: "testproj",
    task_type: "implementation",
    error_pattern: "missing-await-async",
  });
  assert.ok(out.lessonHits >= 1, "exact-filter recall finds the lesson");
  assert.match(out.records[0].documentName, /^lesson-/);
});

test("recall fall-back ladder broadens by dropping error_pattern", async () => {
  // A different error_pattern that does NOT match the saved lesson; the ladder
  // must drop error_pattern and still surface the project's lessons.
  const out = await recall.recallLessons({
    query: "async database",
    project_module: "testproj",
    task_type: "implementation",
    error_pattern: "totally-unrelated-pattern",
  });
  assert.ok(out.lessonHits >= 1, "broadened recall still finds lessons");
  assert.ok(out.ladderUsed.length >= 1, "ladder recorded a broadening rung");
});

test("recall appends supplementary knowledge cross-refs", async () => {
  const k = store.saveDocument({
    name: "knowledge-stale-cache-2026-05-22-120000000.md",
    text: "# Stale cache after migrate\n\nInvalidate the cache after a schema migration.",
    datasetId: "knowledge",
    metadata: {
      atom_type: "bug-root-cause",
      project_module: "testproj",
      error_pattern: "stale-cache",
    },
  });
  assert.ok(k.created);

  const out = await recall.recallLessons({
    query: "cache migration database",
    project_module: "testproj",
    includeKnowledge: true,
  });
  assert.ok(out.supplementaryHits >= 1, "bug-root-cause knowledge appended");
  assert.ok(out.records.some((r) => r.kind === "knowledge"));
});

test("sub-module lessons are recalled by DEFAULT (project_module=workspace) + area scopes", async () => {
  const r = recall.saveLesson({
    title: "Frontend cards must render derived badges",
    body: "Backtest cards derive badges from data, not hardcoded values.\nWhy: avoid misleading identical values.",
    metadata: { area: "frontend", task_type: "implementation", error_pattern: "hardcoded-badge" },
    tags: ["cards", "badges"],
  });
  assert.ok(r.created, "lesson created");

  // project_module is stamped to the workspace; the sub-module lives in `area`.
  const doc = store.readDocument({
    documentId: r.created.document.id,
    datasetId: "self_improvement",
  });
  assert.equal(doc.metadata.area, "frontend", "area = sub-module");
  assert.equal(
    doc.metadata.project_module,
    "testproj",
    "project_module = workspace, not the sub-module",
  );

  // THE FIX: default recall (no project_module, no area) finds the sub-module-tagged
  // lesson. Previously the workspace-vs-submodule mismatch returned 0 hits.
  const def = await recall.recallLessons({ query: "cards badges derived" });
  assert.ok(def.lessonHits >= 1, "default recall finds the sub-module-tagged lesson");

  // Explicit area narrows to the sub-module.
  const scoped = await recall.recallLessons({ query: "cards badges", area: "frontend" });
  assert.ok(scoped.lessonHits >= 1, "area-scoped recall finds it");

  // An over-tight area still recovers via the final-rung drop (area then project_module).
  const broadened = await recall.recallLessons({ query: "cards badges", area: "no-such-area" });
  assert.ok(broadened.lessonHits >= 1, "over-tight area scope recovers by dropping area");
});

test("searchMemory ranks the matching leaf across categories", async () => {
  const out = await recall.searchMemory({
    query: "stale cache after migrate schema",
    filters: { project_module: "testproj" },
  });
  assert.ok(out.totalRecords >= 1);
  assert.ok(
    out.records.some((r) => r.documentName.includes("stale-cache")),
    "matching leaf present in results",
  );
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const recall = await import("../scripts/lib/recall.mjs");
const { migrate } = await import("../scripts/migrate.mjs");

// Seed a leaf in the LEGACY shape: project_module = a sub-module (not the
// workspace), no `area`. The project_module_override hatch reproduces a pre-split
// leaf (the current writer otherwise stamps the workspace).
function seedLegacy({ name, text, datasetId, submodule, extra = {} }) {
  return store.writeMemory({
    name,
    text,
    datasetId,
    metadata: { project_module_override: submodule, ...extra },
  });
}

test("migrate: legacy project_module -> area, stamps workspace, relocates, default recall works", async () => {
  const lesson = seedLegacy({
    name: "lesson-cards-2026-05-25-120000000.md",
    text: "# Frontend cards derived badges\n\nCards derive badges from data, not hardcoded values.\nWhy: avoid identical values.",
    datasetId: "self_improvement",
    submodule: "frontend",
    extra: { atom_type: "self-improvement-lesson", task_type: "implementation", error_pattern: "hardcoded-badge" },
  });
  const pre = store.readDocument({ documentId: lesson.created.document.id, datasetId: "self_improvement" });
  assert.equal(pre.metadata.project_module, "frontend", "seeded legacy project_module = sub-module");
  assert.ok(!pre.metadata.area, "no area yet (legacy shape)");

  const res = migrate({});
  assert.equal(res.ok, true, `migrate validates clean: ${JSON.stringify(res.validate)}`);
  assert.ok(res.migrated >= 1, "migrated at least the seeded leaf");

  // The leaf relocated from the unscoped facet to its area facet; re-find by name.
  const found = store
    .listDocuments({ datasetId: "self_improvement", enabled: "true" })
    .documents.find((d) => d.name === "lesson-cards-2026-05-25-120000000.md");
  assert.ok(found && /^self_improvement\/frontend\/implementation\//.test(found.id), `relocated under area facet: ${found?.id}`);
  const post = store.readDocument({ documentId: found.id, datasetId: "self_improvement" });
  assert.equal(post.metadata.project_module, "testproj", "project_module stamped to the workspace");
  assert.equal(post.metadata.area, "frontend", "area = the former sub-module");

  // The headline fix: default recall (no project_module / no area) now finds it.
  const out = await recall.recallLessons({ query: "cards derived badges" });
  assert.ok(out.lessonHits >= 1, "default recall finds the migrated lesson");

  // Idempotent: a second pass finds nothing to migrate.
  const chk = migrate({ check: true });
  assert.equal(chk.ok, true, `no legacy leaves remain: ${JSON.stringify(chk)}`);
});

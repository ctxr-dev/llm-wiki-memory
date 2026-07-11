import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  const res = store.writeMemory({
    name,
    text,
    datasetId,
    metadata: { project_module_override: submodule, ...extra },
  });
  // The writer now stamps a valid `area` via facet inference; strip it on disk
  // to reproduce the true pre-split legacy shape (project_module = sub-module,
  // no area) that migrate is supposed to fix.
  const abs = join(wiki, res.created.document.id);
  writeFileSync(abs, readFileSync(abs, "utf8").replace(/\n[ \t]*area:[^\n]*/g, ""));
  return res;
}

test("migrate: legacy project_module -> area, stamps workspace, relocates, default recall works", async () => {
  const lesson = seedLegacy({
    name: "lesson-cards-2026-05-25-120000000.md",
    text: "# Frontend cards derived badges\n\nCards derive badges from data, not hardcoded values.\nWhy: avoid identical values.",
    datasetId: "self_improvement",
    submodule: "frontend",
    extra: {
      atom_type: "self-improvement-lesson",
      task_type: "implementation",
      error_pattern: "hardcoded-badge",
    },
  });
  const pre = store.readDocument({
    documentId: lesson.created.document.id,
    datasetId: "self_improvement",
  });
  assert.equal(
    pre.metadata.project_module,
    "frontend",
    "seeded legacy project_module = sub-module",
  );
  assert.ok(!pre.metadata.area, "no area yet (legacy shape)");

  const res = migrate({});
  assert.equal(res.ok, true, `migrate validates clean: ${JSON.stringify(res.validate)}`);
  assert.ok(res.migrated >= 1, "migrated at least the seeded leaf");

  // The leaf relocated from the unscoped facet to its area facet; re-find by name.
  const found = store
    .listDocuments({ datasetId: "self_improvement", enabled: "true" })
    .documents.find((d) => d.name === "lesson-cards-2026-05-25-120000000.md");
  assert.ok(
    found && /^self_improvement\/frontend\/implementation\//.test(found.id),
    `relocated under area facet: ${found?.id}`,
  );
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

test("migrate: pre-split leaf with NO project_module gets the workspace stamped", async () => {
  // The writer always stamps project_module = workspace, so reproduce a pre-split
  // unscoped leaf by stripping that line on disk. Without a stamped workspace, the
  // default recall/search scope (which auto-injects the workspace) would never
  // match it.
  const doc = store.writeMemory({
    name: "unscoped-note-2026-05-25-130000000.md",
    text: "# Gateway cert rotation\n\nRotate the gateway certificate before the quarterly audit window.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference" },
  });
  const id = doc.created.document.id;
  const abs = join(wiki, id);
  // The writer now always stamps BOTH project_module (workspace) and a valid
  // area (facet inference), so reproduce the pre-split shape by stripping both.
  writeFileSync(
    abs,
    readFileSync(abs, "utf8").replace(/\n[ \t]*(project_module|area):[^\n]*/g, ""),
  );
  const pre = store.readDocument({ documentId: id, datasetId: "knowledge" });
  assert.ok(!pre.metadata.project_module, "leaf now has no project_module (pre-split shape)");
  assert.ok(!pre.metadata.area, "leaf now has no area (pre-split shape)");

  const res = migrate({});
  assert.equal(res.ok, true, `migrate validates clean: ${JSON.stringify(res.validate)}`);

  const found = store
    .listDocuments({ datasetId: "knowledge", enabled: "true" })
    .documents.find((d) => d.name === "unscoped-note-2026-05-25-130000000.md");
  assert.ok(found, "leaf still present after migrate");
  const post = store.readDocument({ documentId: found.id, datasetId: "knowledge" });
  assert.equal(
    post.metadata.project_module,
    "testproj",
    "workspace stamped so the default scope matches",
  );
  assert.ok(!post.metadata.area, "area stays empty -> the unscoped facet");

  // Idempotent: the now-stamped leaf is not re-selected.
  const chk = migrate({ check: true });
  assert.equal(chk.ok, true, `idempotent: no pending leaves remain: ${JSON.stringify(chk)}`);
});

test("migrate: a deliberate cross-project leaf (override + area) is left untouched", async () => {
  // A cross-project save sets project_module via the override AND carries its own
  // area. Its project_module deliberately differs from this workspace; migrate must
  // NOT restamp it (the `!hasArea` guard), or it would corrupt the cross-project scope.
  const doc = store.writeMemory({
    name: "crossproj-note-2026-05-25-140000000.md",
    text: "# Shared infra decision\n\nThe gateway is owned by the platform project, not this one.",
    datasetId: "knowledge",
    metadata: { project_module_override: "otherproj", area: "infra", atom_type: "reference" },
  });
  const id = doc.created.document.id;
  const pre = store.readDocument({ documentId: id, datasetId: "knowledge" });
  assert.equal(pre.metadata.project_module, "otherproj", "seeded cross-project project_module");
  assert.equal(pre.metadata.area, "infra", "seeded with its own area");

  migrate({});

  const found = store
    .listDocuments({ datasetId: "knowledge", enabled: "true" })
    .documents.find((d) => d.name === "crossproj-note-2026-05-25-140000000.md");
  assert.ok(found, "cross-project leaf still present");
  const post = store.readDocument({ documentId: found.id, datasetId: "knowledge" });
  assert.equal(
    post.metadata.project_module,
    "otherproj",
    "cross-project scope preserved, not restamped",
  );
  assert.equal(post.metadata.area, "infra", "area preserved");
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
const store = await import("../scripts/lib/wiki-store.mjs");
const { executeAction } = await import("../scripts/compile-actions.mjs");
const { defaultProjectModule } = await import("../scripts/lib/env.mjs");
after(() => cleanup(dataDir));

/**
 * @param {string} name
 * @param {Record<string, unknown>} [metadata]
 * @returns {string}
 */
function seedLesson(name, metadata = {}) {
  const r = store.saveDocument({
    name,
    text: `# ${name}\n\n- type: self-improvement-lesson\n\nunique lesson body ${name}.`,
    datasetId: "self_improvement",
    metadata: {
      atom_type: "self-improvement-lesson",
      area: "billing",
      task_type: "debugging",
      error_pattern: "npe-on-null",
      ...metadata,
    },
  });
  if (!r.ok) throw new Error(`seed failed for ${name}: ${JSON.stringify(r)}`);
  return r.created.document.id;
}

/** @param {string} id @returns {import("../scripts/lib/types.mjs").MemoryMetadata} */
function metaOf(id) {
  return /** @type {import("../scripts/lib/types.mjs").MemoryMetadata} */ (
    store.readDocument({ documentId: id, datasetId: "self_improvement" }).metadata
  );
}

/** @param {{created?: {document?: {id?: string}, id?: string}}} res */
function newIdOf(res) {
  return res.created?.document?.id || res.created?.id;
}

/**
 * @param {string} supersedes
 * @param {string} documentName
 * @param {Record<string, unknown>} [atomMeta]
 * @param {string} [title]
 */
function updateInputs(supersedes, documentName, atomMeta = {}, title = "merged lesson") {
  const atom = {
    type: "self-improvement-lesson",
    title,
    metadata: {
      area: "billing",
      task_type: "debugging",
      error_pattern: "npe-on-null",
      ...atomMeta,
    },
    tags: [],
  };
  const decision = {
    action: "update",
    supersedes,
    merged_text: "merged lesson body text",
    merged_name: title,
  };
  /** @type {import("../scripts/lib/types.mjs").SearchHit} */
  const candidate = {
    datasetId: "self_improvement",
    documentId: supersedes,
    documentName,
    score: 0.9,
    priority: "P2",
    content: "old body",
  };
  return { atom, decision, candidate };
}

test("compile update PRESERVES a superseded P0 lesson's priority (no silent P0->P1 downgrade)", async () => {
  const id = seedLesson("keeper-p0.md", { priority: "P0", project_module_override: "acme/other" });
  assert.equal(metaOf(id).priority, "P0", "seeded P0");
  assert.equal(metaOf(id).project_module, "acme/other", "seeded cross-project identity");

  const { atom, decision, candidate } = updateInputs(id, "keeper-p0.md", {}, "merged p0 lesson");
  const res = await executeAction(atom, decision, [candidate], "self_improvement");
  assert.ok(res.ok, `update ok: ${JSON.stringify(res)}`);

  const m = metaOf(/** @type {string} */ (newIdOf(res)));
  assert.equal(
    m.priority,
    "P0",
    "P0 PRESERVED through the merge (was rebuilt at the P1 rubric default)",
  );
  assert.equal(
    m.project_module,
    "acme/other",
    "cross-project identity PRESERVED through the merge",
  );
});

test("compile update lets the NEW atom's explicit priority win over the superseded", async () => {
  const id = seedLesson("keeper-explicit.md", { priority: "P0" });
  const { atom, decision, candidate } = updateInputs(
    id,
    "keeper-explicit.md",
    { priority: "P2" },
    "merged explicit lesson",
  );
  const res = await executeAction(atom, decision, [candidate], "self_improvement");
  assert.ok(res.ok, `update ok: ${JSON.stringify(res)}`);
  assert.equal(
    metaOf(/** @type {string} */ (newIdOf(res))).priority,
    "P2",
    "the new atom's explicit priority wins over the superseded lesson's",
  );
});

test("compile update does NOT propagate a superseded PRE-SPLIT leaf's sub-module project_module (guard)", async () => {
  // A pre-split legacy leaf's project_module is a SUB-MODULE alias, not the
  // workspace, and it carries NO `area`. Preserving it would mis-stamp the stale
  // sub-module as the new leaf's workspace identity, so the merge must fall back
  // to the workspace default. The engine always stamps a fallback `area`, so
  // reproduce the pre-split shape via frontmatter surgery (as migrate.test does).
  const id = seedLesson("presplit.md");
  const abs = join(wiki, id);
  writeFileSync(
    abs,
    readFileSync(abs, "utf8")
      .replace(/\n[ \t]*area:[^\n]*/g, "")
      .replace(/\n([ \t]*)project_module:[^\n]*/g, "\n$1project_module: legacysub"),
  );
  assert.equal(metaOf(id).project_module, "legacysub", "reproduced a sub-module project_module");
  assert.ok(!metaOf(id).area, "and NO area (the pre-split shape)");

  const { atom, decision, candidate } = updateInputs(
    id,
    "presplit.md",
    {},
    "merged presplit lesson",
  );
  const res = await executeAction(atom, decision, [candidate], "self_improvement");
  assert.ok(res.ok, `update ok: ${JSON.stringify(res)}`);
  assert.equal(
    metaOf(/** @type {string} */ (newIdOf(res))).project_module,
    defaultProjectModule(),
    "the stale sub-module is NOT propagated as the workspace; falls back to default",
  );
});

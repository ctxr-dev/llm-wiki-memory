import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir } = setupWorkspace();
const store = await import("../scripts/lib/wiki-store.mjs");
const { updateDocMetadata } = await import("../scripts/lib/wiki-relocate.mjs");
const { preserveIdentityOnResave } = await import("../scripts/lib/wiki-identity.mjs");
const { defaultProjectModule } = await import("../scripts/lib/env.mjs");
const { saveLesson } = await import("../scripts/lib/recall.mjs");
after(() => cleanup(dataDir));

/**
 * @param {string} name
 * @param {Record<string, unknown>} [metadata]
 * @returns {string}
 */
function seedKnowledge(name, metadata = {}) {
  const res = store.saveDocument({
    name,
    text: `# ${name}\n\nunique body ${name} for the re-stamp identity guard.`,
    datasetId: "knowledge",
    metadata: {
      atom_type: "reference",
      area: "billing",
      subject: ["observability", "kamon"],
      ...metadata,
    },
  });
  if (!res.ok) throw new Error(`seed failed for ${name}: ${JSON.stringify(res)}`);
  return res.created.document.id;
}

/**
 * @param {string} id
 * @param {string} [datasetId]
 * @returns {import("../scripts/lib/types.mjs").MemoryMetadata}
 */
function metaOf(id, datasetId = "knowledge") {
  return /** @type {import("../scripts/lib/types.mjs").MemoryMetadata} */ (
    store.readDocument({ documentId: id, datasetId }).metadata
  );
}

// ─── the pure helper ─────────────────────────────────────────────────────────

test("preserveIdentityOnResave re-supplies an existing module as the override", () => {
  const out = preserveIdentityOnResave({ area: "billing" }, { project_module: "acme/other" });
  assert.equal(out.project_module_override, "acme/other", "existing identity re-supplied");
  assert.equal(out.area, "billing", "other fields carried through");
});

test("preserveIdentityOnResave respects an explicit override (no clobber of a re-identification)", () => {
  const out = preserveIdentityOnResave(
    { project_module_override: "acme/new" },
    { project_module: "acme/other" },
  );
  assert.equal(out.project_module_override, "acme/new", "caller's re-identification wins");
});

test("preserveIdentityOnResave leaves metadata unchanged when the leaf has no identity", () => {
  const md = { area: "infra" };
  assert.equal(preserveIdentityOnResave(md, {}), md, "same reference, untouched");
  assert.equal(preserveIdentityOnResave(md, null), md, "null memory tolerated");
});

test("preserveIdentityOnResave tolerates null/blank inputs", () => {
  assert.deepEqual(preserveIdentityOnResave(null, { project_module: "acme/x" }), {
    project_module_override: "acme/x",
  });
  const blank = preserveIdentityOnResave(
    { project_module_override: "   " },
    { project_module: "acme/other" },
  );
  assert.equal(
    blank.project_module_override,
    "acme/other",
    "a blank override is treated as absent",
  );
});

// ─── updateDocMetadata: identity is preserved on a partial re-stamp ───────────

test("updateDocMetadata keeps a cross-project project_module on a partial (stale) stamp", () => {
  const id = seedKnowledge("cross.md", { project_module_override: "acme/other" });
  assert.equal(metaOf(id).project_module, "acme/other", "seeded cross-project identity");

  const res = updateDocMetadata({ documentId: id, metadata: { stale: true } });
  assert.equal(res.ok, true, `stamp ok: ${JSON.stringify(res)}`);
  const m = metaOf(id);
  assert.equal(m.project_module, "acme/other", "identity PRESERVED, not clobbered to default");
  assert.equal(m.stale, true, "the stamp landed");
  assert.equal(m.area, "billing", "area preserved");
  assert.equal(m.atom_type, "reference", "atom_type preserved");
  assert.deepEqual(m.subject, ["observability", "kamon"], "subject preserved");
});

test("updateDocMetadata re-identifies when the caller passes an explicit override", () => {
  const id = seedKnowledge("reident.md", { project_module_override: "acme/other" });
  const res = updateDocMetadata({
    documentId: id,
    metadata: { project_module_override: "acme/new" },
  });
  assert.equal(res.ok, true);
  assert.equal(metaOf(id).project_module, "acme/new", "explicit override applied");
});

test("updateDocMetadata leaves a default-module leaf on the default identity", () => {
  const id = seedKnowledge("plain.md");
  const def = defaultProjectModule();
  assert.equal(metaOf(id).project_module, def, "seeded with the workspace default");
  updateDocMetadata({ documentId: id, metadata: { stale: true } });
  assert.equal(metaOf(id).project_module, def, "still the default after a stamp");
});

// ─── updateDocMetadata: priority is preserved on a partial re-stamp ───────────

test("updateDocMetadata keeps an existing priority on a partial stamp (no P0/P1 -> P2 downgrade)", () => {
  const id = seedKnowledge("p0.md", { priority: "P0", project_module_override: "acme/other" });
  assert.equal(metaOf(id).priority, "P0", "seeded P0");

  updateDocMetadata({
    documentId: id,
    metadata: { stale: true, consolidated_at: "2026-01-01T00:00:00Z" },
  });
  const m = metaOf(id);
  assert.equal(m.priority, "P0", "P0 PRESERVED through a consolidate-style stamp");
  assert.equal(m.consolidated_at, "2026-01-01T00:00:00Z", "the stamp landed");
});

test("updateDocMetadata still applies an EXPLICIT priority (backfill path)", () => {
  const id = seedKnowledge("bump.md", { priority: "P2" });
  updateDocMetadata({ documentId: id, metadata: { priority: "P1" } });
  assert.equal(metaOf(id).priority, "P1", "an explicit priority update is honoured");
});

test("updateDocMetadata treats an INVALID priority as not-set (preserves existing, no P2 clobber)", () => {
  const id = seedKnowledge("badpri.md", { priority: "P0" });
  updateDocMetadata({ documentId: id, metadata: { priority: "P9", stale: true } });
  assert.equal(
    metaOf(id).priority,
    "P0",
    "an invalid priority string does not clobber the existing P0",
  );
});

// ─── the consolidate merge/refresh re-save mechanism (store.saveDocument) ─────

test("a raw re-save clobbers a cross-project module; preserveIdentityOnResave prevents it", () => {
  const idA = seedKnowledge("resave-raw.md", { project_module_override: "acme/other" });
  const rawMem = metaOf(idA);
  // What consolidate merge/refresh USED to do: re-emit the leaf's own memory raw.
  store.saveDocument({
    name: "resave-raw.md",
    text: "# resave-raw.md\n\nrewritten body raw.",
    datasetId: "knowledge",
    metadata: rawMem,
    placementOverride: idA.split("/").slice(0, -1).join("/"),
  });
  assert.equal(
    metaOf(idA).project_module,
    defaultProjectModule(),
    "raw re-save DID clobber (control)",
  );

  const idB = seedKnowledge("resave-fixed.md", { project_module_override: "acme/other" });
  const fixedMem = metaOf(idB);
  // What they do NOW: preserve the identity via the helper.
  store.saveDocument({
    name: "resave-fixed.md",
    text: "# resave-fixed.md\n\nrewritten body fixed.",
    datasetId: "knowledge",
    metadata: preserveIdentityOnResave(fixedMem, fixedMem),
    placementOverride: idB.split("/").slice(0, -1).join("/"),
  });
  assert.equal(
    metaOf(idB).project_module,
    "acme/other",
    "helper PRESERVED the identity on re-save",
  );
});

// ─── save_lesson: a repo-target lesson carries the stamped identity ───────────

test("save_lesson passes project_module_override through to the stored lesson", () => {
  const res = saveLesson({
    title: "prefer resource() over apply for validated construction",
    body: "Use a smart constructor for validated resources.",
    metadata: {
      area: "billing",
      task_type: "refactor",
      error_pattern: "apply-for-validated-construction",
      project_module_override: "acme/shared-repo",
    },
  });
  assert.equal(res.datasetSlot, "self_improvement");
  const m = metaOf(res.created.document.id, "self_improvement");
  assert.equal(m.project_module, "acme/shared-repo", "repo-target identity stamped on the lesson");
});

test("save_lesson without an override stamps the workspace default (control)", () => {
  const res = saveLesson({
    title: "always read the model sources before writing tests",
    body: "Read the source first.",
    metadata: {
      area: "billing",
      task_type: "testing",
      error_pattern: "tests-before-sources",
    },
  });
  const m = metaOf(res.created.document.id, "self_improvement");
  assert.equal(m.project_module, defaultProjectModule(), "default identity when no override");
});

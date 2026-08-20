import { test, after } from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir } = setupWorkspace();
const store = await import("../scripts/lib/wiki-store.mjs");
const { mergeLeafMetadata } = await import("../scripts/lib/wiki-metadata-patch.mjs");
const { updateDocMetadata } = await import("../scripts/lib/wiki-relocate.mjs");
const { disableDocument } = await import("../scripts/lib/wiki-lifecycle.mjs");
const { toAbs } = await import("../scripts/lib/wiki-identity.mjs");
after(() => cleanup(dataDir));

/**
 * @param {string} name
 * @param {Record<string, unknown>} [metadata]
 * @returns {string}
 */
function seedKnowledge(name, metadata = {}) {
  const res = store.saveDocument({
    name,
    text: `# ${name}\n\ndistinct body for ${name} exercising the metadata patch door.`,
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
 * @returns {import("../scripts/lib/types.mjs").MemoryMetadata}
 */
function metaOf(id) {
  return /** @type {import("../scripts/lib/types.mjs").MemoryMetadata} */ (
    store.readDocument({ documentId: id, datasetId: "knowledge" }).metadata
  );
}

test("mergeLeafMetadata refuses a DIVERGENT status and names the lifecycle doors", () => {
  const res = mergeLeafMetadata(
    { atom_type: "reference", status: "active", priority: "P1" },
    { status: "archived" },
  );
  assert.equal(res.ok, false, "a status change is refused, not silently dropped");
  if (res.ok) return;
  assert.equal(res.field, "status");
  assert.deepEqual(res.allowed, ["disable_document", "enable_document"]);
  assert.match(res.reason, /disable_document/, "the refusal names the door that owns status");
});

test("mergeLeafMetadata accepts an ECHOED status (the migrate-identity re-stamp path)", () => {
  const res = mergeLeafMetadata(
    { atom_type: "reference", status: "archived", priority: "P1" },
    { atom_type: "reference", status: "archived", area: "risk" },
  );
  assert.equal(res.ok, true, "re-stamping the leaf's OWN status must keep working");
  if (!res.ok) return;
  assert.equal(res.merged.status, "archived");
  assert.equal(res.merged.area, "risk");
});

test("mergeLeafMetadata treats a missing existing status as active", () => {
  const refused = mergeLeafMetadata({ atom_type: "reference" }, { status: "archived" });
  assert.equal(refused.ok, false, "a status-less leaf is active; archiving it diverges");
  const echoed = mergeLeafMetadata({ atom_type: "reference" }, { status: "active" });
  assert.equal(echoed.ok, true, "echoing the implicit active status is accepted");
});

test("mergeLeafMetadata preserves atom_type / priority / identity on a partial patch", () => {
  const res = mergeLeafMetadata(
    {
      atom_type: "decision",
      priority: "P0",
      project_module: "acme/other",
      status: "active",
      area: "billing",
    },
    { area: "risk" },
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.merged.atom_type, "decision", "atom_type is not clobbered to empty");
  assert.equal(res.merged.priority, "P0", "apply-strength is not downgraded by the rubric");
  assert.equal(res.merged.project_module, "acme/other", "cross-project identity survives");
  assert.equal(res.merged.area, "risk", "the patched facet is applied");
});

test("mergeLeafMetadata applies an EXPLICIT valid priority", () => {
  const res = mergeLeafMetadata({ atom_type: "reference", priority: "P2" }, { priority: "P1" });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.merged.priority, "P1");
});

test("updateDocMetadata refuses a divergent status and leaves the leaf byte-identical", () => {
  const id = seedKnowledge("metadata-patch-status-guard");
  const abs = toAbs(id);
  const before = fs.readFileSync(abs, "utf8");
  const res = updateDocMetadata({
    datasetId: "knowledge",
    documentId: id,
    metadata: { status: "archived" },
  });
  assert.equal(res.ok, false, "the engine refuses rather than silently dropping status");
  assert.equal(/** @type {{ field?: string }} */ (res).field, "status");
  assert.equal(fs.readFileSync(abs, "utf8"), before, "nothing was written");
  assert.equal(metaOf(id).status, "active");
});

test("updateDocMetadata keeps an ARCHIVED leaf archived through a partial facet patch", () => {
  const id = seedKnowledge("metadata-patch-archived-leaf");
  assert.equal(disableDocument({ documentId: id, datasetId: "knowledge" }).ok, true);
  assert.equal(metaOf(id).status, "archived", "precondition: the leaf is archived");
  const res = updateDocMetadata({
    datasetId: "knowledge",
    documentId: id,
    metadata: { area: "risk" },
    placementOverride: id.split("/").slice(0, -1).join("/"),
  });
  assert.equal(res.ok, true);
  assert.equal(
    metaOf(id).status,
    "archived",
    "a facet patch must never resurrect an archived leaf",
  );
  assert.equal(metaOf(id).area, "risk");
});

test("updateDocMetadata still relocates on a facet change after the extraction", () => {
  const id = seedKnowledge("metadata-patch-relocation");
  const res = updateDocMetadata({
    datasetId: "knowledge",
    documentId: id,
    metadata: { area: "fraud" },
  });
  assert.equal(res.ok, true);
  const to = /** @type {{ relocated?: { to: string } }} */ (res).relocated?.to;
  assert.ok(to && to.startsWith("knowledge/fraud/"), `relocated under the new area, got ${to}`);
  assert.equal(fs.existsSync(toAbs(id)), false, "the old path is gone");
});

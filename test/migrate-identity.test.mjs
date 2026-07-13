import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir } = setupWorkspace();
const store = await import("../scripts/lib/wiki-store.mjs");
const { migrateProjectModuleIdentity } = await import("../scripts/migrate-identity.mjs");
after(() => cleanup(dataDir));

/**
 * @param {string} name
 * @param {string} projectModule
 * @param {Record<string, unknown>} [extra]
 * @returns {string}
 */
function seed(name, projectModule, extra = {}) {
  const res = store.saveDocument({
    name,
    text: `# ${name}\n\nunique body ${name} for the identity migration.`,
    datasetId: "knowledge",
    metadata: {
      atom_type: "reference",
      area: "billing",
      subject: ["observability", "kamon"],
      priority: "P0",
      project_module_override: projectModule,
      ...extra,
    },
  });
  return res.created.document.id;
}

/** @param {string} id @returns {import("../scripts/lib/types.mjs").MemoryMetadata} */
function metaOf(id) {
  return /** @type {import("../scripts/lib/types.mjs").MemoryMetadata} */ (
    store.readDocument({ documentId: id, datasetId: "knowledge" }).metadata
  );
}

test("migrate-identity: restamps a legacy basename project_module to the new identity, preserving other fields", () => {
  const id = seed("t1.md", "legacyone");
  const res = migrateProjectModuleIdentity({ newId: "acme/widgets", oldId: "legacyone" });
  assert.equal(res.mode, "migrate");
  assert.equal(res.migrated, 1, "the one legacy leaf is restamped");
  assert.equal(res.ok, true, "the tree stays valid");
  const m = metaOf(id);
  assert.equal(m.project_module, "acme/widgets", "project_module rewritten to the new identity");
  assert.equal(m.area, "billing", "area preserved");
  assert.equal(m.priority, "P0", "priority preserved (not re-defaulted)");
  assert.deepEqual(m.subject, ["observability", "kamon"], "subject preserved");
});

test("migrate-identity: a re-run is a clean no-op (nothing still on the legacy id)", () => {
  seed("t2.md", "legacytwo");
  const first = migrateProjectModuleIdentity({ newId: "acme/two", oldId: "legacytwo" });
  assert.equal(first.migrated, 1);
  const second = migrateProjectModuleIdentity({ newId: "acme/two", oldId: "legacytwo" });
  assert.equal(
    second.migrated,
    0,
    "idempotent: the restamped leaf no longer matches the legacy id",
  );
});

test("migrate-identity: --dry-run reports pending without mutating", () => {
  const id = seed("t3.md", "legacythree");
  const res = migrateProjectModuleIdentity({
    newId: "acme/three",
    oldId: "legacythree",
    dryRun: true,
  });
  assert.equal(res.mode, "dry-run");
  assert.equal(res.pending, 1);
  assert.ok(res.changes.includes(id), "the leaf is listed");
  assert.equal(metaOf(id).project_module, "legacythree", "leaf left untouched by dry-run");
});

test("migrate-identity: --check fails while pending, passes once migrated", () => {
  seed("t4.md", "legacyfour");
  const before = migrateProjectModuleIdentity({
    newId: "acme/four",
    oldId: "legacyfour",
    check: true,
  });
  assert.equal(before.ok, false, "check reports pending work");
  assert.equal(before.pending, 1);
  migrateProjectModuleIdentity({ newId: "acme/four", oldId: "legacyfour" });
  const after2 = migrateProjectModuleIdentity({
    newId: "acme/four",
    oldId: "legacyfour",
    check: true,
  });
  assert.equal(after2.ok, true, "check is clean after migration");
});

test("migrate-identity: leaves on a different project_module (deliberate cross-project) are untouched", () => {
  const id = seed("t5.md", "other/project");
  const res = migrateProjectModuleIdentity({ newId: "acme/five", oldId: "legacyfive" });
  assert.equal(res.migrated, 0, "no leaf matches the legacy id");
  assert.equal(metaOf(id).project_module, "other/project", "the cross-project leaf is left alone");
});

test("migrate-identity: an unchanged identity (new === old) is a documented no-op", () => {
  seed("t6.md", "samesame");
  const res = migrateProjectModuleIdentity({ newId: "samesame", oldId: "samesame" });
  assert.equal(res.migrated, 0);
  assert.equal(res.reason, "identity-unchanged");
});

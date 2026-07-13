// B-lifecycle-idempotency (§4 contract rows, C23) — the document-mutation
// idempotency guarantees, via the store lifecycle seam (no bootstrap / git /
// network). disable/enable are RESULT-stable (they re-write the leaf + emit a
// recordWikiChange every call, so they are NOT commit-no-ops — §4 note a — hence
// we assert the stable end STATE, not commit counts); delete is graceful on a
// missing leaf. Additive per C19 (lifecycle.e2e covers the compile/promote flow,
// not these repeat-operation contracts).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup } from "../harness.mjs";

const { dataDir } = setupWorkspace();
const store = await import("../../scripts/lib/wiki-store.mjs");
after(() => cleanup(dataDir));

let counter = 0;
/** @returns {string} the new leaf's documentId */
function seed() {
  const name = `lc-${counter++}.md`;
  const { created } = /** @type {{ created: { document: { id: string } } }} */ (
    store.saveDocument({
      name,
      text: `# ${name}\n\nlifecycle idempotency probe body for ${name}.`,
      datasetId: "knowledge",
      metadata: { atom_type: "reference" },
    })
  );
  return created.document.id;
}

/** @param {string} id @param {boolean} enabled */
function inListing(id, enabled) {
  return store
    .listDocuments({ datasetId: "knowledge", enabled })
    .documents.some((/** @type {{ id: string }} */ d) => d.id === id);
}

test("idempotency: disabling an already-archived leaf is a stable no-op (stays archived, no error)", () => {
  const id = seed();
  const first = store.disableDocument({ documentId: id, datasetId: "knowledge" });
  const second = store.disableDocument({ documentId: id, datasetId: "knowledge" });
  assert.equal(first.ok, true);
  assert.equal(first.status, "archived");
  assert.equal(second.ok, true, "a 2nd disable does not error");
  assert.equal(second.status, "archived", "the leaf is still archived");
  assert.ok(inListing(id, false), "present in the disabled listing");
  assert.ok(!inListing(id, true), "absent from the active listing");
});

test("idempotency: enabling an already-active leaf is a stable no-op (stays active, no error)", () => {
  const id = seed();
  store.disableDocument({ documentId: id, datasetId: "knowledge" });
  const first = store.enableDocument({ documentId: id, datasetId: "knowledge" });
  const second = store.enableDocument({ documentId: id, datasetId: "knowledge" });
  assert.equal(first.ok, true);
  assert.equal(first.status, "active");
  assert.equal(second.ok, true, "a 2nd enable does not error");
  assert.equal(second.status, "active", "the leaf is still active");
  assert.ok(inListing(id, true), "present in the active listing");
  assert.ok(!inListing(id, false), "absent from the disabled listing");
});

test("idempotency: deleting twice is graceful — the 2nd returns a not-found envelope, not a throw", () => {
  const id = seed();
  const first = store.deleteDocument({ documentId: id, datasetId: "knowledge" });
  assert.equal(first.ok, true, "the 1st delete succeeds");
  const second = store.deleteDocument({ documentId: id, datasetId: "knowledge" });
  assert.equal(second.ok, false, "the 2nd delete does not throw");
  assert.match(String(second.reason), /not found/i, "the 2nd delete reports not-found");
  assert.ok(!inListing(id, true) && !inListing(id, false), "the leaf is gone from both listings");
});

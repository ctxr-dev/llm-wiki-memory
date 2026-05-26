import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const cli = await import("../scripts/lib/wiki-cli.mjs");

// Helper: text long enough to satisfy any min-length on writeMemory body.
function bodyFor(name) {
  return `# ${name}\n\nA test leaf body that's long enough to pass min-length checks.`;
}

test("writeMemory with placementOverride writes to the exact relative path", () => {
  const res = store.writeMemory({
    name: "DEV-129957.md",
    text: bodyFor("DEV-129957"),
    datasetId: "knowledge",
    metadata: { atom_type: "jira_issue", area: "hermes-service" },
    placementOverride: "knowledge/issues/JIRA/DEV/129/95/7",
  });
  assert.equal(
    res.created.document.id,
    "knowledge/issues/JIRA/DEV/129/95/7/dev-129957.md",
    "leaf landed at the override path (filename was kebabbed by normalizeLeafName)",
  );
  assert.ok(
    fs.existsSync(path.join(wiki, "knowledge/issues/JIRA/DEV/129/95/7/dev-129957.md")),
    "file exists on disk at the verbatim casing under issues/JIRA/DEV/",
  );
});

test("placementOverride preserves CASING in directory segments (no slugify)", () => {
  store.writeMemory({
    name: "DEV-200001.md",
    text: bodyFor("DEV-200001"),
    datasetId: "knowledge",
    metadata: { atom_type: "jira_issue", area: "hermes-service" },
    placementOverride: "knowledge/issues/JIRA/DEV/200/0/1",
  });
  assert.ok(
    fs.existsSync(path.join(wiki, "knowledge/issues/JIRA/DEV/200/0/1/dev-200001.md")),
    "uppercase JIRA and DEV folder segments preserved verbatim",
  );
});

test("placementOverride rejects path-traversal segments", () => {
  assert.throws(
    () =>
      store.writeMemory({
        name: "evil.md",
        text: bodyFor("evil"),
        datasetId: "knowledge",
        placementOverride: "knowledge/../../../etc",
      }),
    /\.\./,
    "rejects `..` segments",
  );
});

test("placementOverride rejects absolute paths", () => {
  assert.throws(
    () =>
      store.writeMemory({
        name: "abs.md",
        text: bodyFor("abs"),
        datasetId: "knowledge",
        placementOverride: "/tmp/evil",
      }),
    /relative to the wiki root/,
  );
});

test("placementOverride rejects empty / non-string values", () => {
  assert.throws(
    () =>
      store.writeMemory({
        name: "x.md",
        text: bodyFor("x"),
        datasetId: "knowledge",
        placementOverride: "",
      }),
    /non-empty string/,
  );
  assert.throws(
    () =>
      store.writeMemory({
        name: "x.md",
        text: bodyFor("x"),
        datasetId: "knowledge",
        placementOverride: 42,
      }),
    /non-empty string/,
  );
});

test("writeMemory WITHOUT placementOverride is unchanged (facet placement)", () => {
  const res = store.writeMemory({
    name: "backwards-compat-leaf.md",
    text: bodyFor("backwards"),
    datasetId: "knowledge",
    metadata: { atom_type: "decision", project_module: "billing" },
  });
  assert.match(
    res.created.document.id,
    /^knowledge\/billing\/decision\/backwards-compat-leaf\.md$/,
    "default facet-derived path still used when no override is supplied",
  );
});

test("saveDocument with placementOverride scopes existence check to override path only (no broad relocate)", () => {
  // Note: the skill enforces globally-unique leaf IDs across the wiki, so a
  // caller using placementOverride must keep basenames distinct — that's the
  // Jira hook's convention (knowledge file `<KEY>.md`, plan files
  // `<KEY>-<slug>.plan.md`). This test exercises that placementOverride does
  // NOT trigger a broad cross-facet findByName scan: a different leaf at a
  // different override path with a DIFFERENT basename is untouched by a save.
  const r1 = store.saveDocument({
    name: "DEV-300001.md",
    text: bodyFor("DEV-300001"),
    datasetId: "knowledge",
    metadata: { atom_type: "jira_issue", area: "hermes-service" },
    placementOverride: "knowledge/issues/JIRA/DEV/300/0/1",
  });
  assert.equal(
    r1.created.document.id,
    "knowledge/issues/JIRA/DEV/300/0/1/dev-300001.md",
  );

  // A second save with a DIFFERENT basename at the SAME override path: distinct
  // file, no relocate.
  const r2 = store.saveDocument({
    name: "DEV-300001-investigate-timeout.plan.md",
    text: bodyFor("DEV-300001 plan"),
    datasetId: "knowledge",
    metadata: { atom_type: "plan", area: "hermes-service" },
    placementOverride: "knowledge/issues/JIRA/DEV/300/0/1",
  });
  assert.equal(
    r2.created.document.id,
    "knowledge/issues/JIRA/DEV/300/0/1/dev-300001-investigate-timeout-plan.md",
  );
  assert.equal(r2.relocatedFrom, undefined, "no relocation on override path");

  // Idempotent re-save at the same override path overwrites in place.
  const r3 = store.saveDocument({
    name: "DEV-300001.md",
    text: bodyFor("DEV-300001 v2 updated body"),
    datasetId: "knowledge",
    metadata: { atom_type: "jira_issue", area: "hermes-service" },
    placementOverride: "knowledge/issues/JIRA/DEV/300/0/1",
  });
  assert.equal(
    r3.created.document.id,
    "knowledge/issues/JIRA/DEV/300/0/1/dev-300001.md",
    "same-path re-save overwrites in place",
  );
  assert.equal(
    r3.relocatedFrom,
    undefined,
    "re-save at the SAME override path is in-place; no relocate",
  );
});

test("searchMemoryFiltered finds leaves placed via override under a known category", async () => {
  // Note: leaves at knowledge/issues/JIRA/DEV/129/95/7/ live under the
  // `knowledge` category root, so the structure-agnostic walk picks them up.
  const out = await store.searchMemoryFiltered({
    query: "DEV-129957 hermes service",
    datasetId: "knowledge",
    filters: { area: "hermes-service" },
  });
  const ids = (out.records || []).map((r) => r.documentId);
  assert.ok(
    ids.some((id) => id === "knowledge/issues/JIRA/DEV/129/95/7/dev-129957.md"),
    `recall returns the override-placed leaf; got ${JSON.stringify(ids)}`,
  );
});

test("validate stays clean after override writes", () => {
  const v = cli.validate(wiki);
  assert.equal(v.ok, true, `validate clean after override writes: ${JSON.stringify(v)}`);
});

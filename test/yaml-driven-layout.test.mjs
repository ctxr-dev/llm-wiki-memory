import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");

function bodyFor(name) {
  return `# ${name}\n\nA test leaf body that's long enough to pass min-length checks.`;
}

test("default layout exposes the historical 5 categories", () => {
  // Bootstrap from the in-repo template (which now declares placement_facets
  // for the historical four categories and daily-date for daily).
  const cats = store.getCategories();
  assert.deepEqual(
    cats.sort(),
    ["daily", "investigations", "knowledge", "plans", "self_improvement"].sort(),
    "historical 5 categories visible by default",
  );
});

test("adding a custom category to layout.yaml makes it a valid datasetId", () => {
  // Append a sixth category to this wiki's layout YAML and reset the cache.
  const layoutPath = path.join(wiki, ".layout", "layout.yaml");
  const original = fs.readFileSync(layoutPath, "utf8");
  fs.writeFileSync(
    layoutPath,
    `${original}
  - path: issues
    purpose: "tracker-system issue knowledge (caller-driven layout)"
    placement_facets: []
    allow_entry_types: [primary]
    max_depth: 8
`,
  );
  store._resetLayoutCacheForTests();

  // Now `issues` is a known category. Writing under it (flat, no override)
  // should land it at issues/<name>.md.
  const res = store.writeMemory({
    name: "DEV-1.md",
    text: bodyFor("DEV-1"),
    datasetId: "issues",
    metadata: { atom_type: "jira_issue", area: "hermes-service" },
  });
  assert.equal(
    res.created.document.id,
    "issues/dev-1.md",
    `flat placement under a YAML-declared category; got ${res.created.document.id}`,
  );
  assert.ok(
    store.getCategories().includes("issues"),
    "issues is now in CATEGORIES",
  );

  // Restore the layout YAML so other tests are not affected by this in-process
  // mutation (the harness data dir is shared across this file's tests).
  fs.writeFileSync(layoutPath, original);
  store._resetLayoutCacheForTests();
});

test("searchMemoryFiltered scans newly-added categories", async () => {
  // Re-add issues, write a leaf, search via the unscoped path that walks all
  // non-daily categories.
  const layoutPath = path.join(wiki, ".layout", "layout.yaml");
  const original = fs.readFileSync(layoutPath, "utf8");
  fs.writeFileSync(
    layoutPath,
    `${original}
  - path: issues
    placement_facets: []
    allow_entry_types: [primary]
    max_depth: 8
`,
  );
  store._resetLayoutCacheForTests();

  store.writeMemory({
    name: "DEV-2.md",
    text: bodyFor("DEV-2 recall test"),
    datasetId: "issues",
    metadata: { atom_type: "jira_issue", area: "billing" },
  });

  const out = await store.searchMemoryFiltered({
    query: "DEV-2 recall test",
    filters: { area: "billing" },
  });
  const ids = (out.records || []).map((r) => r.documentId);
  assert.ok(
    ids.some((id) => id === "issues/dev-2.md"),
    `unscoped recall includes the new category; got ${JSON.stringify(ids)}`,
  );

  fs.writeFileSync(layoutPath, original);
  store._resetLayoutCacheForTests();
});

test("malformed YAML falls back to defaults (no crash)", () => {
  const layoutPath = path.join(wiki, ".layout", "layout.yaml");
  const original = fs.readFileSync(layoutPath, "utf8");
  fs.writeFileSync(layoutPath, "layout: [this is: not: valid yaml\n  - oops");
  store._resetLayoutCacheForTests();

  const cats = store.getCategories();
  // Defaults are restored even when the YAML is malformed.
  assert.ok(cats.includes("knowledge"));
  assert.ok(cats.includes("self_improvement"));
  assert.ok(cats.includes("plans"));
  assert.ok(cats.includes("investigations"));
  assert.ok(cats.includes("daily"));

  fs.writeFileSync(layoutPath, original);
  store._resetLayoutCacheForTests();
});

test("listDatasets reflects the YAML-driven category list", () => {
  const result = store.listDatasets();
  const names = result.datasets.map((d) => d.name).sort();
  // Note: the live wiki layout for this test file does NOT declare `issues`
  // (the previous tests removed their mutation in cleanup), so we see just
  // the historical 5.
  assert.deepEqual(
    names,
    ["daily", "investigations", "knowledge", "plans", "self_improvement"].sort(),
  );
});

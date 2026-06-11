import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const { validate } = await import("../scripts/lib/wiki-cli.mjs");

// curated "Notes" (consolidate:none, flat) + topology "tickets".
const layoutPath = path.join(wiki, ".layout", "layout.yaml");
fs.writeFileSync(
  layoutPath,
  `${fs.readFileSync(layoutPath, "utf8")}
  - path: Notes
    consolidate: none
    placement_facets: []
    allow_entry_types: [primary]
  - path: tickets
    consolidate: none
    allow_entry_types: [primary]
    topology:
      strategy: tracker
`,
);
store._resetLayoutCacheForTests();

const body = (id) => `# ${id}\n\nUnique body marker ${id} for lexical search; long enough to pass checks.`;
function seedNote(name, dir = "Notes") {
  const r = store.saveDocument({
    name,
    text: body(name),
    datasetId: "Notes",
    placementOverride: dir,
    metadata: { atom_type: "reference", area: "x" },
  });
  assert.ok(r.ok, `seed ${name}: ${JSON.stringify(r)}`);
  return r.created.document.id;
}

test("curated move relocates content + embedding + indexes; validate clean", async () => {
  const id = seedNote("Mover.md");
  const res = store.moveDocument({ fromPath: id, toPath: "Notes/Sub/Mover.md" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.to, "Notes/Sub/Mover.md");
  assert.ok(!fs.existsSync(path.join(wiki, id)), "old path gone");
  const dest = path.join(wiki, "Notes/Sub/Mover.md");
  assert.ok(fs.existsSync(dest), "new path exists");
  assert.match(fs.readFileSync(dest, "utf8"), /Unique body marker Mover\.md/, "content verbatim");
  const out = await store.searchMemoryFiltered({ query: "Unique body marker Mover.md" });
  assert.ok(
    (out.records || []).some((r) => r.documentId === "Notes/Sub/Mover.md"),
    `embedding preserved (searchable at new path); got ${JSON.stringify((out.records || []).map((r) => r.documentId))}`,
  );
  assert.ok(validate(wiki).ok, "validate clean after move");
});

test("collision refuses and loses no data", () => {
  const a = seedNote("CollA.md");
  const b = seedNote("CollB.md", "Notes/Dest");
  const res = store.moveDocument({ fromPath: a, toPath: "Notes/Dest/CollB.md" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /occupied/);
  assert.ok(fs.existsSync(path.join(wiki, a)) && fs.existsSync(path.join(wiki, b)), "both survive");
});

test("missing source refuses", () => {
  const res = store.moveDocument({ fromPath: "Notes/Nope.md", toPath: "Notes/X.md" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not found/);
});

test("no-op move (from === to)", () => {
  const id = seedNote("Same.md");
  const res = store.moveDocument({ fromPath: id, toPath: id });
  assert.equal(res.ok, true);
  assert.equal(res.moved, false);
});

test(".plan.md suffix is preserved across a move", () => {
  const id = seedNote("Roadmap.plan.md");
  assert.ok(id.endsWith(".plan.md"), `seed kept .plan.md; got ${id}`);
  const res = store.moveDocument({ fromPath: id, toPath: "Notes/Plans/Roadmap.plan.md" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.to.endsWith(".plan.md"), `dest keeps .plan.md; got ${res.to}`);
});

test("facet category is refused (relocate via metadata, not a free path)", () => {
  const k = store.writeMemory({
    name: "Fact.md",
    text: body("Fact"),
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "billing" },
  });
  const res = store.moveDocument({ fromPath: k.created.document.id, toPath: "knowledge/elsewhere/Fact.md" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /facet/);
});

test("topology destination is refused", () => {
  const id = seedNote("ToTopo.md");
  const res = store.moveDocument({ fromPath: id, toPath: "tickets/ToTopo.md" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /topology/);
});

test("path-traversal toPath is refused", () => {
  const id = seedNote("Trav.md");
  const res = store.moveDocument({ fromPath: id, toPath: "../escape.md" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /invalid toPath|not declared/);
});

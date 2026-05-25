import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const cli = await import("../scripts/lib/wiki-cli.mjs");
const { migrateNest } = await import("../scripts/migrate-nest.mjs");

const abs = (rel) => path.join(wiki, rel.split("/").join(path.sep));

// Seed a leaf through the (now-nesting) writer to get valid frontmatter, then move
// it up to the flat category root to mimic a pre-nesting install. The leaf's facets
// map back to the same nested dir, so migration returns it exactly there.
function seedFlat({ name, text, datasetId, metadata }) {
  const res = store.writeMemory({ name, text, datasetId, metadata });
  const nestedRel = res.created.document.id;
  const base = path.basename(nestedRel);
  fs.renameSync(abs(nestedRel), abs(`${datasetId}/${base}`));
  return { flatRel: `${datasetId}/${base}`, nestedRel };
}

test("migrate-nest moves flat leaves into their facet folders and validates", () => {
  const seeds = [
    seedFlat({ name: "knowledge-a-2026-05-25-100000000.md", text: "# A\n\nfact A about billing.\nWhy: x.", datasetId: "knowledge", metadata: { atom_type: "decision", project_module: "billing" } }),
    seedFlat({ name: "lesson-b-2026-05-25-110000000.md", text: "# B\n\nlesson B.\nWhy: y.", datasetId: "self_improvement", metadata: { project_module: "billing", task_type: "refactor", error_pattern: "ep" } }),
    seedFlat({ name: "knowledge-c-2026-05-25-120000000.md", text: "# C\n\nfact C, no module.\nWhy: z.", datasetId: "knowledge", metadata: { atom_type: "reference" } }),
  ];
  for (const s of seeds) assert.ok(fs.existsSync(abs(s.flatRel)), `seeded flat: ${s.flatRel}`);

  const res = migrateNest({ wiki });
  assert.equal(res.moved, 3, "moved all three flat leaves");
  assert.equal(res.ok, true, `migration validates clean: ${JSON.stringify(res.validate)}`);

  for (const s of seeds) {
    assert.ok(fs.existsSync(abs(s.nestedRel)), `re-nested at facet path: ${s.nestedRel}`);
    assert.ok(!fs.existsSync(abs(s.flatRel)), `flat copy removed: ${s.flatRel}`);
    const folderIndex = path.join(path.dirname(abs(s.nestedRel)), "index.md");
    assert.ok(fs.existsSync(folderIndex), `per-folder index built: ${path.relative(wiki, folderIndex)}`);
  }
  // expected facet destinations
  assert.ok(seeds[0].nestedRel.startsWith("knowledge/billing/decision/"), seeds[0].nestedRel);
  assert.ok(seeds[1].nestedRel.startsWith("self_improvement/billing/refactor/"), seeds[1].nestedRel);
  assert.ok(seeds[2].nestedRel.startsWith("knowledge/unscoped/reference/"), seeds[2].nestedRel);
  assert.equal(cli.validate(wiki).ok, true);
});

test("migrate-nest is idempotent, search still works, and --check flags flat leaves", async () => {
  const chk = migrateNest({ wiki, check: true });
  assert.equal(chk.ok, true, "no flat leaves remain after migration");
  assert.equal(chk.flatCount, 0);

  const again = migrateNest({ wiki });
  assert.equal(again.moved, 0, "second run is a no-op");

  const found = await store.searchMemoryFiltered({
    query: "fact about billing",
    datasetId: "knowledge",
    filters: { area: "billing" },
  });
  assert.ok(found.records.length >= 1, "re-nested leaf is still found by folder-agnostic search");

  seedFlat({ name: "knowledge-d-2026-05-25-130000000.md", text: "# D\n\nfact D.\nWhy: w.", datasetId: "knowledge", metadata: { atom_type: "reference", project_module: "billing" } });
  const chk2 = migrateNest({ wiki, check: true });
  assert.equal(chk2.ok, false, "a freshly introduced flat leaf is detected");
  assert.equal(chk2.flatCount, 1);
});

test("migrate-nest refuses to clobber an existing destination (no data loss)", () => {
  // A nested leaf already lives at its facet path.
  const nested = store.writeMemory({
    name: "knowledge-clash-2026-05-25-150000000.md",
    text: "# Nested original\n\nthe original nested leaf.\nWhy: keep it.",
    datasetId: "knowledge",
    metadata: { atom_type: "decision", project_module: "billing" },
  });
  const nestedRel = nested.created.document.id; // knowledge/billing/decision/knowledge-clash-...md
  const nestedAbs = abs(nestedRel);
  const before = fs.readFileSync(nestedAbs, "utf8");

  // A flat leaf with the SAME basename that would migrate onto the nested one.
  const flatRel = `knowledge/${path.basename(nestedRel)}`;
  const flatAbs = abs(flatRel);
  fs.copyFileSync(nestedAbs, flatAbs);
  fs.appendFileSync(flatAbs, "\nDISTINCT FLAT MARKER\n");

  const res = migrateNest({ wiki });
  assert.equal(res.ok, false, "a destination collision makes the run not-ok");
  assert.ok(res.conflicts.some((c) => c.from === flatRel), `collision recorded: ${JSON.stringify(res.conflicts)}`);
  assert.ok(fs.existsSync(flatAbs), "flat source left in place, not deleted");
  assert.equal(fs.readFileSync(nestedAbs, "utf8"), before, "existing nested leaf not overwritten");

  fs.rmSync(flatAbs); // tidy up so the leftover flat leaf does not perturb later runs
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

// projectModule "testproj" is the workspace, so an area of "testproj" must be
// rejected (that is exactly how the project name leaked in as an area).
const { dataDir, wiki } = setupWorkspace({ projectModule: "testproj" });
after(() => cleanup(dataDir));

const facets = await import("../scripts/lib/facets.mjs");

const BAD = new Set(["", "unknown", "unscoped", "untyped", "misc", "untitled"]);

test("inferFacets: a real provided area is kept; valid atom_type kept", () => {
  const p = facets.inferFacets({
    category: "knowledge",
    meta: { area: "frontend", atom_type: "decision" },
  });
  assert.equal(p.area, "frontend");
  assert.equal(p.atom_type, "decision");
});

test("inferFacets: project_module (a sub-module, not the workspace) becomes the area", () => {
  const p = facets.inferFacets({
    category: "knowledge",
    meta: { project_module: "billing", atom_type: "reference" },
  });
  assert.equal(
    p.area,
    "billing",
    "any non-workspace project_module is accepted as the sub-module, even without an existing folder",
  );
});

test("inferFacets: the workspace name is never used as an area", () => {
  const p = facets.inferFacets({
    category: "knowledge",
    meta: { project_module: "testproj", atom_type: "reference" },
  });
  assert.notEqual(p.area, "testproj");
  assert.ok(!BAD.has(p.area), `area must be valid, got ${p.area}`);
});

test("inferFacets: unknown/unscoped area resolves to the cross-cutting fallback, never unknown", () => {
  for (const bad of ["unknown", "unscoped", "", "  "]) {
    const p = facets.inferFacets({
      category: "knowledge",
      meta: { area: bad, atom_type: "reference" },
    });
    assert.ok(!BAD.has(p.area), `bad area '${bad}' -> '${p.area}' must not be a bad sentinel`);
    assert.equal(p.area, "workspace", "default cross-cutting area");
  }
});

test("inferFacets: an out-of-set knowledge atom_type is corrected to a valid type", () => {
  for (const bad of ["knowledge", "investigation", "", "made-up"]) {
    const p = facets.inferFacets({
      category: "knowledge",
      meta: { area: "frontend", atom_type: bad },
    });
    assert.ok(
      facets.validAtomTypes("knowledge").has(p.atom_type),
      `'${bad}' -> '${p.atom_type}' must be a valid knowledge atom_type`,
    );
  }
});

test("inferFacets: self_improvement missing task_type -> the valid 'unknown' sentinel", () => {
  const p = facets.inferFacets({ category: "self_improvement", meta: { area: "infra" } });
  assert.equal(p.area, "infra");
  assert.equal(p.task_type, "unknown");
});

test("inferFacets: a tag that names a known sub-module is used when area is absent", () => {
  fs.mkdirSync(path.join(wiki, "knowledge", "frontend"), { recursive: true }); // make 'frontend' a known area
  const p = facets.inferFacets({
    category: "knowledge",
    meta: { atom_type: "reference" },
    tags: "frontend,ui",
  });
  assert.equal(p.area, "frontend");
});

test("inferFacets: daily is a no-op (no placement facets)", () => {
  assert.deepEqual(facets.inferFacets({ category: "daily", meta: { area: "unknown" } }), {});
});

test("facetIssues: flags bad area and out-of-set knowledge atom_type only", () => {
  assert.deepEqual(facets.facetIssues("knowledge", { area: "unknown", atom_type: "reference" }), [
    "area",
  ]);
  assert.deepEqual(facets.facetIssues("knowledge", { area: "testproj", atom_type: "reference" }), [
    "area",
  ]);
  assert.deepEqual(facets.facetIssues("knowledge", { area: "frontend", atom_type: "knowledge" }), [
    "atom_type",
  ]);
  assert.deepEqual(
    facets.facetIssues("knowledge", { area: "frontend", atom_type: "reference" }),
    [],
  );
  assert.deepEqual(
    facets.facetIssues("self_improvement", { area: "frontend", task_type: "unknown" }),
    [],
    "task_type unknown is not flagged (valid sentinel)",
  );
  assert.deepEqual(facets.facetIssues("daily", { area: "unknown" }), []);
});

test("classifyFacetsLLM: uses the LLM (mock) to pin a known sub-module + valid atom_type", async () => {
  fs.mkdirSync(path.join(wiki, "knowledge", "infra"), { recursive: true }); // make 'infra' a known area
  process.env.MEMORY_LLM_PROVIDER = "mock";
  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({ area: "infra", atom_type: "reference" });
  try {
    const p = await facets.classifyFacetsLLM({
      category: "knowledge",
      meta: { area: "unknown", atom_type: "knowledge" }, // both bad -> LLM consulted
      title: "pnpm is the package manager for both repos",
      text: "Both repos use pnpm; npm is not used.",
      tags: "pnpm,ci,build",
    });
    assert.equal(p.area, "infra", "LLM-chosen known sub-module accepted");
    assert.equal(p.atom_type, "reference", "LLM-chosen valid atom_type accepted");
  } finally {
    delete process.env.MEMORY_LLM_PROVIDER;
    delete process.env.MEMORY_LLM_MOCK_RESPONSE;
  }
});

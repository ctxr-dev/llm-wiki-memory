import { test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLayoutObject } from "../scripts/lib/wiki-layout-parse.mjs";
import { getFacetMeta, resetLayoutCache } from "../scripts/lib/wiki-layout-state.mjs";
import { validateLayoutText } from "../scripts/lib/layout-validator.mjs";

test("parseLayoutObject: built-in facet_meta defaults are present with no override", () => {
  const p = parseLayoutObject({});
  assert.equal(typeof p.facetMeta.area.description, "string");
  assert.equal(typeof p.facetMeta.atom_type.description, "string");
  assert.match(p.facetMeta.priority.description, /P0/);
  assert.equal("examples" in p.facetMeta.area, false, "no examples unless declared");
});

test("parseLayoutObject: layout facet_meta overrides a default and adds a new facet", () => {
  const p = parseLayoutObject({
    facet_meta: {
      area: { description: "custom area help" },
      language: { description: "the programming language", examples: ["scala", "ruby"] },
    },
    layout: [{ path: "knowledge", placement_facets: ["area", "atom_type"] }],
  });
  assert.equal(p.facetMeta.area.description, "custom area help", "override wins per field");
  assert.ok(p.facetMeta.atom_type.description.length > 0, "an untouched default is kept");
  assert.equal(p.facetMeta.language.description, "the programming language", "a new facet is added");
  assert.deepEqual(p.facetMeta.language.examples, ["scala", "ruby"]);
});

test("parseLayoutObject: null/undefined input still yields the built-in defaults", () => {
  for (const bad of [null, undefined]) {
    const p = parseLayoutObject(bad);
    assert.equal(typeof p.facetMeta.subject.description, "string");
  }
});

test("layout schema accepts a top-level facet_meta block", () => {
  const text = `
facet_meta:
  area:
    description: the sub-module
    examples: [backend, frontend]
layout:
  - path: knowledge
    placement_facets: [area, atom_type]
`.trim();
  const result = validateLayoutText(text);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test("layout schema rejects an unknown key inside facet_meta (strict)", () => {
  const text = `
facet_meta:
  area:
    descriptionn: typo
layout:
  - path: knowledge
    placement_facets: [area, atom_type]
`.trim();
  const result = validateLayoutText(text);
  assert.equal(result.ok, false, "a misspelled facet_meta key must fail strict validation");
});

const CREATED = [];
function mkWiki(yaml) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-facetmeta-")));
  CREATED.push(dir);
  fs.mkdirSync(path.join(dir, ".layout"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".layout", "layout.yaml"), yaml);
  process.env.LLM_WIKI_MEMORY_ROOT = dir;
  resetLayoutCache();
  return dir;
}
afterEach(() => {
  delete process.env.LLM_WIKI_MEMORY_ROOT;
  resetLayoutCache();
});
after(() => {
  for (const d of CREATED) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test("getFacetMeta: built-in defaults surface, with a layout override applied", () => {
  mkWiki(
    "facet_meta:\n  area:\n    description: repo-specific area help\nlayout:\n  - path: knowledge\n    placement_facets: [area, atom_type]\n",
  );
  const meta = getFacetMeta();
  assert.equal(meta.area.description, "repo-specific area help", "layout override wins");
  assert.match(meta.priority.description, /P0/, "untouched default present");
});

test("getFacetMeta: returns a copy so a caller cannot poison the cached snapshot", () => {
  mkWiki("layout:\n  - path: knowledge\n    placement_facets: [area, atom_type]\n");
  const first = getFacetMeta();
  first.area.description = "mutated";
  const second = getFacetMeta();
  assert.notEqual(second.area.description, "mutated", "cache is not mutated through the copy");
});

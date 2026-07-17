import { test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLayoutObject } from "../scripts/lib/wiki-layout-parse.mjs";
import { isFullCategory, isLeafFull, resetLayoutCache } from "../scripts/lib/wiki-layout-state.mjs";

// ── parseLayoutObject: full projection (pure) ─────────────────────────────
test("parseLayoutObject: per-category full + top-level default are projected", () => {
  const p = parseLayoutObject({
    full: true,
    layout: [
      { path: "docs", placement_facets: ["subject"], full: true },
      { path: "knowledge", placement_facets: ["area", "atom_type"], full: false },
      { path: "notes", placement_facets: [] },
    ],
  });
  assert.equal(p.fullDefault, true, "wiki-level default captured");
  assert.equal(p.fullCategories.docs, true);
  assert.equal(p.fullCategories.knowledge, false, "explicit false overrides the wiki default");
  assert.equal("notes" in p.fullCategories, false, "unset category is absent (inherits default)");
});

test("parseLayoutObject: no full anywhere -> fullDefault false, no fullCategories", () => {
  const p = parseLayoutObject({ layout: [{ path: "knowledge", placement_facets: [] }] });
  assert.equal(p.fullDefault, false);
  assert.equal(Object.keys(p.fullCategories).length, 0);
});

// ── isFullCategory / isLeafFull (layout fixture) ──────────────────────────
const CREATED = [];
function mkWiki(yaml) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-full-")));
  CREATED.push(root);
  fs.mkdirSync(path.join(root, ".layout"), { recursive: true });
  fs.writeFileSync(path.join(root, ".layout", "layout.yaml"), yaml);
  process.env.LLM_WIKI_MEMORY_ROOT = root;
  resetLayoutCache();
  return root;
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

test("isFullCategory: explicit per-category wins; unset -> false when no wiki default", () => {
  mkWiki(
    "layout:\n  - path: docs\n    placement_facets: [subject]\n    full: true\n  - path: knowledge\n    placement_facets: [area, atom_type]\n",
  );
  assert.equal(isFullCategory("docs"), true);
  assert.equal(isFullCategory("knowledge"), false, "atomic by default");
});

test("isFullCategory: a wiki-level full default is inherited by an unset category", () => {
  mkWiki(
    "full: true\nlayout:\n  - path: docs\n    placement_facets: [subject]\n  - path: refs\n    placement_facets: [subject]\n    full: false\n",
  );
  assert.equal(isFullCategory("docs"), true, "inherits the wiki default");
  assert.equal(isFullCategory("refs"), false, "explicit false overrides the wiki default");
});

test("isLeafFull: a per-leaf memory.full:true forces full even in an atomic category", () => {
  mkWiki("layout:\n  - path: knowledge\n    placement_facets: [area, atom_type]\n");
  assert.equal(isFullCategory("knowledge"), false);
  assert.equal(isLeafFull("knowledge", { full: true }), true, "leaf override wins");
  assert.equal(isLeafFull("knowledge", { full: false }), false);
  assert.equal(isLeafFull("knowledge", null), false);
});

test("isLeafFull: a full category makes every leaf full unless... it just stays full", () => {
  mkWiki("layout:\n  - path: docs\n    placement_facets: [subject]\n    full: true\n");
  assert.equal(isLeafFull("docs", null), true, "category full -> leaf full");
  assert.equal(isLeafFull("docs", { full: true }), true);
});

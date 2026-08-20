import { test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLayoutObject } from "../scripts/lib/wiki-layout-parse.mjs";
import {
  isGatedCategory,
  isAutoDistillCategory,
  resetLayoutCache,
} from "../scripts/lib/wiki-layout-state.mjs";
import { validateLayoutText } from "../scripts/lib/layout-validator.mjs";

// ── parseLayoutObject: gated / auto_distill projection (pure) ─────────────
test("parseLayoutObject: explicit gated + auto_distill are projected per category", () => {
  const p = parseLayoutObject({
    layout: [
      { path: "knowledge", placement_facets: ["area", "atom_type"], gated: true },
      { path: "self_improvement", placement_facets: ["area", "task_type"], gated: false },
      { path: "plans", placement_facets: ["area"], auto_distill: false },
    ],
  });
  assert.equal(p.gatedCategories.knowledge, true, "explicit gated:true captured");
  assert.equal(
    p.gatedCategories.self_improvement,
    false,
    "explicit gated:false overrides the seed",
  );
  assert.equal(p.autoDistillCategories.plans, false, "explicit auto_distill:false captured");
});

test("parseLayoutObject: name-keyed defaults reach a declared-but-omitted category", () => {
  const p = parseLayoutObject({
    layout: [
      { path: "knowledge", placement_facets: ["area", "atom_type"] },
      { path: "self_improvement", placement_facets: ["area", "task_type"] },
      { path: "plans", placement_facets: ["area"] },
    ],
  });
  assert.equal(p.gatedCategories.self_improvement, true, "self_improvement seeds gated:true");
  assert.equal(p.gatedCategories.knowledge, false, "knowledge is ungated by default");
  assert.equal(p.gatedCategories.plans, false, "plans is ungated by default");
  assert.equal(p.autoDistillCategories.knowledge, true, "auto_distill defaults true");
  assert.equal(p.autoDistillCategories.self_improvement, true, "auto_distill defaults true");
  assert.equal(p.autoDistillCategories.plans, true, "auto_distill defaults true");
});

test("parseLayoutObject: no entries -> baked-in defaults seed gated + auto_distill", () => {
  const p = parseLayoutObject({});
  assert.equal(p.gatedCategories.self_improvement, true, "SI gated by default with no layout");
  assert.equal(p.gatedCategories.knowledge, false);
  assert.equal(p.autoDistillCategories.knowledge, true);
  assert.equal(p.autoDistillCategories.self_improvement, true);
});

test("parseLayoutObject: null/undefined input degrades to the baked-in defaults", () => {
  for (const bad of [null, undefined]) {
    const p = parseLayoutObject(bad);
    assert.equal(p.gatedCategories.self_improvement, true, "SI still gated on the fallback path");
    assert.equal(p.autoDistillCategories.knowledge, true);
  }
});

test("parseLayoutObject: a category dropped from the layout leaves no stale flag", () => {
  const p = parseLayoutObject({
    layout: [{ path: "knowledge", placement_facets: [] }],
  });
  assert.equal("self_improvement" in p.gatedCategories, false, "undeclared SI carries no flag");
  assert.equal("self_improvement" in p.autoDistillCategories, false);
  assert.equal(p.gatedCategories.knowledge, false);
});

// ── schema acceptance (strict mode must allow the two new keys) ───────────
test("layout schema accepts gated + auto_distill on an entry", () => {
  const text = `
layout:
  - path: knowledge
    placement_facets: [area, atom_type]
    gated: true
    auto_distill: false
`.trim();
  const result = validateLayoutText(text);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test("layout schema still rejects a typo near the new keys (strict)", () => {
  const text = `
layout:
  - path: knowledge
    placement_facets: [area, atom_type]
    auto_distil: false
`.trim();
  const result = validateLayoutText(text);
  assert.equal(result.ok, false, "a misspelled auto_distil must fail strict validation");
});

// ── isGatedCategory / isAutoDistillCategory (layout fixture) ──────────────
const CREATED = [];
function mkWiki(yaml) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-gate-")));
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

test("isGatedCategory: self_improvement gated by seed; knowledge ungated; unknown -> false", () => {
  mkWiki(
    "layout:\n  - path: knowledge\n    placement_facets: [area, atom_type]\n  - path: self_improvement\n    placement_facets: [area, task_type]\n",
  );
  assert.equal(isGatedCategory("self_improvement"), true, "seed gates self_improvement");
  assert.equal(isGatedCategory("knowledge"), false, "knowledge ungated by default");
  assert.equal(isGatedCategory("nope"), false, "unknown category is not gated");
  assert.equal(isGatedCategory(null), false);
});

test("isGatedCategory: an explicit opt-in gates knowledge; an explicit opt-out frees SI", () => {
  mkWiki(
    "layout:\n  - path: knowledge\n    placement_facets: [area, atom_type]\n    gated: true\n  - path: self_improvement\n    placement_facets: [area, task_type]\n    gated: false\n",
  );
  assert.equal(isGatedCategory("knowledge"), true, "opt-in gates knowledge");
  assert.equal(isGatedCategory("self_improvement"), false, "explicit override frees SI");
});

test("isAutoDistillCategory: true by default; explicit false opts a category out; unknown -> true", () => {
  mkWiki(
    "layout:\n  - path: knowledge\n    placement_facets: [area, atom_type]\n  - path: plans\n    placement_facets: [area]\n    auto_distill: false\n",
  );
  assert.equal(isAutoDistillCategory("knowledge"), true, "auto_distill on by default");
  assert.equal(isAutoDistillCategory("plans"), false, "explicit opt-out");
  assert.equal(isAutoDistillCategory("nope"), true, "unknown category defaults to auto-distill");
  assert.equal(isAutoDistillCategory(null), true);
});

// ── wiki-store barrel must re-export the accessors ────────────────────────
test("wiki-store re-exports isGatedCategory + isAutoDistillCategory", async () => {
  const store = await import("../scripts/lib/wiki-store.mjs");
  assert.equal(typeof store.isGatedCategory, "function");
  assert.equal(typeof store.isAutoDistillCategory, "function");
});

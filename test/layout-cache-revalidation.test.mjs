// Layout / topology caches must revalidate by file mtime (so a long-running MCP
// server picks up edits to .layout/layout.yaml + its sibling .mjs helpers
// without a restart), and the explicit reset must force a re-read even when the
// mtime was preserved (e.g. a copy/restore).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { placementDirForMeta, resetLayoutCache } from "../scripts/lib/wiki-store.mjs";
import { loadTopology, pathFor, resetTopologyCache } from "../scripts/lib/topology-runtime.mjs";

function mkWiki(layoutYaml, helpers = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cache-reval-"));
  fs.mkdirSync(path.join(root, ".layout"), { recursive: true });
  fs.writeFileSync(path.join(root, ".layout", "layout.yaml"), layoutYaml);
  for (const [name, body] of Object.entries(helpers)) {
    fs.writeFileSync(path.join(root, ".layout", name), body);
  }
  return root;
}
const layoutPathOf = (root) => path.join(root, ".layout", "layout.yaml");
// Write a file and force a strictly-later mtime (deterministic across FS clocks).
function writeBump(p, body) {
  fs.writeFileSync(p, body);
  const t = Date.now() / 1000 + 5;
  fs.utimesSync(p, t, t);
}

afterEach(() => {
  delete process.env.LLM_WIKI_MEMORY_ROOT;
  resetLayoutCache();
  resetTopologyCache();
});

const LAYOUT_AREA_ATOM = `
layout:
  - path: knowledge
    placement_facets: [area, atom_type]
`;
const LAYOUT_AREA_ONLY = `
layout:
  - path: knowledge
    placement_facets: [area]
`;

test("placement cache auto-reloads when layout.yaml mtime changes (no reset)", () => {
  const root = mkWiki(LAYOUT_AREA_ATOM);
  process.env.LLM_WIKI_MEMORY_ROOT = root;
  resetLayoutCache();
  assert.equal(
    placementDirForMeta("knowledge", { area: "x", atom_type: "concept" }),
    "knowledge/x/concept",
    "initial layout",
  );
  // Edit the contract (drop atom_type) + bump mtime — NO explicit reset.
  writeBump(layoutPathOf(root), LAYOUT_AREA_ONLY);
  assert.equal(
    placementDirForMeta("knowledge", { area: "x", atom_type: "concept" }),
    "knowledge/x",
    "edit picked up via mtime revalidation",
  );
});

test("resetLayoutCache forces a re-read even when mtime is unchanged", () => {
  const root = mkWiki(LAYOUT_AREA_ATOM);
  process.env.LLM_WIKI_MEMORY_ROOT = root;
  resetLayoutCache();
  const lp = layoutPathOf(root);
  // Pin a fixed integer-second mtime so the edit below can reproduce it exactly
  // (simulating a copy/restore that preserved mtimes).
  const FIXED_T = 1_700_000_000;
  fs.utimesSync(lp, FIXED_T, FIXED_T);
  assert.equal(
    placementDirForMeta("knowledge", { area: "x", atom_type: "concept" }),
    "knowledge/x/concept",
  );

  // Edit, then restore the SAME fixed mtime.
  fs.writeFileSync(lp, LAYOUT_AREA_ONLY);
  fs.utimesSync(lp, FIXED_T, FIXED_T);
  // mtime unchanged -> auto-reload does NOT fire (still stale): proves gating.
  assert.equal(
    placementDirForMeta("knowledge", { area: "x", atom_type: "concept" }),
    "knowledge/x/concept",
    "stale while mtime unchanged",
  );
  // explicit reset -> fresh.
  resetLayoutCache();
  assert.equal(
    placementDirForMeta("knowledge", { area: "x", atom_type: "concept" }),
    "knowledge/x",
    "fresh after explicit reset",
  );
});

test("absent layout.yaml (mtime 0) does not crash — falls back to baked-in defaults", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cache-reval-nolayout-"));
  process.env.LLM_WIKI_MEMORY_ROOT = root; // no .layout/ at all
  resetLayoutCache();
  assert.equal(
    placementDirForMeta("knowledge", { area: "x", atom_type: "concept" }),
    "knowledge/x/concept",
    "default [area, atom_type] placement when no contract exists",
  );
});

test("placement cache still reloads when the wiki ROOT changes (even if mtime coincides)", () => {
  const a = mkWiki(LAYOUT_AREA_ATOM);
  const b = mkWiki(LAYOUT_AREA_ONLY);
  // Pin BOTH layouts to the same mtime, so only the root differs.
  const T = 1_700_000_001;
  fs.utimesSync(layoutPathOf(a), T, T);
  fs.utimesSync(layoutPathOf(b), T, T);
  process.env.LLM_WIKI_MEMORY_ROOT = a;
  resetLayoutCache();
  assert.equal(
    placementDirForMeta("knowledge", { area: "x", atom_type: "concept" }),
    "knowledge/x/concept",
  );
  // Switch root (no reset) — the root change alone must trigger a reload.
  process.env.LLM_WIKI_MEMORY_ROOT = b;
  assert.equal(
    placementDirForMeta("knowledge", { area: "x", atom_type: "concept" }),
    "knowledge/x",
    "root change reloads despite identical mtime",
  );
});

const topoLayout = (subdir) => `
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [prefix, number]
          path_template: "issues/{prefix}/${subdir}{prefix}-{number}.md"
      facet_inputs:
        prefix: { type: string }
        number: { type: integer, minimum: 1 }
`;

test("topology cache auto-reloads when the layout topology changes", async () => {
  const root = mkWiki(topoLayout(""));
  resetTopologyCache();
  const t1 = await loadTopology(root, { categoryPath: "issues" });
  assert.equal(
    pathFor(t1, "knowledge", { prefix: "DEV", number: 1 }, { skipRoundTripCheck: true }),
    "issues/DEV/DEV-1.md",
  );
  writeBump(layoutPathOf(root), topoLayout("v2/"));
  const t2 = await loadTopology(root, { categoryPath: "issues" });
  assert.equal(
    pathFor(t2, "knowledge", { prefix: "DEV", number: 1 }, { skipRoundTripCheck: true }),
    "issues/DEV/v2/DEV-1.md",
    "topology change picked up via mtime revalidation",
  );
});

const topoFileLayout = `
layout:
  - path: issues
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [prefix, number]
          to_path_file: ./to_path.mjs
      facet_inputs:
        prefix: { type: string }
        number: { type: integer, minimum: 1 }
`;
const helperV = (seg) =>
  `export function knowledge(f) { return "issues/${seg}/" + f.prefix + "-" + f.number + ".md"; }\n`;

test("topology cache auto-reloads when a sibling to_path .mjs is edited", async () => {
  const root = mkWiki(topoFileLayout, { "to_path.mjs": helperV("A") });
  resetTopologyCache();
  const t1 = await loadTopology(root, { categoryPath: "issues" });
  assert.equal(
    pathFor(t1, "knowledge", { prefix: "DEV", number: 1 }, { skipRoundTripCheck: true }),
    "issues/A/DEV-1.md",
  );
  // Edit ONLY the helper .mjs (layout.yaml untouched) + bump its mtime.
  writeBump(path.join(root, ".layout", "to_path.mjs"), helperV("B"));
  const t2 = await loadTopology(root, { categoryPath: "issues" });
  assert.equal(
    pathFor(t2, "knowledge", { prefix: "DEV", number: 1 }, { skipRoundTripCheck: true }),
    "issues/B/DEV-1.md",
    "edited sibling .mjs re-imported (cache-bust)",
  );
});

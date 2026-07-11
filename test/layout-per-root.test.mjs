// B1: the layout state is a PER-ROOT cache (a Map keyed by wiki root), not a
// single mutable module-global slot. These tests pin the two properties that
// keying by root buys us:
//   1. Isolation — one root's resolved layout is never clobbered/evicted when a
//      DIFFERENT root's layout is loaded (the single-slot design clobbered at
//      every root switch / await point).
//   2. Layered merge is live — a personal `layout.local.yaml` is merged over the
//      shared `layout.yaml` on the live read path, per-root.
//
// Falsifiability: tests 1 and 3 FAIL against the old single-slot code (which
// evicts on root change and ignores layout.local.yaml); test 2 models the same
// clobbering across an await boundary via the per-root snapshot.

import { test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getCategories, resetLayoutCache } from "../scripts/lib/wiki-store.mjs";
import { ensureLayoutLoaded } from "../scripts/lib/wiki-layout-state.mjs";

/** @type {string[]} */
const CREATED = [];

// Realpath the fresh dir: on macOS /tmp -> /private/tmp, and root() keys the
// cache by the exact string, so the env var must carry the resolved form.
/**
 * @param {string} prefix
 * @param {string} sharedYaml
 * @param {string | null} [localYaml]
 * @returns {string}
 */
function mkWiki(prefix, sharedYaml, localYaml = null) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", `lwm-perroot-${prefix}-`)));
  CREATED.push(root);
  fs.mkdirSync(path.join(root, ".layout"), { recursive: true });
  fs.writeFileSync(path.join(root, ".layout", "layout.yaml"), sharedYaml);
  if (localYaml != null) {
    fs.writeFileSync(path.join(root, ".layout", "layout.local.yaml"), localYaml);
  }
  return root;
}

const layoutYamlOf = (root) => path.join(root, ".layout", "layout.yaml");

const LAYOUT_A = `
layout:
  - path: knowledge
    placement_facets: [area, atom_type]
  - path: alpha
    placement_facets: []
`;
const LAYOUT_B = `
layout:
  - path: knowledge
    placement_facets: [area, atom_type]
  - path: beta
    placement_facets: []
`;

afterEach(() => {
  delete process.env.LLM_WIKI_MEMORY_ROOT;
  resetLayoutCache();
});

after(() => {
  for (const dir of CREATED) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test("per-root cache: root A's layout is retained across a root-B load (isolation)", () => {
  const a = mkWiki("A", LAYOUT_A);
  const b = mkWiki("B", LAYOUT_B);
  // Pin identical mtimes on both so mtime-revalidation is NOT what protects A —
  // only keying the cache by root can. A single-slot cache evicts A when B
  // loads, then re-reads A from disk on the switch back.
  const T = 1_700_000_100;
  fs.utimesSync(layoutYamlOf(a), T, T);
  fs.utimesSync(layoutYamlOf(b), T, T);

  process.env.LLM_WIKI_MEMORY_ROOT = a;
  resetLayoutCache();
  assert.deepEqual(getCategories().sort(), ["alpha", "knowledge"], "root A loaded");

  process.env.LLM_WIKI_MEMORY_ROOT = b;
  assert.deepEqual(getCategories().sort(), ["beta", "knowledge"], "root B loaded");

  // Corrupt A's layout on disk but restore its identical mtime. A single-slot
  // cache (which evicted A) would re-read this corrupted file and fall back to
  // the 5 baked-in defaults, losing `alpha`. The per-root cache still holds A.
  fs.writeFileSync(layoutYamlOf(a), "layout: [this is: not: valid yaml\n  - oops");
  fs.utimesSync(layoutYamlOf(a), T, T);

  process.env.LLM_WIKI_MEMORY_ROOT = a;
  assert.deepEqual(
    getCategories().sort(),
    ["alpha", "knowledge"],
    "root A's cached layout survives root B's load (per-root isolation, not a disk re-read)",
  );
});

test("interleaved async ops against different roots keep their own snapshot", async () => {
  const a = mkWiki("A2", LAYOUT_A);
  const b = mkWiki("B2", LAYOUT_B);
  resetLayoutCache();

  // Each op sets ITS root, captures its snapshot, then yields so the sibling op
  // flips the global root and loads. A single shared slot would let the sibling
  // clobber the captured snapshot at the await point.
  /**
   * @param {string} root
   * @param {Promise<unknown>} gate
   * @returns {Promise<string[]>}
   */
  async function op(root, gate) {
    process.env.LLM_WIKI_MEMORY_ROOT = root;
    const snap = ensureLayoutLoaded();
    await gate;
    return [...snap.cats].sort();
  }

  /** @type {() => void} */
  let releaseB = () => {};
  const gateB = new Promise((resolve) => {
    releaseB = () => resolve(undefined);
  });
  const pendingA = op(a, gateB);
  const catsB = await op(b, Promise.resolve());
  releaseB();
  const catsA = await pendingA;

  assert.deepEqual(catsA, ["alpha", "knowledge"], "op A kept its own layout across the await");
  assert.deepEqual(catsB, ["beta", "knowledge"], "op B saw its own layout");
});

test("layout.local.yaml is merged over layout.yaml on the live read path", () => {
  const shared = `
layout:
  - path: knowledge
    placement_facets: [area, atom_type]
`;
  const local = `
layout:
  - path: personal
    placement_facets: []
`;
  const withLocal = mkWiki("L", shared, local);
  const withoutLocal = mkWiki("N", shared, null);
  resetLayoutCache();

  process.env.LLM_WIKI_MEMORY_ROOT = withLocal;
  const catsWith = getCategories();
  assert.ok(catsWith.includes("personal"), "local-only category merged into the live layout");
  assert.ok(catsWith.includes("knowledge"), "shared category still present");

  process.env.LLM_WIKI_MEMORY_ROOT = withoutLocal;
  const catsWithout = getCategories();
  assert.ok(
    !catsWithout.includes("personal"),
    "a sibling root without the local file does NOT inherit the personal category",
  );
  assert.ok(catsWithout.includes("knowledge"), "shared category present for the sibling root");
});

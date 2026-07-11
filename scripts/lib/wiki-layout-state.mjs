import path from "node:path";
import { root } from "./wiki-core.mjs";
import { fileMtimeMs, parseLayoutObject } from "./wiki-layout-parse.mjs";
import { loadMergedLayout, readMergedLayout } from "./layout-merge.mjs";

// The live layout state, cached PER WIKI ROOT. Each root gets its own resolved
// snapshot (categories + placement facets/rules + vocabularies + topology and
// consolidate flags) plus the mtime(s) it was built from, mirroring the
// path-keyed topology cache in topology-cache.mjs. Two operations against
// DIFFERENT roots each read their OWN snapshot; neither can clobber the other
// (the previous single mutable slot was overwritten on every root switch and at
// every await boundary between them).
//
// The snapshot is built from `loadMergedLayout`, so a personal
// `layout.local.yaml` is merged over the shared `layout.yaml` on the live read
// path. Reach the state ONLY through the accessors below (they run
// `ensureLayoutLoaded` first): never export or import a raw mutable array —
// importing one snapshots a stale empty binding before the lazy load (that bug
// once made CLI search return zero hits).

/** @typedef {import("./wiki-layout-parse.mjs").FacetRule} FacetRule */

/**
 * A single root's resolved layout plus the mtimes it was built from. Treated as
 * immutable once cached: revalidation REPLACES the Map entry with a fresh
 * snapshot rather than mutating this one, so a reference captured across an
 * await keeps describing the root it was resolved for.
 * @typedef {Object} LayoutSnapshot
 * @property {string[]} cats declared category names, in layout order
 * @property {Record<string, string[]>} facets per-category placement facets
 * @property {Record<string, Record<string, FacetRule>>} rules per-category facet rules
 * @property {Record<string, Set<string>>} vocabs declared vocabularies (name -> slug set)
 * @property {Record<string, string>} consolidateEligibility per-category "refine" | "none"
 * @property {Record<string, boolean>} topologyCategories categories with a `topology:` block
 * @property {number} sharedMtime mtime (ms) of layout.yaml when built (0 if absent)
 * @property {number} localMtime mtime (ms) of layout.local.yaml when built (0 if absent)
 */

/** @type {Map<string, LayoutSnapshot>} */
const layoutCacheByRoot = new Map();

// Build a root's snapshot from its `.layout` dir. Both readers merge a personal
// layout.local.yaml over the shared layout.yaml (shared wins). We PREFER the
// validated `loadMergedLayout`, but a strict-schema failure is NOT fatal on the
// live read path: it has always tolerated schema-incomplete layouts (e.g. a
// topology block mid-authoring), so we fall back to the unvalidated
// `readMergedLayout` rather than dropping the declared categories. Truly
// malformed/absent yaml degrades to `{}` there, which `parseLayoutObject` maps
// to the baked-in defaults — so no bad USER yaml ever wedges a layout read.
/**
 * @param {string} layoutDir
 * @param {number} sharedMtime
 * @param {number} localMtime
 * @returns {LayoutSnapshot}
 */
function buildSnapshot(layoutDir, sharedMtime, localMtime) {
  /** @type {Record<string, unknown>} */
  let raw;
  try {
    raw = loadMergedLayout(layoutDir);
  } catch {
    raw = readMergedLayout(layoutDir);
  }
  return { ...parseLayoutObject(raw), sharedMtime, localMtime };
}

// Resolve the CURRENT wiki root and return its layout snapshot, (re)building it
// when the root has no cached entry OR either layout file changed since it was
// built (so a long-running MCP server picks up `.layout/*.yaml` edits without a
// restart). Returns the snapshot so accessors read it directly instead of
// re-resolving the root.
/**
 * @returns {LayoutSnapshot}
 */
export function ensureLayoutLoaded() {
  const r = root();
  const layoutDir = path.join(r, ".layout");
  const sharedMtime = fileMtimeMs(path.join(layoutDir, "layout.yaml"));
  const localMtime = fileMtimeMs(path.join(layoutDir, "layout.local.yaml"));
  const cached = layoutCacheByRoot.get(r);
  if (cached && cached.sharedMtime === sharedMtime && cached.localMtime === localMtime) {
    return cached;
  }
  const snapshot = buildSnapshot(layoutDir, sharedMtime, localMtime);
  layoutCacheByRoot.set(r, snapshot);
  return snapshot;
}

// Drop every cached root so the next layout-touching call re-reads from disk.
// The mtime check already auto-reloads on edit; this is the explicit escape
// hatch (the `reload_layout` MCP tool, or a copy/restore that preserved mtime)
// and the test reset.
export function resetLayoutCache() {
  layoutCacheByRoot.clear();
}

export function _resetLayoutCacheForTests() {
  resetLayoutCache();
}

// Report the consolidate-eligibility declared in the CURRENT root's layout.
// Returns {refine, excluded, missing} where:
//   - refine[]   = category names declared `consolidate: refine`
//   - excluded[] = category names declared `consolidate: none`
//   - missing[]  = category names with NO consolidate declaration (a
//                  validation error — the orchestrator refuses to run)
// No defaults applied: author intent must be explicit. Order mirrors the
// layout YAML's `layout:` order.
export function getConsolidateLayout() {
  const snap = ensureLayoutLoaded();
  const refine = [];
  const excluded = [];
  const missing = [];
  for (const c of snap.cats) {
    const v = snap.consolidateEligibility[c];
    if (v === "refine") refine.push(c);
    else if (v === "none") excluded.push(c);
    else missing.push(c);
  }
  return { refine, excluded, missing };
}

// Public accessor for category names. Triggers layout load on demand so a
// caller (e.g. the MCP `get_memory_config` tool) that does not first touch a
// write/search path still gets the populated list. Returns a fresh copy.
export function getCategories() {
  return [...ensureLayoutLoaded().cats];
}

// True when the category declares a `topology:` block (e.g. tracker `issues`).
// Such a category nests via the topology path-compiler, so writes must carry an
// explicit `path`; a no-path write is refused by the placement guard.
/**
 * @param {string} category
 * @returns {boolean}
 */
export function categoryHasTopology(category) {
  return Boolean(ensureLayoutLoaded().topologyCategories[String(category || "")]);
}

// Public accessor for a category's declared placement facets (a fresh copy; []
// when the category is flat / undeclared). Lets layout-aware tooling (e.g. the
// `doctor` scan) tell a facet-managed category (knowledge / self_improvement /
// plans / ...) from a flat human-curated one without re-reading the YAML.
/**
 * @param {string} category
 * @returns {string[]}
 */
export function getPlacementFacets(category) {
  const f = ensureLayoutLoaded().facets[String(category || "")];
  return Array.isArray(f) ? [...f] : [];
}

// Internal accessors used by the placement module. They return the CURRENT
// root's layout state AFTER ensuring it is loaded, so a consumer never
// snapshots a stale (empty) binding before the lazy init runs.
/**
 * @param {string} category
 * @returns {string[]}
 */
export function placementFacetsFor(category) {
  const f = ensureLayoutLoaded().facets[String(category || "")];
  return Array.isArray(f) ? f : [];
}

/**
 * @param {string} category
 * @returns {Record<string, FacetRule>}
 */
export function placementRulesFor(category) {
  return ensureLayoutLoaded().rules[String(category || "")] || {};
}

/**
 * @param {string} name
 * @returns {Set<string> | null}
 */
export function vocabularyFor(name) {
  const vocabs = ensureLayoutLoaded().vocabs;
  return Object.hasOwn(vocabs, name) ? vocabs[name] : null;
}

/**
 * @param {string} slot
 * @returns {string}
 */
export function slotToCategory(slot) {
  const snap = ensureLayoutLoaded();
  const s = String(slot || "").trim();
  if (snap.cats.includes(s)) return s;
  // Tolerate a few aliases / raw category dirs.
  if (s === "lessons") return "self_improvement";
  if (s === "knowledge_base") return "knowledge";
  return s || "knowledge";
}

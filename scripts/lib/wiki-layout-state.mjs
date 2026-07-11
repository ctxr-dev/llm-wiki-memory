import path from "node:path";
import { root } from "./wiki-core.mjs";
import { fileMtimeMs, parseLayout } from "./wiki-layout-parse.mjs";

// Holds the LIVE, mutable layout bindings and the accessors over them.
// `ensureLayoutLoaded` reads the parsed layout from `wiki-layout-parse.mjs`
// (the pure DEFAULTS + YAML parse) and assigns it into these bindings. The
// bindings + their mutator stay co-located in this ONE module: never import the
// raw PLACEMENT_FACETS / PLACEMENT_RULES / VOCABULARIES bindings across modules
// — go through the accessors, which run `ensureLayoutLoaded` first.

/** @typedef {import("./wiki-layout-parse.mjs").FacetRule} FacetRule */

/** @type {string[]} */
export const CATEGORIES = [];
/** @type {Record<string, string[]>} */
const PLACEMENT_FACETS = {};
// Per-category facet rules from layout `facet_rules`. A rule marks a facet as
// `kind: path` (array-valued -> one directory segment per element) and can pin
// its first segment to a declared vocabulary, with a `fallback` sentinel used
// when the facet is absent/empty. Facets without a rule stay single-segment.
// null-prototype: keys are author-controlled layout category/vocab names, so a
// `__proto__`/`constructor` key can never reach a prototype slot.
/** @type {Record<string, Record<string, FacetRule>>} */
const PLACEMENT_RULES = Object.create(null);
// Declared `vocabularies` (name -> Set<slug>): controlled value sets a
// `kind: path` facet's first segment must belong to.
/** @type {Record<string, Set<string>>} */
const VOCABULARIES = Object.create(null);
// Per-category consolidate eligibility from `layout[].consolidate`. Authors
// must declare "refine" or "none" explicitly; the consolidate orchestrator
// refuses to run when any category lacks the field. null-prototype mirrors
// PLACEMENT_RULES.
/** @type {Record<string, string>} */
const CONSOLIDATE_ELIGIBILITY = Object.create(null);
// Per-category presence of a `topology:` block in the layout YAML. A topology
// category (e.g. tracker `issues`) nests via the topology path-compiler, NOT
// facet placement — so a write to it MUST carry an explicit `path` and a
// no-path write fails loud (see the placement guard). Keyed on block presence,
// never the literal category name.
/** @type {Record<string, boolean>} */
const TOPOLOGY_CATEGORIES = Object.create(null);
let _layoutLoaded = false;
/** @type {string | null} */
let _layoutRootSeen = null;
/** @type {number | null} */
let _layoutMtimeSeen = null;

export function ensureLayoutLoaded() {
  // Re-load if the wiki root changed (test isolation flips MEMORY_DATA_DIR) OR
  // the layout contract was edited since we last read it (so a long-running MCP
  // server picks up `.layout/layout.yaml` changes without a restart).
  const r = root();
  const layoutPath = path.join(r, ".layout", "layout.yaml");
  const mtime = fileMtimeMs(layoutPath);
  if (_layoutLoaded && _layoutRootSeen === r && _layoutMtimeSeen === mtime) return;

  const { cats, facets, rules, vocabs, consolidateEligibility, topologyCategories } =
    parseLayout(layoutPath);

  CATEGORIES.length = 0;
  CATEGORIES.push(...cats);
  for (const k of Object.keys(PLACEMENT_FACETS)) delete PLACEMENT_FACETS[k];
  Object.assign(PLACEMENT_FACETS, facets);
  for (const k of Object.keys(PLACEMENT_RULES)) delete PLACEMENT_RULES[k];
  Object.assign(PLACEMENT_RULES, rules);
  for (const k of Object.keys(VOCABULARIES)) delete VOCABULARIES[k];
  Object.assign(VOCABULARIES, vocabs);
  for (const k of Object.keys(CONSOLIDATE_ELIGIBILITY)) delete CONSOLIDATE_ELIGIBILITY[k];
  Object.assign(CONSOLIDATE_ELIGIBILITY, consolidateEligibility);
  for (const k of Object.keys(TOPOLOGY_CATEGORIES)) delete TOPOLOGY_CATEGORIES[k];
  Object.assign(TOPOLOGY_CATEGORIES, topologyCategories);

  _layoutLoaded = true;
  _layoutRootSeen = r;
  _layoutMtimeSeen = mtime;
}

// Force the next layout-touching call to re-parse .layout/layout.yaml. The mtime
// check already auto-reloads on edit; this is the explicit escape hatch (e.g. the
// `reload_layout` MCP tool, or a copy that preserved mtime) and the test reset.
export function resetLayoutCache() {
  _layoutLoaded = false;
  _layoutRootSeen = null;
  _layoutMtimeSeen = null;
}

// Back-compat alias used by the test suite.
// Report the consolidate-eligibility declared in the layout YAML. Returns
// {refine, excluded, missing} where:
//   - refine[]   = category names declared `consolidate: refine`
//   - excluded[] = category names declared `consolidate: none`
//   - missing[]  = category names with NO consolidate declaration (a
//                  validation error — the orchestrator refuses to run)
// No defaults applied: author intent must be explicit. Order mirrors
// CATEGORIES (i.e. the layout YAML's `layout:` order).
export function getConsolidateLayout() {
  ensureLayoutLoaded();
  const refine = [];
  const excluded = [];
  const missing = [];
  for (const c of CATEGORIES) {
    const v = CONSOLIDATE_ELIGIBILITY[c];
    if (v === "refine") refine.push(c);
    else if (v === "none") excluded.push(c);
    else missing.push(c);
  }
  return { refine, excluded, missing };
}

export function _resetLayoutCacheForTests() {
  resetLayoutCache();
}

// Public accessor for category names. Triggers layout load on demand so a
// caller (e.g. the MCP `get_memory_config` tool) that does not first touch a
// write/search path still gets the populated list. Returns a fresh copy.
export function getCategories() {
  ensureLayoutLoaded();
  return [...CATEGORIES];
}

// True when the category declares a `topology:` block (e.g. tracker `issues`).
// Such a category nests via the topology path-compiler, so writes must carry an
// explicit `path`; a no-path write is refused by the placement guard.
/**
 * @param {string} category
 * @returns {boolean}
 */
export function categoryHasTopology(category) {
  ensureLayoutLoaded();
  return Boolean(TOPOLOGY_CATEGORIES[String(category || "")]);
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
  ensureLayoutLoaded();
  const f = PLACEMENT_FACETS[String(category || "")];
  return Array.isArray(f) ? [...f] : [];
}

// Internal accessors used by the placement module. They return the LIVE layout
// state AFTER ensuring the layout is loaded, so a consumer never snapshots a
// stale (empty) binding before the lazy init runs. Never import the raw
// PLACEMENT_FACETS / PLACEMENT_RULES / VOCABULARIES bindings across modules.
/**
 * @param {string} category
 * @returns {string[]}
 */
export function placementFacetsFor(category) {
  ensureLayoutLoaded();
  const f = PLACEMENT_FACETS[String(category || "")];
  return Array.isArray(f) ? f : [];
}

/**
 * @param {string} category
 * @returns {Record<string, FacetRule>}
 */
export function placementRulesFor(category) {
  ensureLayoutLoaded();
  return PLACEMENT_RULES[String(category || "")] || {};
}

/**
 * @param {string} name
 * @returns {Set<string> | null}
 */
export function vocabularyFor(name) {
  ensureLayoutLoaded();
  return Object.hasOwn(VOCABULARIES, name) ? VOCABULARIES[name] : null;
}

/**
 * @param {string} slot
 * @returns {string}
 */
export function slotToCategory(slot) {
  ensureLayoutLoaded();
  const s = String(slot || "").trim();
  if (CATEGORIES.includes(s)) return s;
  // Tolerate a few aliases / raw category dirs.
  if (s === "lessons") return "self_improvement";
  if (s === "knowledge_base") return "knowledge";
  return s || "knowledge";
}

import fs from "node:fs";
import path from "node:path";
import { wikiRoot, defaultProjectModule } from "./env.mjs";
import { crossCuttingAreas as settingsCrossCutting } from "./settings.mjs";
import { slugify } from "./slug.mjs";
import { ATOM_TYPE_TO_DATASET, TASK_TYPES } from "./datasets.mjs";

/** @typedef {import("./types.mjs").MetadataInput} MetadataInput */
/** @typedef {import("./types.mjs").FacetPatch} FacetPatch */

// Facet inference & validation. The placement facets (area / atom_type /
// task_type) are what both the on-disk tree and search filters key on, so an
// `unknown`/`unscoped` area, an out-of-set `atom_type`, or a missing
// `task_type` is a classification FAILURE that leaves docs in junk buckets
// (e.g. the doubled `knowledge/<area>/knowledge/`).
//
// Two entry points:
//   inferFacets        - SYNC, heuristic-only, used on the (synchronous) write
//                        path. Guarantees a VALID value for every facet via a
//                        deterministic fallback: `area` is never unknown/unscoped/
//                        the workspace name, and `atom_type` is always in the
//                        category's valid set. `task_type` may be the documented
//                        valid `unknown` sentinel when undecidable. No LLM, so the
//                        save path stays fast and non-async.
//   classifyFacetsLLM  - ASYNC, heuristic-first then a single LLM call to pin a
//                        precise sub-module / atom_type. Used by the backfill so
//                        re-identification is accurate, without infecting saves.

// Values that signal "the model did not classify" and must be replaced.
export const BAD_AREA = new Set([
  "",
  "unknown",
  "unscoped",
  "untyped",
  "misc",
  "untitled",
  "none",
  "n-a",
  "na",
]);

// Cross-cutting areas: legitimate buckets for memory that belongs to no single
// code sub-module (e.g. a universal authoring convention). Configurable; the
// FIRST entry is the deterministic fallback.
/**
 * @returns {string[]}
 */
export function crossCuttingAreas() {
  // Settings YAML carries an array directly; legacy env (CSV) is migrated by
  // bootstrap. Fall back to the documented ["workspace", "conventions"]
  // default when the YAML supplies an empty list.
  const fromSettings = settingsCrossCutting();
  const raw = fromSettings.length ? fromSettings : ["workspace", "conventions"];
  const workspace = slugify(defaultProjectModule() || "");
  const list = raw
    .map((s) => slugify(String(s || "").trim()))
    .filter((s) => s && !BAD_AREA.has(s) && s !== workspace);
  if (list.length) return list;
  // Fallback must itself be valid and != the workspace name (covers the corner
  // case where the workspace slugifies to "workspace" and the env list is empty).
  const fallbacks = ["workspace", "conventions", "memory-wide"].filter(
    (s) => !BAD_AREA.has(s) && s !== workspace,
  );
  return [fallbacks[0]];
}

// Valid atom_types for a category (the ones routing to it). For `knowledge`,
// atom_type is a placement facet, so an out-of-set value must be corrected.
/**
 * @param {string} category
 * @returns {Set<string>}
 */
export function validAtomTypes(category) {
  return new Set(
    Object.entries(ATOM_TYPE_TO_DATASET)
      .filter(([, ds]) => ds === category)
      .map(([type]) => type),
  );
}

// Fallback when a knowledge atom_type is missing/out-of-set. `atom_type` is a
// placement facet ONLY for knowledge, so this is the one category that forces a
// valid default; "reference" is the most generic knowledge type (and is in
// validAtomTypes("knowledge")). Other categories keep whatever atom_type the
// caller supplied (or none), so no per-category default table is needed.
const KNOWLEDGE_FALLBACK_ATOM_TYPE = "reference";

// Discover existing sub-module folders for a category from the on-disk tree,
// unioned with the cross-cutting set. Self-adapting: no hardcoded vocabulary.
/**
 * @param {string} category
 * @returns {Set<string>}
 */
export function knownAreas(category) {
  /** @type {Set<string>} */
  const areas = new Set();
  const workspace = slugify(defaultProjectModule() || "");
  try {
    const catAbs = path.join(wikiRoot(), category);
    for (const entry of fs.readdirSync(catAbs, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const a = slugify(entry.name);
      // Exclude the workspace name even if a folder by that name exists, so a
      // tag match or an LLM choice can never resurrect workspace-name-as-area.
      if (a && !BAD_AREA.has(a) && a !== workspace) areas.add(a);
    }
  } catch {
    /* category dir may not exist yet */
  }
  for (const cc of crossCuttingAreas()) areas.add(cc);
  return areas;
}

/**
 * @param {string | string[] | undefined} tags
 * @returns {string[]}
 */
export function tagList(tags) {
  if (Array.isArray(tags)) return tags.map((t) => slugify(String(t))).filter(Boolean);
  return String(tags || "")
    .split(",")
    .map((t) => slugify(t.trim()))
    .filter(Boolean);
}

// Cheap (no-LLM) check: which placement facets of an existing leaf are bad and
// should be re-identified. Scoped to the two failure modes that corrupt the
// tree: an unknown/unscoped/workspace-name `area`, and (for knowledge, where
// atom_type is a facet) an out-of-set `atom_type` (e.g. the doubled
// `knowledge/<area>/knowledge/` bucket). task_type is left to save-time
// best-effort since `unknown` is a documented valid sentinel.
/**
 * @param {string} category
 * @param {MetadataInput} [meta]
 * @returns {string[]}
 */
export function facetIssues(category, meta = {}) {
  if (category === "daily") return [];
  /** @type {string[]} */
  const issues = [];
  const workspace = slugify(defaultProjectModule() || "");
  const area = slugify(String(meta.area || "").trim());
  if (!area || BAD_AREA.has(area) || area === workspace) issues.push("area");
  if (category === "knowledge") {
    const at = String(meta.atom_type || "")
      .trim()
      .toLowerCase();
    if (!validAtomTypes(category).has(at)) issues.push("atom_type");
  }
  return issues;
}

// Heuristic area: provided real area -> project_module-as-sub-module -> a tag
// that names a known sub-module -> the cross-cutting fallback. Never bad.
// knownAreas() (a synchronous readdir) is consulted ONLY on the tag-match path,
// so the common write (caller supplies a valid area or a usable project_module)
// does no directory scan.
/**
 * @param {string} category
 * @param {MetadataInput} meta
 * @param {string[]} tags2
 * @returns {string}
 */
function heuristicArea(category, meta, tags2) {
  const workspace = slugify(defaultProjectModule() || "");

  const provided = slugify(String(meta.area || "").trim());
  if (provided && !BAD_AREA.has(provided) && provided !== workspace) return provided;

  // Accept a legacy `project_module`-as-sub-module value (any name), EXCEPT the
  // workspace identifier itself (post-split that is the project, not a
  // sub-module, which is exactly how `tradingtune` leaked in as an area).
  const pm = slugify(String(meta.project_module || "").trim());
  if (pm && pm !== workspace && !BAD_AREA.has(pm)) return pm;

  // Only now do we need the known sub-modules (a directory scan) to try a tag.
  const cc = crossCuttingAreas();
  const subModules = [...knownAreas(category)].filter((a) => !cc.includes(a));
  const hit = tags2.find((t) => subModules.includes(t));
  if (hit) return hit;

  return cc[0] || "workspace";
}

// SYNC: a valid facet patch { area, atom_type?, task_type? } to merge into the
// caller's metadata before normaliseMeta. `daily` has no placement facets.
/**
 * @param {{ category?: string, meta?: MetadataInput, tags?: string | string[] }} [args]
 * @returns {FacetPatch}
 */
export function inferFacets({ category, meta = {}, tags = [] } = {}) {
  if (category === "daily") return {};
  const tags2 = tagList(tags);
  const validTypes = validAtomTypes(/** @type {string} */ (category));

  /** @type {FacetPatch} */
  const patch = { area: heuristicArea(/** @type {string} */ (category), meta, tags2) };

  const atomType = String(meta.atom_type || "")
    .trim()
    .toLowerCase();
  if (category === "knowledge") {
    patch.atom_type = validTypes.has(atomType) ? atomType : KNOWLEDGE_FALLBACK_ATOM_TYPE;
  } else if (atomType) {
    patch.atom_type = atomType;
  }

  const taskType = String(meta.task_type || "")
    .trim()
    .toLowerCase();
  if (category === "self_improvement") {
    patch.task_type = taskType && TASK_TYPES.has(taskType) ? taskType : "unknown";
  } else if (taskType) {
    patch.task_type = taskType;
  }
  return patch;
}

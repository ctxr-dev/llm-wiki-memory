import { slugify, dailyDatePath } from "./slug.mjs";
import { WikiStoreUnavailable } from "./wiki-core.mjs";
import { slugSegments } from "./wiki-identity.mjs";
import {
  ensureLayoutLoaded,
  slotToCategory,
  categoryHasTopology,
  getCategories,
  placementFacetsFor,
  placementRulesFor,
  vocabularyFor,
} from "./wiki-layout-state.mjs";

// (PLACEMENT_FACETS is initialised by ensureLayoutLoaded() at the top of this
// module; the YAML in <wiki>/.layout/layout.yaml is the source of truth and
// the baked-in defaults preserve historical behavior when the YAML is absent
// or declares no `placement_facets` for a category.)

/** @typedef {import("./types.mjs").MemoryMetadata} MemoryMetadata */
/** @typedef {import("./wiki-layout-state.mjs").FacetRule} FacetRule */
/** @typedef {Record<string, unknown>} PlacementMeta */

// Kebab folder segment for one facet, with deterministic sentinels when the field
// is absent so a missing facet never collapses leaves back into the category root.
/**
 * @param {string} key
 * @param {PlacementMeta} meta
 * @returns {string}
 */
function facetValue(key, meta) {
  const raw = slugify(String((meta && meta[key]) || "").trim());
  if (raw && raw !== "untitled") return raw;
  // Deterministic sentinels for an absent facet field. `area` -> "unscoped" (the
  // sub-module facet key), `task_type` -> "unknown" (already a valid TASK_TYPE),
  // `atom_type` -> "untyped". atom_type is normally always set by normaliseMeta
  // (slotDefaultAtomType), so "untyped" only surfaces for a malformed legacy
  // leaf during migration.
  /** @type {Record<string, string>} */
  const sentinels = { area: "unscoped", task_type: "unknown", atom_type: "untyped" };
  return sentinels[key] || "misc";
}

// Expand a `kind: path` facet into one-or-more directory segments (broad->narrow).
// The facet value may be an array (`subject: [a, b, c]`) or a "/"-joined string.
// An absent/empty value collapses to the rule's `fallback` sentinel so a leaf is
// never dropped at the category root. When a `vocabulary` is declared, the FIRST
// segment must belong to it; otherwise we throw (FAIL LOUD) rather than write a
// leaf under an un-curated top-level domain.
/**
 * @param {string} key
 * @param {PlacementMeta} meta
 * @param {FacetRule} rule
 * @returns {string[]}
 */
function pathFacetSegments(key, meta, rule) {
  const parts = slugSegments(meta ? meta[key] : undefined);
  const fallback = slugify(String(rule.fallback || "general")) || "general";
  if (parts.length === 0) return [fallback];
  const vocab = rule.vocabulary ? vocabularyFor(rule.vocabulary) : null;
  if (vocab && vocab.size > 0 && !vocab.has(parts[0])) {
    throw new WikiStoreUnavailable(
      `placement: '${key}' domain '${parts[0]}' is not in vocabulary '${rule.vocabulary}'. ` +
        `Allowed: ${[...vocab].join(", ")}. ` +
        `Provide a valid first '${key}' segment, or omit '${key}' to use the '${fallback}' fallback.`,
    );
  }
  return parts;
}

/** @typedef {{ facet: string, from: string, to: string }} FacetRemap */

// Pre-validate a note's `kind: path` facets against the ACTIVE root's merged
// layout vocabulary and REMAP an out-of-vocab first segment to the rule's
// fallback (`general`) instead of letting the write throw. Run inside the
// TARGET level's `withWikiRoot` frame so the vocabulary checked is that level's
// (R2): a write the user directed to a shared repo must never hard-throw on an
// out-of-vocab subject. Deeper sub-segments are preserved under the fallback
// domain. Absent/in-vocab facets and vocabulary-less path facets are left
// untouched, and the deep `pathFacetSegments` throw stays as the last-resort net
// for callers that skip this step. Returns the (possibly new) metadata object
// plus the list of remaps applied.
/**
 * @param {string} categoryOrSlot
 * @param {PlacementMeta} [metadata]
 * @returns {{ metadata: PlacementMeta, remaps: FacetRemap[] }}
 */
export function remapUnknownPathFacets(categoryOrSlot, metadata = {}) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  /** @type {FacetRemap[]} */
  const remaps = [];
  const category = slotToCategory(String(categoryOrSlot || ""));
  if (category === "daily") return { metadata: meta, remaps };
  ensureLayoutLoaded();
  const catRules = placementRulesFor(category);
  let next = meta;
  for (const key of placementFacetsFor(category)) {
    const rule = catRules[key];
    if (!rule || rule.kind !== "path" || !rule.vocabulary) continue;
    const vocab = vocabularyFor(rule.vocabulary);
    if (!vocab || vocab.size === 0) continue;
    const parts = slugSegments(next[key]);
    if (parts.length === 0 || vocab.has(parts[0])) continue;
    const fallback = slugify(String(rule.fallback || "general")) || "general";
    next = { ...next, [key]: [fallback, ...parts.slice(1)] };
    remaps.push({ facet: key, from: parts[0], to: fallback });
  }
  return { metadata: next, remaps };
}

// Relative dir (under the wiki root) for a leaf, derived from its NORMALISED
// `memory` metadata. Exported so migrate-nest computes the same target from an
// existing leaf's frontmatter. Returns null for `daily` (caller date-nests it).
/**
 * @param {string} category
 * @param {PlacementMeta} [meta]
 * @returns {string | null}
 */
export function placementDirForMeta(category, meta = {}) {
  ensureLayoutLoaded();
  if (category === "daily") return null;
  const facets = placementFacetsFor(category);
  if (facets.length === 0) return category;
  const catRules = placementRulesFor(category);
  const segs = [category];
  for (const k of facets) {
    const rule = catRules[k];
    if (rule && rule.kind === "path") {
      segs.push(...pathFacetSegments(k, meta, rule));
    } else {
      segs.push(facetValue(k, meta));
    }
  }
  return segs.join("/");
}

// Resolve where a NEW leaf for a slot should live (relative dir under wiki).
/**
 * @param {string} slot
 * @param {{ metadata?: PlacementMeta, date?: Date }} [opts]
 * @returns {string}
 */
export function placementDir(slot, { metadata = {}, date = new Date() } = {}) {
  const category = slotToCategory(slot);
  if (category === "daily") return `daily/${dailyDatePath(date)}`;
  return placementDirForMeta(category, metadata) ?? category;
}

// Validate a caller-supplied `placementOverride` path: must be a relative
// directory under the wiki root, no traversal, no nulls, no leading slash.
// Returns the normalised relative dir (forward-slash separated) on success;
// throws WikiStoreUnavailable on a rejected path.
/**
 * @param {unknown} raw
 * @returns {string}
 */
export function normalisePlacementOverride(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new WikiStoreUnavailable(
      `placementOverride must be a non-empty string; got: ${JSON.stringify(raw)}`,
    );
  }
  if (raw.includes("\0")) {
    throw new WikiStoreUnavailable("placementOverride contains a NUL byte");
  }
  // Reject absolute paths and Windows drive letters defensively.
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new WikiStoreUnavailable(
      `placementOverride must be relative to the wiki root; got: ${raw}`,
    );
  }
  // Forbid `..` segments so a caller can't escape the wiki root, even though
  // path.join would normalise some of them away. We also strip empty segments.
  const segs = raw.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  if (segs.length === 0) {
    throw new WikiStoreUnavailable(
      `placementOverride must include at least one path segment; got: ${raw}`,
    );
  }
  if (segs.some((s) => s === "..")) {
    throw new WikiStoreUnavailable(`placementOverride must not contain '..' segments; got: ${raw}`);
  }
  return segs.join("/");
}

// Fail loud (never default to the category root) when a topology category is
// written without an explicit placement path. Facet placement can't express a
// topology tree, so a no-path write would silently land flat at the root — the
// exact bug that stranded the tracker plans. The MCP boundary additionally
// validates that a SUPPLIED path matches the topology (async round-trip); this
// sync guard closes the no-path hole for EVERY caller (saveDocument,
// updateDocMetadata, hooks, CLI). Compute the path from `.layout/layout.yaml`'s
// file_kind facets and pass it as `path`/`placementOverride`.
/**
 * @param {string} category
 * @param {unknown} placementOverride
 * @returns {void}
 */
export function assertTopologyPlacement(category, placementOverride) {
  if (placementOverride !== undefined && placementOverride !== null) return;
  if (!categoryHasTopology(category)) return;
  throw new WikiStoreUnavailable(
    `category "${category}" has a topology block in .layout/layout.yaml and requires an explicit path; ` +
      `compute it from the file_kind facets (e.g. issues plan -> issues/<tracker>/<prefix>/<buckets>/<lifecycle>/<file>.plan.md) and pass it as path`,
  );
}

// Reject a slot that is not one of the five contract categories, so we never
// create a top-level wiki directory the layout contract does not declare
// (which would break `skill-llm-wiki validate`).
/**
 * @param {string} slot
 * @returns {string}
 */
export function assertKnownSlot(slot) {
  const category = slotToCategory(slot);
  const cats = getCategories();
  if (!cats.includes(category)) {
    throw new WikiStoreUnavailable(
      `unknown memory category '${slot}'. Valid categories: ${cats.join(", ")}.`,
    );
  }
  return category;
}

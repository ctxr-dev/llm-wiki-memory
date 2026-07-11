import fs from "node:fs";
import { slugify } from "./slug.mjs";

// The pure parse half of the layout state (see `wiki-layout-state.mjs`, which
// holds the per-root snapshot cache + accessors and calls `parseLayoutObject`
// from inside `ensureLayoutLoaded`). This module owns the baked-in DEFAULTS and
// the stateless projection of an ALREADY-parsed (merged + validated) layout
// object into plain structures; it never reads files or mutates shared state.
// The file read + shared/local merge live in `layout-merge.mjs`.
//
// CATEGORIES and PLACEMENT_FACETS were previously hardcoded module-level
// constants. They are now sourced from <wiki>/.layout/layout.yaml on first
// access. The defaults below preserve historical behavior for any wiki that
// does NOT declare `layout[].placement_facets` (or has no layout YAML at all).
//
// The YAML schema is:
//   layout:
//     - path: <category-dir-name>            # required
//       placement_facets: [<meta key>, ...]  # optional; if absent we use the
//                                            #   baked-in default for this name
//                                            #   (knowledge/self_improvement/
//                                            #   plans/investigations); for any
//                                            #   NEW category, omitting facets
//                                            #   means flat under the category
//       placement_strategy: daily-date       # optional; only `daily-date` is
//                                            #   recognized (used today for the
//                                            #   `daily` category which nests
//                                            #   by capture date, not facets)
//
// Callers can opt into an exact-placement OVERRIDE per write by passing
// `placementOverride` to writeMemory / saveDocument (or `path` on the MCP
// tools). When supplied, the override bypasses category facet derivation; the
// only remaining role of CATEGORIES is to gate which slots are accepted as a
// `datasetId`.
const DEFAULT_CATEGORIES = Object.freeze([
  "knowledge",
  "self_improvement",
  "plans",
  "investigations",
  "daily",
]);
/** @type {Record<string, readonly string[]>} */
const DEFAULT_PLACEMENT_FACETS = Object.freeze({
  knowledge: Object.freeze(["area", "atom_type"]),
  self_improvement: Object.freeze(["area", "task_type"]),
  plans: Object.freeze(["area"]),
  investigations: Object.freeze(["area"]),
});

/**
 * @typedef {{ kind: "path" | "segment", vocabulary: string | null, fallback: string | null }} FacetRule
 */

/**
 * @typedef {Object} ParsedLayout
 * @property {string[]} cats
 * @property {Record<string, string[]>} facets
 * @property {Record<string, Record<string, FacetRule>>} rules
 * @property {Record<string, Set<string>>} vocabs
 * @property {Record<string, string>} consolidateEligibility
 * @property {Record<string, boolean>} topologyCategories
 */

// Loose views over the ALREADY-parsed layout object. The object was produced by
// `parseYaml` and validated against `LayoutYamlSchema` upstream, so fields are
// read defensively (unknown, narrowed at use) rather than trusted — same
// cast-once pattern as topology-loader.mjs.
/**
 * @typedef {Object} RawFacetRule
 * @property {unknown} [kind]
 * @property {unknown} [vocabulary]
 * @property {unknown} [fallback]
 */
/**
 * @typedef {Object} RawLayoutEntry
 * @property {unknown} [path]
 * @property {unknown} [placement_facets]
 * @property {unknown} [placement_strategy]
 * @property {Record<string, RawFacetRule>} [facet_rules]
 * @property {unknown} [consolidate]
 * @property {unknown} [topology]
 */
/**
 * @typedef {Object} RawLayoutDoc
 * @property {Record<string, unknown>} [vocabularies]
 * @property {RawLayoutEntry[]} [layout]
 */

// mtime (ms) of a file, or 0 if it's absent/unreadable.
/**
 * @param {string} p
 * @returns {number}
 */
export function fileMtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// Project an ALREADY-parsed (merged + validated) layout object into the plain
// layout structures, applying the baked-in defaults for undeclared categories.
// A null/undefined/non-object input (an absent, malformed, or schema-invalid
// layout that the caller already fell back on) yields the pure defaults. Never
// reads files, never mutates shared state; the caller snapshots the result.
/**
 * @param {Record<string, unknown> | null | undefined} parsed
 * @returns {ParsedLayout}
 */
export function parseLayoutObject(parsed) {
  const cats = [...DEFAULT_CATEGORIES];
  /** @type {Record<string, string[]>} */
  const facets = {};
  for (const k of Object.keys(DEFAULT_PLACEMENT_FACETS)) {
    facets[k] = [...DEFAULT_PLACEMENT_FACETS[k]];
  }
  // null-prototype maps: layout keys are author-controlled, so never let a
  // key like `__proto__`/`constructor` reach a prototype slot.
  /** @type {Record<string, Record<string, FacetRule>>} */
  const rules = Object.create(null);
  /** @type {Record<string, Set<string>>} */
  const vocabs = Object.create(null);
  // Per-category consolidate eligibility from the layout. Three states:
  //   "refine"  -> include this category in the consolidate orchestrator's
  //                working set (eligible for dedup / staleness / refresh /
  //                compress passes per the orchestrator's rules).
  //   "none"    -> explicitly excluded. consolidate never walks this category.
  //   <missing> -> error. The orchestrator refuses to run until the field is
  //                declared (no defaults — author intent must be explicit).
  const consolidateEligibility = Object.create(null);
  const topologyCategories = Object.create(null);

  const doc = /** @type {RawLayoutDoc} */ (parsed && typeof parsed === "object" ? parsed : {});

  // Controlled value sets referenced by `kind: path` facet rules.
  if (doc.vocabularies && typeof doc.vocabularies === "object") {
    for (const [vname, vals] of Object.entries(doc.vocabularies)) {
      if (!Array.isArray(vals)) continue;
      vocabs[vname] = new Set(vals.map((v) => slugify(String(v))).filter(Boolean));
    }
  }
  const entries = Array.isArray(doc.layout) ? doc.layout : [];
  if (entries.length > 0) {
    // Replace categories wholesale from the layout (the YAML is the declared
    // contract).
    cats.length = 0;
    for (const e of entries) {
      const name = String((e && e.path) || "").trim();
      if (!name) continue;
      cats.push(name);
      if (Array.isArray(e.placement_facets)) {
        facets[name] = e.placement_facets.map((/** @type {unknown} */ s) => String(s));
      } else if (DEFAULT_PLACEMENT_FACETS[name]) {
        facets[name] = [...DEFAULT_PLACEMENT_FACETS[name]];
      } else if (name === "daily" || e.placement_strategy === "daily-date") {
        // daily is special-cased downstream; no facets entry needed.
      } else {
        // Declared but unspecified -> flat under category root.
        facets[name] = [];
      }
      if (e.facet_rules && typeof e.facet_rules === "object") {
        const r2 = Object.create(null);
        for (const [fname, spec] of Object.entries(e.facet_rules)) {
          if (!spec || typeof spec !== "object") continue;
          r2[fname] = {
            kind: spec.kind === "path" ? "path" : "segment",
            vocabulary: spec.vocabulary ? String(spec.vocabulary) : null,
            fallback: spec.fallback != null ? String(spec.fallback) : null,
          };
        }
        rules[name] = r2;
      }
      // consolidate: refine | none  (no default — see comment above).
      if (e.consolidate !== undefined) {
        const v = String(e.consolidate).trim().toLowerCase();
        if (v === "refine" || v === "none") consolidateEligibility[name] = v;
        // any other value falls through and the orchestrator surfaces the
        // missing/invalid field at runtime.
      }
      // A `topology:` block means this category nests via the path-compiler,
      // not facet placement: writes must supply an explicit path.
      if (e.topology && typeof e.topology === "object") {
        topologyCategories[name] = true;
      }
    }
    // Drop default facet keys for categories the layout did NOT declare.
    for (const k of Object.keys(facets)) {
      if (!cats.includes(k)) delete facets[k];
    }
  }

  return { cats, facets, rules, vocabs, consolidateEligibility, topologyCategories };
}

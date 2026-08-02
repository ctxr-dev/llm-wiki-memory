// The baked-in layout DEFAULTS: what a wiki gets for a category it does not
// declare (or when it has no layout YAML at all). Data only — no parsing, no
// filesystem, no state. Kept apart from the projection logic in
// wiki-layout-parse.mjs so the historical defaults are readable in one place.

/** @type {Record<string, readonly string[]>} */
export const DEFAULT_PLACEMENT_FACETS = Object.freeze({
  knowledge: Object.freeze(["area", "atom_type"]),
  self_improvement: Object.freeze(["area", "task_type"]),
  plans: Object.freeze(["area"]),
  investigations: Object.freeze(["area"]),
});

// Name-keyed default for the per-category write-gate. self_improvement is gated
// out of the box (its consent gate predates the layout flag); every other
// category is ungated unless its layout entry opts in with `gated: true`. Seeded
// onto declared-but-omitted categories so an existing layout keeps behaviour
// without a YAML edit.
/** @type {Record<string, boolean>} */
export const DEFAULT_GATED = Object.freeze({
  self_improvement: true,
});

// Built-in per-facet help text, surfaced by the webapp editor as a field-label
// tooltip. This is the single source of the DEFAULT descriptions; a wiki's
// `facet_meta` in layout.yaml overrides any of them per field (and may add help
// for its own facets). Kept here beside the other baked-in layout defaults.
/** @typedef {{ description?: string, examples?: string[] }} FacetMeta */
/** @type {Record<string, FacetMeta>} */
export const DEFAULT_FACET_META = Object.freeze({
  area: {
    description:
      "The sub-module this note belongs to (e.g. backend, frontend, infra) — never the project name.",
  },
  atom_type: {
    description:
      "The kind of note: a decision, a bug root-cause, a reusable lesson, reference material, and so on.",
  },
  task_type: {
    description:
      "The kind of task this lesson came from (planning, implementation, debugging, review, …).",
  },
  priority: {
    description:
      "How strongly this note is applied and ranked in recall: P0 = hard constraint, P1 = strong default, P2 = contextual.",
  },
  subject: {
    description:
      "What the note is about — one or more topic tags used to group and find related notes.",
  },
});

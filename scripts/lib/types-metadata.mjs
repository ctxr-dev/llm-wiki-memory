// Shared JSDoc type vocabulary — scalars, metadata, and on-disk leaf shapes.
//
// The metadata half of the engine's type vocabulary (see `types.mjs`, the
// barrel that re-exports this module): the apply-strength / plan-status enums,
// the stored `memory` frontmatter block and its loose caller-supplied input
// form, the facet patch, and the full on-disk leaf frontmatter shapes.
//
// This module exports nothing at runtime — `export {}` only marks it as an ESM
// module so the typedefs live in module scope. Every field is JSDoc-typed with
// no `any`; genuinely dynamic values use unions / `Record<string, unknown>` /
// `unknown`. Fields in `[brackets]` are optional. Field names are taken
// verbatim from the code (do not rename them here — several are external
// contract keys stored in leaf frontmatter).

/**
 * Apply-strength tier stamped on every leaf. `datasets.mjs` PRIORITIES.
 * @typedef {"P0" | "P1" | "P2"} Priority
 */

/**
 * Plan lifecycle state, held at TOP LEVEL of the leaf frontmatter (distinct
 * from `MemoryMetadata.status`, which is the active/archived flag). Set by the
 * plan-frontmatter sync from checkbox state.
 * @typedef {"pending" | "in-progress" | "done" | "archived"} PlanStatus
 */

/**
 * The NORMALISED `memory` frontmatter block persisted on every leaf — the
 * output of `wiki-identity.mjs` `normaliseMeta` and what `leafMemory` reads
 * back. `atom_type`, `status`, and `priority` are ALWAYS present (never
 * stripped, though `atom_type` may be the empty string for a malformed legacy
 * leaf); every other field is omitted when empty. This is the shape the search
 * filter matcher (`metaMatchesFilters`) compares against.
 *
 * @typedef {Object} MemoryMetadata
 * @property {string} atom_type - one of datasets.mjs ATOM_TYPES (or "" for a malformed legacy leaf).
 * @property {string} status - active/archived flag; canonically "active" or "archived" (isActive treats anything != "archived" as active).
 * @property {Priority} priority - apply-strength tier; filled by the atom_type rubric when the caller omits it.
 * @property {string} [project_module] - the WORKSPACE identifier (stable per install); the default recall scope.
 * @property {string} [area] - the fine-grained sub-module (facet + fine scope); legacy leaves carry it in project_module.
 * @property {string} [language]
 * @property {string} [task_type] - one of datasets.mjs TASK_TYPES.
 * @property {string} [error_pattern] - kebab-case failure-mode slug (dedup key for lessons).
 * @property {string} [tags] - COMMA-joined string (arrays are joined on write; membership-matched on read).
 * @property {string[]} [subject] - hierarchical semantic path, stored as a slug ARRAY (broad -> narrow).
 * @property {boolean} [stale] - consolidate refresh flag.
 * @property {string} [supersedes_id] - documentId this leaf supersedes (consolidate).
 * @property {string} [consolidated_at] - ISO timestamp (consolidate).
 * @property {string} [last_refreshed_at] - ISO timestamp (consolidate).
 * @property {string} [consolidate_truncated_at] - ISO timestamp; set once an archived body is compress-truncated.
 */

/**
 * LOOSE, caller-supplied metadata accepted by the write doors (`saveDocument`,
 * `writeMemory`, `updateDocMetadata`, `saveLesson`) and carried on a
 * `DistilledAtom`, BEFORE `normaliseMeta` canonicalises it into
 * `MemoryMetadata`. Every key is optional; `tags`/`subject` accept a string OR
 * an array; callers may pass additional keys not listed here.
 *
 * @typedef {Object} MetadataInput
 * @property {string} [atom_type]
 * @property {string} [project_module] - legacy sub-module alias for `area` (NOT the workspace value on read).
 * @property {string} [project_module_override] - explicit workspace override for a deliberate cross-project save.
 * @property {string} [area]
 * @property {string} [language]
 * @property {string} [task_type]
 * @property {string} [error_pattern]
 * @property {string} [priority]
 * @property {string} [status]
 * @property {string} [title] - read by `deriveTitle`; not persisted into the `memory` block.
 * @property {string | string[]} [tags]
 * @property {string | string[]} [subject]
 * @property {boolean} [stale]
 * @property {string} [supersedes_id]
 * @property {string} [consolidated_at]
 * @property {string} [last_refreshed_at]
 * @property {string} [consolidate_truncated_at]
 */

/**
 * The facet patch `inferFacets` returns, merged over caller metadata before
 * placement. Empty object for the `daily` category.
 * @typedef {Object} FacetPatch
 * @property {string} [area]
 * @property {string} [atom_type]
 * @property {string} [task_type]
 */

/**
 * Provenance stamp `renderLeaf` writes; `source.hash` is preserved verbatim
 * through consolidate truncation so the original body is reconstructable.
 * @typedef {Object} LeafSource
 * @property {string} origin - e.g. "inline".
 * @property {string} hash - "sha256:<hex>".
 */

/**
 * Plan progress derived from checkbox state (plan-frontmatter).
 * @typedef {Object} PlanProgress
 * @property {number} total - total checkbox count.
 * @property {number} done - checked count.
 * @property {string} label - "<done>/<total>".
 */

/**
 * The FULL top-level frontmatter (`data`) of a leaf as parsed by gray-matter
 * in `readLeaf` and composed by `renderLeaf`. `memory` is the nested filterable
 * block; `status`/`progress` are present only on plan leaves.
 *
 * @typedef {Object} LeafFrontmatter
 * @property {string} id - leaf id == filename stem.
 * @property {string} type - skill-llm-wiki node type, e.g. "primary".
 * @property {string} depth_role - e.g. "leaf".
 * @property {string} focus - one-line focus string.
 * @property {string[]} parents - parent leaf names, e.g. ["index.md"].
 * @property {string[]} covers - >= 3 recall-cover bullets.
 * @property {LeafSource} source
 * @property {string} updated - ISO date (yyyy-mm-dd).
 * @property {MemoryMetadata} memory
 * @property {string} [brief] - precomputed glance brief.
 * @property {string[]} [tags]
 * @property {PlanStatus} [status] - plan lifecycle state (plan leaves only).
 * @property {PlanProgress} [progress] - plan checkbox progress (plan leaves only).
 */

/**
 * The opt-in compact "glance" fields `glanceFields` adds to a record for the
 * `sections:["frontmatter"]` read path.
 * @typedef {Object} GlanceFields
 * @property {string} brief
 * @property {string} [type] - the atom_type.
 * @property {PlanStatus} [status]
 * @property {PlanProgress} [progress]
 * @property {string[]} [tags]
 */

export {};

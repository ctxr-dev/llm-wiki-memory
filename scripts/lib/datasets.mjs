// Central registry for atom types, dataset routing, and metadata schema.
// Both flush.mjs and compile.mjs import from here so the type list cannot
// drift between extraction and promotion.

export const ATOM_TYPES = new Set([
  "decision",
  "bug-root-cause",
  "feedback-rule",
  "project-lore",
  "reference",
  "pattern-gotcha",
  "self-improvement-lesson",
  // `plan` is set by the ExitPlanMode auto-capture hook and by manual
  // save_to_dataset calls into the `plans` slot. Compile never produces it
  // (plans are not extracted from transcripts), but it must be a known type
  // so future filtered retrieval can reach plans by atom_type without
  // tripping enum-validation paths.
  "plan",
]);

// Atom-type -> default dataset slot when promoted by compile.
// Inline `save_lesson` writes go directly to "self_improvement"; everything
// else routes through this table. Falls back to DIFY_COMPILE_DATASET when
// the type is not listed (forward-compat for new atom types).
export const ATOM_TYPE_TO_DATASET = {
  decision: "knowledge",
  "bug-root-cause": "knowledge",
  "feedback-rule": "knowledge",
  "project-lore": "knowledge",
  reference: "knowledge",
  "pattern-gotcha": "knowledge",
  "self-improvement-lesson": "self_improvement",
  plan: "plans",
};

// Apply-strength tiers. P0 = a hard constraint (guardrail/invariant) the model
// must honour and that governs on contradiction; P1 = strong default; P2 =
// contextual. P0 is SCARCE: never produced by the rubric or auto-assigned — it
// enters only via an explicit user/human designation (e.g. a gated lesson), so
// the "hard constraint" tier stays trustworthy.
const PRIORITIES = new Set(["P0", "P1", "P2"]);
const DEFAULT_PRIORITY = "P2";

const PRIORITY_P1_TYPES = new Set([
  "feedback-rule",
  "decision",
  "bug-root-cause",
  "pattern-gotcha",
  "investigation",
  "self-improvement-lesson",
]);

// Deterministic default priority for an atom_type when none was supplied.
// NEVER returns P0 (see PRIORITIES). Used by the write choke point
// (normaliseMeta) and the backfill CLI so every leaf carries a valid priority.
/** @typedef {import("./types.mjs").Priority} Priority */
/** @typedef {import("./types.mjs").DistilledAtom} DistilledAtom */

/**
 * @param {unknown} atomType
 * @param {{ lifecycle?: string }} [opts]
 * @returns {Priority}
 */
export function priorityForAtomType(atomType, { lifecycle } = {}) {
  const t = String(atomType || "").trim();
  if (t === "plan") {
    const lc = String(lifecycle || "")
      .trim()
      .toLowerCase();
    return lc === "done" || lc === "archived" ? "P2" : "P1";
  }
  if (PRIORITY_P1_TYPES.has(t)) return "P1";
  return DEFAULT_PRIORITY; // reference, project-lore, daily-capture, unknown
}

// Coerce an arbitrary value to a valid priority, or null if not one.
/**
 * @param {unknown} value
 * @returns {Priority | null}
 */
export function normalisePriority(value) {
  const v = String(value || "")
    .trim()
    .toUpperCase();
  return PRIORITIES.has(v) ? /** @type {Priority} */ (v) : null;
}

// Ordinal for sorting: lower = higher priority (P0 first). Unknown/absent sorts
// as P2 (lowest) so a missing value never outranks a real one.
/**
 * @param {unknown} p
 * @returns {number}
 */
export function priorityRank(p) {
  return p === "P0" ? 0 : p === "P1" ? 1 : 2;
}

// P0 is scarce: a write may set it only with an explicit consent signal
// (`p0Allowed` = an in-turn user flag or a system-maintenance frame). Otherwise
// the requested P0 is coerced DOWN to P1. Pure + unit-testable; the MCP boundary
// supplies p0Allowed and the user-facing note.
/**
 * @param {Priority} priority
 * @param {boolean} p0Allowed
 * @returns {{ priority: Priority, coerced: boolean }}
 */
export function enforceP0Scarcity(priority, p0Allowed) {
  if (priority === "P0" && !p0Allowed) return { priority: "P1", coerced: true };
  return { priority, coerced: false };
}

export const TASK_TYPES = new Set([
  "planning",
  "implementation",
  "debugging",
  "refactor",
  "review",
  "deploy",
  "docs",
  "unknown",
]);

// Normalise an atom's metadata block into the exact fields Dify will store.
// Tags array is joined with commas. Empty/absent fields are OMITTED so
// downstream filters never match `is ""` against entries that simply lack
// the field. atom_type is always present since the atom has a type.
/**
 * @param {{ metadata?: import("./types.mjs").MetadataInput, tags?: unknown, type?: unknown } | null | undefined} atom
 * @returns {Record<string, string>}
 */
export function metadataForDify(atom) {
  const md = /** @type {import("./types.mjs").MetadataInput} */ (
    (atom && typeof atom.metadata === "object" && atom.metadata) || {}
  );
  const tagsField = Array.isArray(atom?.tags)
    ? atom.tags
        .map((t) => String(t).trim())
        .filter(Boolean)
        .join(",")
    : String(md.tags || "").trim();
  /** @type {Record<string, string>} */
  const out = { atom_type: String(atom?.type || "").trim() };
  /**
   * @param {string} k
   * @param {unknown} v
   */
  const maybe = (k, v) => {
    const cleaned = String(v || "").trim();
    if (cleaned) out[k] = cleaned;
  };
  if (tagsField) out.tags = tagsField;
  maybe("project_module", md.project_module);
  // `area` is the sub-module. Accept it directly, or fall back to a legacy
  // `project_module` value (older atoms used project_module for the sub-module).
  maybe("area", md.area || md.project_module);
  maybe("language", md.language);
  maybe("task_type", md.task_type);
  maybe("error_pattern", md.error_pattern);
  // Pass an explicit priority through if the atom already carries one; otherwise
  // the write choke point (normaliseMeta) fills the rubric default by atom_type.
  maybe("priority", md.priority);
  return out;
}

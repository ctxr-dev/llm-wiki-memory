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
  "decision": "knowledge",
  "bug-root-cause": "knowledge",
  "feedback-rule": "knowledge",
  "project-lore": "knowledge",
  "reference": "knowledge",
  "pattern-gotcha": "knowledge",
  "self-improvement-lesson": "self_improvement",
  "plan": "plans",
};

// Per-document metadata schema applied to every Dify dataset. Dify supports
// only string/number/time field types (no arrays); tags are stored as a
// comma-separated string queried with the `contains` operator.
export const METADATA_SCHEMA = [
  { name: "atom_type", type: "string" },
  { name: "tags", type: "string" },
  // project_module is the WORKSPACE identifier (stable per install); `area` is the
  // fine-grained sub-module (part of the codebase) used for facet placement and
  // optional fine scoping. Recall defaults to project_module so it matches every
  // leaf; pass `area` to narrow.
  { name: "project_module", type: "string" },
  { name: "area", type: "string" },
  { name: "language", type: "string" },
  { name: "task_type", type: "string" },
  { name: "error_pattern", type: "string" },
  // Apply-strength of the atom (P0 hard constraint / P1 strong default / P2
  // contextual). Drives priority-aware recall (within-band tie-break + which
  // bodies survive the response budget). Filled by the rubric when absent.
  { name: "priority", type: "string" },
];

// Apply-strength tiers. P0 = a hard constraint (guardrail/invariant) the model
// must honour and that governs on contradiction; P1 = strong default; P2 =
// contextual. P0 is SCARCE: never produced by the rubric or auto-assigned — it
// enters only via an explicit user/human designation (e.g. a gated lesson), so
// the "hard constraint" tier stays trustworthy.
export const PRIORITIES = new Set(["P0", "P1", "P2"]);
export const DEFAULT_PRIORITY = "P2";

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
export function priorityForAtomType(atomType, { lifecycle } = {}) {
  const t = String(atomType || "").trim();
  if (t === "plan") {
    const lc = String(lifecycle || "").trim().toLowerCase();
    return lc === "done" || lc === "archived" ? "P2" : "P1";
  }
  if (PRIORITY_P1_TYPES.has(t)) return "P1";
  return DEFAULT_PRIORITY; // reference, project-lore, daily-capture, unknown
}

// Coerce an arbitrary value to a valid priority, or null if not one.
export function normalisePriority(value) {
  const v = String(value || "").trim().toUpperCase();
  return PRIORITIES.has(v) ? v : null;
}

// Ordinal for sorting: lower = higher priority (P0 first). Unknown/absent sorts
// as P2 (lowest) so a missing value never outranks a real one.
export function priorityRank(p) {
  return p === "P0" ? 0 : p === "P1" ? 1 : 2;
}

// P0 is scarce: a write may set it only with an explicit consent signal
// (`p0Allowed` = an in-turn user flag or a system-maintenance frame). Otherwise
// the requested P0 is coerced DOWN to P1. Pure + unit-testable; the MCP boundary
// supplies p0Allowed and the user-facing note.
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

export function routeAtomToDataset(atomType, fallback) {
  return ATOM_TYPE_TO_DATASET[atomType] || fallback;
}

// Normalise an atom's metadata block into the exact fields Dify will store.
// Tags array is joined with commas. Empty/absent fields are OMITTED so
// downstream filters never match `is ""` against entries that simply lack
// the field. atom_type is always present since the atom has a type.
export function metadataForDify(atom) {
  const md = (atom && typeof atom.metadata === "object" && atom.metadata) || {};
  const tagsField = Array.isArray(atom?.tags)
    ? atom.tags.map((t) => String(t).trim()).filter(Boolean).join(",")
    : String(md.tags || "").trim();
  const out = { atom_type: String(atom?.type || "").trim() };
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

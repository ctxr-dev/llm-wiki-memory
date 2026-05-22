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
  { name: "project_module", type: "string" },
  { name: "language", type: "string" },
  { name: "task_type", type: "string" },
  { name: "error_pattern", type: "string" },
];

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
  maybe("language", md.language);
  maybe("task_type", md.task_type);
  maybe("error_pattern", md.error_pattern);
  return out;
}

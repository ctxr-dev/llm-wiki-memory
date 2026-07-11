// Static declarations shared across the consolidate passes: the canonical
// pass-name list and the atom-type Sets that gate per-leaf behaviour WITHIN a
// refine-eligible category. Category eligibility itself comes from the layout
// YAML (`consolidate: refine`); these Sets are the within-category semantic.

export const ALL_PASS_NAMES = Object.freeze([
  "dedupe-by-sha256",
  "dedupe-by-lesson-key",
  "dedupe-by-cosine",
  "llm-merge-near-duplicates",
  "staleness-flag",
  "llm-semantic-refresh",
  "prune-orphan-leaves",
  "compress-archived",
  "prune-empty-ancestors",
  "prune-embeddings",
  "index-rebuild",
]);

// Atom types whose graph reaches outside the wiki (issue trackers, plans,
// long-lived knowledge artefacts). Orphan-detection skips them because their
// "no inbound link" is a property of the external world, not the wiki.
export const ORPHAN_EXCLUDE_ATOM_TYPES = new Set([
  "jira_issue",
  "plan",
  "investigation",
  "decision",
  "project-lore",
  "reference",
  // Daily-capture leaves are inputs to compile, not durable knowledge; their
  // lifecycle is owned by compile.mjs (promotes them, archives the source).
  // Exempt them from orphan-archival so a year-old daily that compile hasn't
  // yet promoted isn't silently archived by consolidate.
  "daily-capture",
]);

// Atom types eligible for the staleness pass (and therefore for
// llm-semantic-refresh). This is purely an atom_type semantic filter —
// category eligibility comes from the layout YAML's `consolidate: refine`
// declaration. ANY refine-eligible category whose leaves carry one of
// these atom_types participates uniformly.
//
// Why these (and not others):
//   self-improvement-lesson — canonical self_improvement leaf shape.
//   bug-root-cause / feedback-rule / pattern-gotcha — knowledge atoms that
//   can drift over time (the bug was fixed; the rule was reversed; the
//   gotcha became obsolete after a library upgrade).
//
// Intentionally excluded (durable / canonical records):
//   decision    — architectural decisions are point-in-time records.
//   reference   — canonical pointers (URLs, file paths, conventions).
//   project-lore — historical context that shouldn't be rewritten.
//   plan / investigation / jira_issue — owned by other lifecycles; the
//                                       layout already excludes their
//                                       categories from refine.
export const STALENESS_ELIGIBLE_ATOM_TYPES = new Set([
  "self-improvement-lesson",
  "bug-root-cause",
  "feedback-rule",
  "pattern-gotcha",
]);

// Atom_types whose lesson-key (project_module / area / task_type /
// error_pattern) is meaningful for cross-leaf dedup. self-improvement-lesson
// is the canonical case; other categories may carry the same fields, but
// dedup by this key only makes sense where it's idiomatic. Empty atom_type
// skips the pass.
export const LESSON_KEY_ELIGIBLE_ATOM_TYPES = new Set(["self-improvement-lesson"]);

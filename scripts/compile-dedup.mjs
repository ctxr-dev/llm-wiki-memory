import { compileSearchLimit } from "./lib/settings.mjs";
import { searchMemoryFiltered } from "./lib/wiki-store.mjs";
import { compileFilters, parserForAtom } from "./compile-routing.mjs";

/** @typedef {import("./lib/types.mjs").DistilledAtom} DistilledAtom */
/** @typedef {import("./lib/types.mjs").SearchHit} SearchHit */

/**
 * The action decision compile applies for one atom — produced either by the
 * deterministic `forcedLessonUpdate` short-circuit or by the LLM in
 * `decideAction`, then executed by `executeAction`.
 * @typedef {Object} CompileDecision
 * @property {"skip" | "create" | "update"} action
 * @property {string} [reason]
 * @property {string} [supersedes] - documentId the update replaces.
 * @property {string} [merged_text]
 * @property {string} [merged_name]
 */

// Compile knobs — sourced from settings.yaml via settings.mjs accessors.
// Wrapped as zero-arg getters so test-seam overrides take effect mid-process.
const SEARCH_LIMIT = () => compileSearchLimit();

/**
 * @param {DistilledAtom} atom
 * @param {string} targetDataset
 * @returns {Promise<SearchHit[]>}
 */
export async function dedupCandidates(atom, targetDataset) {
  const query = `${atom.title}${atom.tags.length ? " " + atom.tags.join(" ") : ""}`;
  const result = await searchMemoryFiltered(
    /** @type {{ query: string, datasetId: string, limit: number, filters: import("./lib/types.mjs").MetadataInput }} */ ({
      query,
      datasetId: targetDataset,
      limit: Math.max(SEARCH_LIMIT(), 5),
      filters: compileFilters(atom),
    }),
  );
  const records = Array.isArray(result?.records) ? result.records : [];
  const parser = parserForAtom(atom);
  const seen = new Set();
  /** @type {SearchHit[]} */
  const out = [];
  for (const rec of records) {
    if (!rec?.documentName || !parser(rec.documentName)) continue;
    if (seen.has(rec.documentId)) continue;
    seen.add(rec.documentId);
    out.push(rec);
    if (out.length >= SEARCH_LIMIT()) break;
  }
  return out;
}

/**
 * @param {DistilledAtom} atom
 * @param {string} [mergedTextOverride]
 * @returns {string}
 */
export function buildPromotedDocText(atom, mergedTextOverride) {
  const md = atom.metadata || {};
  // Collapse newlines in the column-0 fields (title, tags) so a stored value
  // can't inject a forged heading or list item into the promoted doc — the
  // same invariant validateAtoms enforces on the flush daily format.
  /** @param {unknown} v */
  const oneLine = (v) => String(v || "").replace(/[\r\n]+/g, " ");
  const lines = [
    `# ${oneLine(atom.title)}`,
    "",
    `- type: ${atom.type}`,
    `- tags: [${(atom.tags || []).map(oneLine).join(", ")}]`,
    `- area: ${md.area || md.project_module || ""}`,
    `- language: ${md.language || ""}`,
    `- task_type: ${md.task_type || ""}`,
    `- error_pattern: ${md.error_pattern || ""}`,
    `- updated_at_utc: ${new Date().toISOString()}`,
    "",
    mergedTextOverride && mergedTextOverride.trim() ? mergedTextOverride.trim() : atom.body,
  ];
  if (!mergedTextOverride && atom.evidence) {
    lines.push("", `evidence: ${atom.evidence}`);
  }
  return lines.join("\n").concat("\n");
}

// Deterministic short-circuit for self-improvement-lessons that share an
// error_pattern with an existing candidate. compileFilters already filters
// candidates by `error_pattern` server-side when the atom has one set, so
// any returned candidate is by definition a same-pattern match. Lessons
// must converge into ONE canonical doc per error pattern (this is the
// documented contract in prompts/flush.md + prompts/compile.md), so the
// only sane action is `update` against the top candidate. Skipping the
// LLM here keeps the rule from drifting on prompt edits and saves a
// round-trip per same-pattern lesson.
//
// IMPORTANT: this is a REPLACE, not a true merge. The prompt contract
// for `update` says "Preserves the WHY and HOW-TO-APPLY lines from BOTH
// atoms" - but that merge requires the LLM. Here we set
// `merged_text = atom.body` (the new atom only). The deliberate trade:
// (a) the new atom is the most recent ground truth on the failure
//     mode, per prompts/compile.md's "the new one wins" rule for
//     contradictions;
// (b) cost: we lose any evidence the OLD doc had that the new one
//     doesn't repeat. In practice the old doc is itself a prior
//     compile-merged lesson, so losing one round of merged context
//     is a one-time cost, not cumulative;
// (c) benefit: zero LLM tokens per same-pattern lesson, and no risk
//     of the LLM hallucinating a wrong documentId (the long-standing
//     LLMOutputInvalid failure mode in executeAction's update path).
// If you need a real merge here someday, swap `atom.body` for an
// LLM-merged string but keep the bypass when the LLM is unavailable.
/**
 * @param {DistilledAtom} atom
 * @param {SearchHit[]} candidates
 * @returns {CompileDecision | null}
 */
export function forcedLessonUpdate(atom, candidates) {
  if (!atom || typeof atom !== "object") return null;
  if (atom.type !== "self-improvement-lesson") return null;
  if (!atom.metadata?.error_pattern) return null;
  if (!candidates || candidates.length === 0) return null;
  const top = candidates[0];
  if (!top?.documentId) return null;
  return {
    action: "update",
    supersedes: top.documentId,
    merged_text: atom.body,
    merged_name: atom.title,
    reason: `forced update: same error_pattern='${atom.metadata.error_pattern}' as candidate ${top.documentId}`,
  };
}

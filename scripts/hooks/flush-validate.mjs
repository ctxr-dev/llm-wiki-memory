import { atomBodyMaxChars } from "../lib/settings.mjs";
import { truncateAtWordBoundary } from "../lib/slug.mjs";
import { ATOM_TYPES, TASK_TYPES } from "../lib/datasets.mjs";
import { LLMOutputInvalid } from "../lib/llm.mjs";
import { logBreadcrumb } from "./flush-state.mjs";

/** @typedef {import("../lib/types.mjs").DistilledAtom} DistilledAtom */

/**
 * @param {unknown} raw
 * @returns {{ area: string, language: string, task_type: string, error_pattern: string }}
 */
function normaliseMetadata(raw) {
  const md = /** @type {Record<string, unknown>} */ (raw && typeof raw === "object" ? raw : {});
  // Strip CR/LF before trim so a metadata value cannot break the line-based
  // parser in compile.mjs (every flush atom is rendered as a single
  // `- metadata: <json>` line).
  /** @param {unknown} v @returns {string} */
  const clean = (v) =>
    String(v || "")
      .replace(/[\r\n]+/g, " ")
      .trim();
  const taskType = clean(md.task_type).toLowerCase();
  return {
    // `area` is the sub-module (facet + fine scope). Accept it directly, or fall
    // back to a legacy `project_module` value. The workspace id is stamped at write.
    area: clean(md.area || md.project_module).toLowerCase(),
    language: clean(md.language).toLowerCase(),
    // Out-of-set task_type collapses to "unknown" so the lesson is still
    // filterable; previously it became "" which dropped the atom.
    task_type: TASK_TYPES.has(taskType) ? taskType : taskType ? "unknown" : "",
    error_pattern: clean(md.error_pattern).toLowerCase(),
  };
}

/**
 * @param {unknown} parsed
 * @returns {DistilledAtom[]}
 */
export function validateAtoms(parsed) {
  if (!parsed || !Array.isArray(/** @type {{ atoms?: unknown }} */ (parsed).atoms)) {
    throw new LLMOutputInvalid("LLM JSON missing 'atoms' array", JSON.stringify(parsed));
  }
  // Compute the body cap ONCE, not per atom. atomBodyMaxChars() reads the
  // mtime-cached settings() (one cheap stat per call), so hoisting it out of
  // the loop is cosmetic rather than a perf necessity — but it keeps the
  // value stable across the validation pass.
  const bodyMaxChars = atomBodyMaxChars();
  /** @type {DistilledAtom[]} */
  const cleaned = [];
  for (const atom of /** @type {Record<string, unknown>[]} */ (
    /** @type {{ atoms: unknown[] }} */ (parsed).atoms
  )) {
    if (!atom || typeof atom !== "object") continue;
    // Strip CR/LF from EVERY field that renders at column 0 on a single line
    // (title, type, tags). renderDailyDocument writes `### Atom · <type> ·
    // <title>` and `- tags: [...]` unindented, and compile.mjs splits the leaf
    // on a line starting `### Atom `. The atom fields are LLM output and a
    // prompt-injected transcript can steer the distiller to emit a title/tag
    // containing `\n### Atom ...`, which would inject a FORGED atom block that
    // compile promotes in place of the real memory (wrong type/dataset, real
    // atom dropped). normaliseMetadata already does this for metadata values;
    // body is 4-space-indented and evidence is JSON-stringified, so those are
    // already safe. Collapse newlines to a space here, same as metadata.
    /** @param {unknown} v @returns {string} */
    const oneLine = (v) => String(v || "").replace(/[\r\n]+/g, " ");
    const type = oneLine(atom.type).toLowerCase().trim();
    const title = oneLine(atom.title).trim();
    const body = String(atom.body || "").trim();
    if (!ATOM_TYPES.has(type) || !title || !body) continue;
    // `plan` is in ATOM_TYPES because the ExitPlanMode hook tags docs
    // with it, but the flush+compile path must NOT produce plans (they
    // are upsert-by-name into the `plans` slot, not dedup-merged
    // dailies). Drop any LLM hallucination silently.
    if (type === "plan") {
      logBreadcrumb(`dropped plan-typed atom '${title.slice(0, 40)}' (plans are hook-only)`);
      continue;
    }
    const tags = Array.isArray(atom.tags)
      ? /** @type {unknown[]} */ (atom.tags)
          .map((t) => oneLine(t).toLowerCase().trim())
          .filter(Boolean)
      : [];
    if (tags.length === 0) continue;
    const metadata = normaliseMetadata(atom.metadata);
    if (type === "self-improvement-lesson") {
      // Lessons MUST have area, task_type, and error_pattern so recall_lessons
      // can filter them precisely. Drop malformed lessons rather than flooding
      // the store with un-filterable noise.
      if (!metadata.area || !metadata.task_type || !metadata.error_pattern) {
        logBreadcrumb(
          `dropped self-improvement-lesson '${title.slice(0, 40)}' (missing required metadata)`,
        );
        continue;
      }
    }
    cleaned.push({
      type,
      title: truncateAtWordBoundary(title, 80),
      body: truncateAtWordBoundary(body, bodyMaxChars, { preferSentence: true }),
      tags,
      metadata,
      evidence: atom.evidence ? String(atom.evidence).slice(0, 240).trim() : undefined,
    });
  }
  return cleaned;
}

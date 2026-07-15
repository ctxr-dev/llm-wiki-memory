// plan-frontmatter — updates a plan file's OWN frontmatter (status,
// progress, last_updated) from its checkbox state. Pure transforms sit
// alongside the I/O wrappers so tests can run without touching disk, and
// this module never touches the auto-generated index.md (the skill owns that).

import fs from "node:fs";
import matter from "gray-matter";
import { writeFileAtomic } from "./atomic-write.mjs";
import { parseChecklist, inferLifecycle, checklistProgress } from "./tracker-parse.mjs";

/** @typedef {import("./tracker-parse.mjs").ChecklistItem} ChecklistItem */
/** @typedef {import("./tracker-parse.mjs").ChecklistFlip} ChecklistFlip */

// Given the current frontmatter `data` and the latest checklist analysis,
// return the new frontmatter object. We MUTATE through `data` (gray-matter
// gives us a fresh object per parse) so unrelated keys are preserved.
//
// Fields managed by this module:
//   - status              one of pending / in-progress / done (never archived)
//   - progress.total      checkbox count
//   - progress.done       checked count
//   - progress.label      "done/total"
//   - last_updated        ISO date (no time) — caller can override via `now`
//
// `archived: true` in the existing frontmatter is preserved and SUPPRESSES
// the status flip — archived plans never auto-move back to in-progress.
/**
 * @param {{ data?: Record<string, unknown> | null, checklist: ChecklistItem[] | string, now?: Date }} args
 * @returns {Record<string, unknown>}
 */
export function buildUpdatedFrontmatter({ data, checklist, now }) {
  /** @type {Record<string, unknown>} */
  const out = { ...(data || {}) };
  const isArchived = out.archived === true;
  const progress = checklistProgress(checklist);
  const inferred = inferLifecycle(checklist);

  // Status — only auto-flip if not explicitly archived.
  if (!isArchived) out.status = inferred;

  // Progress block.
  out.progress = {
    total: progress.total,
    done: progress.done,
    label: progress.label,
  };

  // Last-updated date.
  out.last_updated = (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);

  // flip_log is read by nothing (checkbox provenance lives in the plan body's
  // dated change-log). Drop it, and strip it from any legacy leaf on re-save.
  delete out.flip_log;

  return out;
}

// Parse a plan's frontmatter + body, recompute the frontmatter, and return
// the rewritten text. `flips` is only counted (summary.flips_detected); it no
// longer changes what is written.
/**
 * @param {string} planText
 * @param {{ flips?: ChecklistFlip[], now?: Date }} [opts]
 * @returns {{ text: string, changed: boolean, summary: { status: unknown, progress: unknown, flips_detected: number } }}
 */
export function applyFrontmatterUpdate(planText, { flips, now } = {}) {
  const parsed = matter(planText);
  const checklist = parseChecklist(parsed.content);
  const newData = buildUpdatedFrontmatter({ data: parsed.data, checklist, now });
  // lineWidth:-1 disables js-yaml's 80-col scalar folding. wiki-store leaves
  // carry long `covers`/`focus` scalars; folding them into block scalars (`>-`)
  // breaks skill-llm-wiki's line-by-line frontmatter index parser. Match the
  // wiki-store stringifyLeaf convention so the two compose on a shared leaf.
  const newText = matter.stringify(
    parsed.content,
    newData,
    /** @type {Parameters<typeof matter.stringify>[2]} */ (
      /** @type {unknown} */ ({ lineWidth: -1 })
    ),
  );
  const changed = newText !== planText;
  return {
    text: newText,
    changed,
    summary: {
      status: newData.status,
      progress: newData.progress,
      flips_detected: Array.isArray(flips) ? flips.length : 0,
    },
  };
}

// Read the plan file at `filePath`, rewrite its frontmatter in place. The
// body of the plan (checkboxes, prose, ## Reasons section) is untouched.
//
// Returns the same `summary` object as `applyFrontmatterUpdate`, plus the
// `filePath` for convenience. Throws if the file isn't readable.
/**
 * @param {string} filePath
 * @param {{ flips?: ChecklistFlip[], now?: Date }} [opts]
 * @returns {{ filePath: string, changed: boolean, status: unknown, progress: unknown, flips_detected: number }}
 */
export function updatePlanFrontmatter(filePath, opts = {}) {
  const raw = fs.readFileSync(filePath, "utf8");
  const result = applyFrontmatterUpdate(raw, opts);
  if (result.changed) {
    writeFileAtomic(filePath, result.text);
  }
  return { filePath, ...result.summary, changed: result.changed };
}

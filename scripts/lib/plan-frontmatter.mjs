// plan-frontmatter — updates a plan file's OWN frontmatter (status,
// progress, last_updated, flip history) based on its checkbox state.
//
// This module does NOT touch any auto-generated index.md — that's the
// skill's job. Our hook only updates the plan markdown file itself.
//
// Public API:
//   updatePlanFrontmatter(filePath, opts) -> { changed, newStatus, progress, ... }
//   applyChecklistFlipsToFrontmatter(planText, flips, now) -> newPlanText
//
// Pure (no side effects) variants are provided alongside the I/O wrappers
// so tests can exercise the transformations without touching disk.

import fs from "node:fs";
import matter from "gray-matter";
import { writeFileAtomic } from "./atomic-write.mjs";
import {
  parseChecklist,
  inferLifecycle,
  checklistProgress,
} from "./tracker-parse.mjs";

// ---------------------------------------------------------------------------
// Pure transformations
// ---------------------------------------------------------------------------

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
//   - flip_log[]          append-only list of { num, from, to, at } entries
//                         (cap at FLIP_LOG_MAX so a long-lived plan doesn't
//                         grow unbounded)
//
// `archived: true` in the existing frontmatter is preserved and SUPPRESSES
// the status flip — archived plans never auto-move back to in-progress.
const FLIP_LOG_MAX = 200;

export function buildUpdatedFrontmatter({ data, checklist, flips, now }) {
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

  // Append flip entries. Each is { num, from, to, at } where `at` is the
  // same ISO date as last_updated.
  if (Array.isArray(flips) && flips.length > 0) {
    const existing = Array.isArray(out.flip_log) ? out.flip_log : [];
    const newEntries = flips.map((f) => ({
      num: f.id,
      from: f.from ? "x" : " ",
      to: f.to ? "x" : " ",
      at: out.last_updated,
    }));
    const combined = [...existing, ...newEntries];
    out.flip_log =
      combined.length > FLIP_LOG_MAX ? combined.slice(-FLIP_LOG_MAX) : combined;
  }

  return out;
}

// Given a plan file's text content, parse its frontmatter + body, compute
// the new frontmatter, and return the rewritten plan text. `flips` is
// optional — when omitted no flip_log entries are added (use this for
// "first scan" / passive updates).
//
// Returns:
//   { text: <new plan markdown>, changed: <bool>, summary: { ... } }
export function applyFrontmatterUpdate(planText, { flips, now } = {}) {
  const parsed = matter(planText);
  const checklist = parseChecklist(parsed.content);
  const newData = buildUpdatedFrontmatter({
    data: parsed.data,
    checklist,
    flips,
    now,
  });
  // lineWidth:-1 disables js-yaml's 80-col scalar folding. wiki-store leaves
  // carry long `covers`/`focus` scalars; folding them into block scalars (`>-`)
  // breaks skill-llm-wiki's line-by-line frontmatter index parser. Match the
  // wiki-store stringifyLeaf convention so the two compose on a shared leaf.
  const newText = matter.stringify(parsed.content, newData, { lineWidth: -1 });
  const changed = newText !== planText;
  return {
    text: newText,
    changed,
    summary: {
      status: newData.status,
      progress: newData.progress,
      flips_appended: Array.isArray(flips) ? flips.length : 0,
      total_flip_log: Array.isArray(newData.flip_log) ? newData.flip_log.length : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// I/O wrappers
// ---------------------------------------------------------------------------

// Read the plan file at `filePath`, rewrite its frontmatter in place. The
// body of the plan (checkboxes, prose, ## Reasons section) is untouched.
//
// Returns the same `summary` object as `applyFrontmatterUpdate`, plus the
// `filePath` for convenience. Throws if the file isn't readable.
export function updatePlanFrontmatter(filePath, opts = {}) {
  const raw = fs.readFileSync(filePath, "utf8");
  const result = applyFrontmatterUpdate(raw, opts);
  if (result.changed) {
    writeFileAtomic(filePath, result.text);
  }
  return { filePath, ...result.summary, changed: result.changed };
}

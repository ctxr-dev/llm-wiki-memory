import fs from "node:fs";
import path from "node:path";
import { slugify } from "./slug.mjs";
import { collectFiles } from "./glob-match.mjs";
import { absorbDocument } from "./absorb.mjs";

// Batch absorb over files / directories / globs. Split from absorb.mjs to keep
// each module small. Files are processed SEQUENTIALLY (the codebase norm — no
// LLM concurrency helper exists) and continue-on-error (one bad file never
// aborts the batch). The leaf name is derived from the source path relative to
// its absorb root, so same-basename files in different subdirs stay distinct
// and re-absorbing the same root is idempotent.

/**
 * @param {string} file @param {string} root @returns {string}
 */
export function leafNameFor(file, root) {
  const rel = path.relative(root, file).replace(/\.[a-z0-9]+$/i, "");
  const slug = rel
    .split(/[\\/]+/)
    .map((s) => slugify(s))
    .filter(Boolean)
    .join("-");
  return `${slug || slugify(path.basename(file)) || "doc"}.md`;
}

// slugify collapses BOTH `/` and `-` to a single `-`, so distinct source paths
// can slug to the SAME leaf name (`a/b.md` and `a-b.md` both → `a-b.md`). Without
// this guard the second file would silently overwrite the first (data loss).
// Disambiguate collisions from a DIFFERENT source with a numeric suffix; the
// input order is stable (collectFiles sorts by path), so the suffix is
// deterministic across re-runs (idempotent).
/** @param {string} base @param {string} file @param {Map<string, string>} used @returns {string} */
function uniqueLeafName(base, file, used) {
  if (used.get(base) === file || !used.has(base)) {
    used.set(base, file);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 2; ; n += 1) {
    const cand = `${stem}-${n}${ext}`;
    if (used.get(cand) === file || !used.has(cand)) {
      used.set(cand, file);
      return cand;
    }
  }
}

/** @typedef {{ file: string, id?: string, category: string, dir: string, name: string, metadata: Record<string, unknown> }} AbsorbedEntry */

/**
 * @param {{ paths: string[], match?: string[], category: string, overrides?: Record<string, unknown>, dryRun?: boolean }} args
 * @returns {Promise<{ absorbed: AbsorbedEntry[], failed: { file: string, error: string }[], matched: number }>}
 */
export async function absorbPaths({ paths, match, category, overrides = {}, dryRun = false }) {
  const files = collectFiles(paths || [], match && match.length ? match : undefined);
  /** @type {AbsorbedEntry[]} */
  const absorbed = [];
  /** @type {{ file: string, error: string }[]} */
  const failed = [];
  /** @type {Map<string, string>} */
  const usedNames = new Map();
  for (const { file, root } of files) {
    try {
      const text = fs.readFileSync(file, "utf8");
      const name = uniqueLeafName(leafNameFor(file, root), file, usedNames);
      const r = await absorbDocument({ text, name, category, overrides, dryRun });
      absorbed.push({ file, ...r });
    } catch (err) {
      failed.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { absorbed, failed, matched: files.length };
}

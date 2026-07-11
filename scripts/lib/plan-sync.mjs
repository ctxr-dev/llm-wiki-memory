// plan-sync — orchestrates plan-file lifecycle:
//   1. Rewrite the plan's frontmatter (status, progress, last_updated)
//      via plan-frontmatter.mjs.
//   2. If the file lives in a lifecycle-aware topology AND the lifecycle
//      changed, move the file to the matching `<lifecycle>/` folder.
//   3. Handle collisions by auto-suffixing `-v2.plan.md`, `-v3`, etc.
//   4. Re-index the source + destination dirs via skill ensureIndexes.
//
// Library-level (pure-ish — does fs I/O but no process spawning beyond
// the skill index rebuild). The actual hook entry script (Claude Code,
// other agents) wraps this with stdin parsing + logging.

import fs from "node:fs";
import path from "node:path";
import { applyFrontmatterUpdate } from "./plan-frontmatter.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { loadTopology, pathFor, parsePath } from "./topology-runtime.mjs";
import { ensureIndexes, indexRebuildOne } from "./wiki-cli.mjs";
// Shared with wiki-store's relocation paths; single source of truth in fs-prune.
import { pruneEmptyAncestors } from "./fs-prune.mjs";
import { recordWikiChange, withWikiCommit } from "./wiki-commit.mjs";
export { pruneEmptyAncestors } from "./fs-prune.mjs";

/**
 * @typedef {Object} PlanSyncResult
 * @property {string} file
 * @property {boolean} frontmatter_changed
 * @property {string | null} status
 * @property {string | null} progress
 * @property {{ from: string, to: string, suffix: string | null } | null} moved
 * @property {string | null} error
 */

/**
 * @typedef {Object} PlanSyncOpts
 * @property {string} [wikiRoot]
 * @property {Date} [now]
 */

// Pick a non-colliding destination by appending -v2 / -v3 / … before the
// .plan.md extension. Hard-fails after 99 attempts (effectively never).
/**
 * @param {string} targetAbs
 * @returns {{ path: string, suffix: string | null }}
 */
export function pickNonColliding(targetAbs) {
  if (!fs.existsSync(targetAbs)) return { path: targetAbs, suffix: null };
  const ext = ".plan.md";
  const base = path.basename(targetAbs, ext);
  if (!targetAbs.endsWith(ext)) {
    // Not a .plan.md path — be conservative and add -conflict to whatever
    // stem we can find.
    const altExt = path.extname(targetAbs);
    const altBase = path.basename(targetAbs, altExt);
    const dir = path.dirname(targetAbs);
    let v = 2;
    while (v < 100) {
      const cand = path.join(dir, `${altBase}-v${v}${altExt}`);
      if (!fs.existsSync(cand)) return { path: cand, suffix: `-v${v}` };
      v++;
    }
  }
  const dir = path.dirname(targetAbs);
  let v = 2;
  while (v < 100) {
    const cand = path.join(dir, `${base}-v${v}${ext}`);
    if (!fs.existsSync(cand)) return { path: cand, suffix: `-v${v}` };
    v++;
  }
  throw new Error(`pickNonColliding: 100 suffixes exhausted at ${targetAbs}`);
}

// Per-call result object the hook entry-script logs. Always returned
// (never throws beyond pickNonColliding's hard-fail or fs errors on
// write); errors are captured in result.error.
/**
 * @param {string} absPath
 * @param {PlanSyncOpts} [opts]
 * @returns {Promise<PlanSyncResult>}
 */
export async function syncPlanFile(absPath, opts = {}) {
  // One synced plan = one commit when called stand-alone (the PostToolUse
  // hook); inside syncAllPlans the nested frame joins the sweep's batch.
  return /** @type {Promise<PlanSyncResult>} */ (
    withWikiCommit({ op: "plan-sync", actor: "plan-sync", rootDir: opts.wikiRoot || "" }, () =>
      syncPlanFileInner(absPath, opts),
    )
  );
}

/**
 * @param {string} absPath
 * @param {PlanSyncOpts} [opts]
 * @returns {Promise<PlanSyncResult>}
 */
async function syncPlanFileInner(absPath, { wikiRoot, now } = {}) {
  /** @type {PlanSyncResult} */
  const out = {
    file: absPath,
    frontmatter_changed: false,
    status: null,
    progress: null,
    moved: null, // { from, to, suffix? } when a move happened
    error: null,
  };

  if (!fs.existsSync(absPath)) {
    out.error = "file does not exist";
    return out;
  }
  if (!absPath.endsWith(".plan.md")) {
    out.error = "not a .plan.md file";
    return out;
  }

  // 1. Rewrite frontmatter.
  let raw;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (err) {
    out.error = `read failed: ${/** @type {Error} */ (err).message}`;
    return out;
  }
  let update;
  try {
    update = applyFrontmatterUpdate(raw, { now });
  } catch (err) {
    out.error = `frontmatter update failed: ${/** @type {Error} */ (err).message}`;
    return out;
  }
  out.status = /** @type {string | null} */ (update.summary.status);
  out.progress = /** @type {string | null} */ (update.summary.progress);
  if (update.changed) {
    writeFileAtomic(absPath, update.text);
    out.frontmatter_changed = true;
    recordWikiChange({
      action: "metadata",
      leafRelPath: absPath,
      reason: `plan frontmatter sync (status: ${out.status || "?"}, progress: ${out.progress || "?"})`,
    });
  }

  // 2. Decide whether the file is under a lifecycle-aware topology.
  if (!wikiRoot) return out;
  let topo;
  try {
    topo = await loadTopology(wikiRoot, { categoryPath: "issues" });
  } catch {
    // No topology block — that's fine, just no move logic. Frontmatter
    // already updated.
    return out;
  }
  const rel = path.relative(wikiRoot, absPath);
  const parsed = parsePath(topo, rel);
  if (!parsed || !parsed.facets || parsed.facets.lifecycle === undefined) {
    return out; // not a lifecycle-aware path
  }

  const newLifecycle = out.status;
  if (!newLifecycle || newLifecycle === parsed.facets.lifecycle) return out;
  if (newLifecycle === "archived") return out; // archived is manual-only

  // 3. Compute new path; pick a non-colliding destination.
  const newFacets = { ...parsed.facets, lifecycle: newLifecycle };
  let newRel;
  try {
    newRel = pathFor(topo, parsed.kind, newFacets);
  } catch (err) {
    out.error = `pathFor failed (kind=${parsed.kind}, lifecycle=${newLifecycle}): ${/** @type {Error} */ (err).message}`;
    return out;
  }
  const newAbs = path.join(wikiRoot, newRel);
  const picked = pickNonColliding(newAbs);

  // 4. Move on disk. ensureIndexes is called on BOTH source dir (now
  // empty of this leaf) and destination dir (so the skill re-renders
  // both indexes).
  try {
    fs.mkdirSync(path.dirname(picked.path), { recursive: true });
    fs.renameSync(absPath, picked.path);
  } catch (err) {
    out.error = `move failed: ${/** @type {Error} */ (err).message}`;
    return out;
  }
  out.moved = { from: absPath, to: picked.path, suffix: picked.suffix };
  recordWikiChange({
    action: "relocated",
    leafRelPath: picked.path,
    reason: `plan lifecycle move (${parsed.facets.lifecycle} -> ${newLifecycle})`,
    extraPaths: [absPath],
  });

  try {
    ensureIndexes(wikiRoot, [absPath, picked.path]);
  } catch (err) {
    // Move succeeded; index-rebuild failure is non-fatal but logged.
    out.error = `move ok, but ensureIndexes failed: ${/** @type {Error} */ (err).message}`;
  }

  // Empty-dir cleanup: walk up from the OLD location and remove any
  // ancestor directory that now contains nothing but an orphaned
  // index.md. Bounded above by `wikiRoot` so we never reach into the
  // wiki's parent. Defensive — never deletes if anything unexpected is
  // present (only the auto-generated index.md is acceptable to remove).
  const { survivor } = pruneEmptyAncestors(path.dirname(absPath), wikiRoot);
  if (survivor) {
    try {
      indexRebuildOne(survivor, wikiRoot);
      // Record explicitly so the rebuilt index is staged even when syncOnePlan
      // runs standalone (the relocate record above flushes before this rebuild).
      recordWikiChange({
        action: "reindexed",
        leafRelPath: path.join(survivor, "index.md"),
        reason: "plan-move survivor reindex",
      });
    } catch (err) {
      out.error = `${out.error ? `${out.error}; ` : ""}survivor reindex failed: ${/** @type {Error} */ (err).message}`;
    }
  }

  return out;
}

// Bulk variant — used by SessionEnd to sweep every .plan.md under the
// wiki. Returns an array of per-file result objects.
/**
 * @param {string} wikiRoot
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<PlanSyncResult[]>}
 */
export async function syncAllPlans(wikiRoot, { now } = {}) {
  // The SessionEnd sweep = one commit covering every plan it touched.
  return /** @type {Promise<PlanSyncResult[]>} */ (
    withWikiCommit({ op: "plan-sync", actor: "plan-sync-sweep", rootDir: wikiRoot || "" }, () =>
      syncAllPlansInner(wikiRoot, { now }),
    )
  );
}

/**
 * @param {string} wikiRoot
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<PlanSyncResult[]>}
 */
async function syncAllPlansInner(wikiRoot, { now } = {}) {
  /** @type {string[]} */
  const results = [];
  if (!fs.existsSync(wikiRoot))
    return /** @type {PlanSyncResult[]} */ (/** @type {unknown} */ (results));
  /** @param {string} dir */
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".plan.md")) {
        // Defer execution: collect paths first, then process so we don't
        // race against renames while walking.
        results.push(p);
      }
    }
  }
  walk(wikiRoot);

  /** @type {PlanSyncResult[]} */
  const out = [];
  for (const p of results) {
    // syncPlanFile may have moved the file; if it no longer exists at the
    // collected path, it was processed in an earlier iteration — skip.
    if (!fs.existsSync(p)) continue;
    out.push(await syncPlanFile(p, { wikiRoot, now }));
  }
  return out;
}

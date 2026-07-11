// Structural corpus passes: prune empty ancestor directories, sweep the
// embedding cache (throttled), and rebuild category-root indexes. These run
// last — they're idempotent, cheap, and never touch leaf CONTENT, only the
// on-disk tree structure and indexes.

import fs from "node:fs";
import path from "node:path";
import { wikiRoot } from "./lib/env.mjs";
import { pruneEmptyAncestors } from "./lib/fs-prune.mjs";
import { ensureIndexes, indexRebuildOne } from "./lib/wiki-cli.mjs";
import { recordWikiChange } from "./lib/wiki-commit.mjs";
import { pruneEmbeddingCache } from "./lib/wiki-store.mjs";
import { getCategoryListSafe } from "./consolidate-corpus-passes.mjs";

/** @typedef {import("./consolidate-report.mjs").ConsolidateCtx} ConsolidateCtx */
/** @typedef {import("./consolidate-report.mjs").PassReport} PassReport */

/**
 * @param {string} dir
 * @param {(dir: string) => void} cb
 */
export function walkDirsDepthFirst(dir, cb) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    walkDirsDepthFirst(path.join(dir, e.name), cb);
  }
  cb(dir);
}

// 2H — structural cleanup. Idempotent; cheap. Always runs last.
/**
 * @param {Object} args
 * @param {ConsolidateCtx} args.ctx
 * @param {boolean} [args.dryRun]
 */
export function pruneEmptyAncestorsCorpus({ ctx, dryRun }) {
  const t0 = Date.now();
  const report = /** @type {PassReport} */ (ctx.report.get("prune-empty-ancestors"));
  if (dryRun) {
    report.ms += Date.now() - t0;
    return;
  }
  const root = wikiRoot();
  /** @type {Set<string>} */
  const survivors = new Set();
  for (const cat of getCategoryListSafe()) {
    const catDir = path.join(root, cat);
    if (!fs.existsSync(catDir)) continue;
    walkDirsDepthFirst(catDir, (dir) => {
      try {
        const { survivor } = pruneEmptyAncestors(dir, root);
        if (survivor) survivors.add(survivor);
      } catch {
        /* best-effort */
      }
    });
  }
  // Rebuild each surviving ancestor so its index.md drops the now-pruned child,
  // and record it so the wiki-commit frame stages the regenerated index. The
  // indexRebuildCorpus closer only refreshes category roots, not a deep survivor.
  for (const survivor of survivors) {
    if (!fs.existsSync(survivor)) continue; // a later prune removed it too
    try {
      indexRebuildOne(survivor, root);
      const rel = path.relative(root, path.join(survivor, "index.md")).split(path.sep).join("/");
      recordWikiChange(
        /** @type {{ action: string, leafRelPath: string, reason: string }} */ ({
          action: "reindexed",
          leafRelPath: rel,
          reason: "prune survivor reindex",
        }),
      );
      report.touched = (report.touched || 0) + 1;
    } catch {
      /* best-effort */
    }
  }
  report.ms += Date.now() - t0;
}

/**
 * @param {Object} args
 * @param {ConsolidateCtx} args.ctx
 * @param {boolean} [args.dryRun]
 */
export function pruneEmbeddingsCorpus({ ctx, dryRun }) {
  const t0 = Date.now();
  const report = /** @type {PassReport} */ (ctx.report.get("prune-embeddings"));
  try {
    // Respect MEMORY_GC_INTERVAL_DAYS (default 7d) — without `ifDue:true`
    // the daily consolidate cron would silently override the documented
    // weekly cadence for the embed-cache sweep. The SessionEnd embed-gc
    // hook and the hook-less skill rule already use ifDue:true; consolidate
    // is just one more caller and should align.
    const r = pruneEmbeddingCache({ ifDue: true, dryRun: Boolean(dryRun) });
    report.touched += Number(r?.removed) || 0;
  } catch (err) {
    const e = /** @type {Error} */ (err);
    report.errors++;
    process.stderr.write(`[consolidate] gc-embeddings failed: ${e?.message || e}\n`);
  }
  report.ms += Date.now() - t0;
}

/**
 * @param {Object} args
 * @param {ConsolidateCtx} args.ctx
 * @param {boolean} [args.dryRun]
 */
export function indexRebuildCorpus({ ctx, dryRun }) {
  const t0 = Date.now();
  const report = /** @type {PassReport} */ (ctx.report.get("index-rebuild"));
  if (dryRun) {
    report.ms += Date.now() - t0;
    return;
  }
  // ensureIndexes expects LEAF paths and walks the ancestors up to wikiRoot
  // to refresh each ancestor's index.md. Passing the wiki root itself is a
  // no-op (no leaf), so we feed a single synthetic per category to refresh
  // category-root indexes. Per-leaf indexes were already refreshed by the
  // mutating passes that touched them; this is the corpus-wide closer.
  try {
    const root = wikiRoot();
    /** @type {string[]} */
    const synthetic = [];
    for (const cat of getCategoryListSafe()) {
      synthetic.push(path.join(root, cat, "__consolidate_synthetic__.md"));
    }
    if (synthetic.length) {
      ensureIndexes(root, synthetic);
      report.touched++;
    }
  } catch (err) {
    const e = /** @type {Error} */ (err);
    report.errors++;
    process.stderr.write(`[consolidate] index-rebuild best-effort failed: ${e?.message || e}\n`);
  }
  report.ms += Date.now() - t0;
}

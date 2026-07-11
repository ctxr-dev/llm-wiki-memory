// The Phase-2/3 run loop: search-driven per-leaf cluster passes, per-leaf
// finalize, then the once-per-run corpus and structural passes. Split out of
// consolidate.mjs so the orchestrator entry point (lock / throttle / commit /
// maintenance-frame plumbing) stays readable; `consolidateMemory` calls this
// inside the wiki-commit + system-maintenance frame.

import { consolidateClusterTopK, consolidateClusterScoreThreshold } from "./lib/settings.mjs";
import {
  listActiveLeavesForConsolidate,
  readLeafForConsolidate,
  searchMemoryFiltered,
} from "./lib/wiki-store.mjs";
import { passEnabled } from "./consolidate-report.mjs";
import {
  dedupeBySha256,
  dedupeByLessonKey,
  dedupeByCosine,
  finalizeMergeCandidates,
} from "./consolidate-dedup-passes.mjs";
import { llmMergeNearDuplicates } from "./consolidate-llm-merge.mjs";
import { llmSemanticRefresh } from "./consolidate-llm-refresh.mjs";
import {
  stalenessFlag,
  pruneOrphanLeaves,
  compressArchived,
} from "./consolidate-corpus-passes.mjs";
import {
  pruneEmptyAncestorsCorpus,
  pruneEmbeddingsCorpus,
  indexRebuildCorpus,
} from "./consolidate-structural-passes.mjs";

/** @typedef {import("./consolidate-report.mjs").RunLeaf} RunLeaf */
/** @typedef {import("./consolidate-report.mjs").ConsolidateCtx} ConsolidateCtx */
/** @typedef {import("./consolidate-report.mjs").MergeCandidate} MergeCandidate */
/** @typedef {import("./consolidate-report.mjs").PassReport} PassReport */
/** @typedef {import("./consolidate-report.mjs").ConsolidateTotals} ConsolidateTotals */
/** @typedef {import("./consolidate-time.mjs").NowInput} NowInput */

/**
 * The cluster-lookup options accepted by `searchMemoryFiltered`.
 * @typedef {Object} SearchOptions
 * @property {string} [query]
 * @property {string} [datasetId]
 * @property {number} [limit]
 * @property {number} [scoreThreshold]
 */

/**
 * @param {Object} args
 * @param {Set<string>} args.allowed
 * @param {boolean} [args.dryRun]
 * @param {NowInput} [args.now]
 * @param {ConsolidateCtx} args.ctx
 * @returns {Promise<{ passes: Record<string, PassReport>, totals: ConsolidateTotals, workingSetSize: number }>}
 */
export async function runConsolidate({ allowed, dryRun, now, ctx }) {
  // Phase 2: search-driven cluster passes, per-leaf finalize, then corpus passes.

  // Empty allow-list: return immediately with zero totals. Without this short-
  // circuit the per-leaf loop would still walk the working set + run a
  // searchMemoryFiltered cluster lookup per leaf only to find every pass
  // gated-off — wasted compute (and embedding-cache reads) for no effect.
  if (allowed.size === 0) {
    const totals = {
      archived: 0,
      touched: 0,
      merged: 0,
      refreshed: 0,
      flagged: 0,
      errors: 0,
      freedBytes: 0,
    };
    return {
      passes: Object.fromEntries(ctx.report),
      totals,
      workingSetSize: 0,
    };
  }

  // Working set: every active leaf in the layout-declared `consolidate: refine`
  // categories. Stable documentId-ascending order for determinism.
  const refineCategories = ctx.refineCategories || [];
  /** @type {RunLeaf[]} */
  const workingSet = [];
  for (const cat of refineCategories) {
    const leaves = listActiveLeavesForConsolidate({ category: cat });
    for (const l of leaves) workingSet.push(/** @type {RunLeaf} */ ({ ...l, category: cat }));
  }
  workingSet.sort((a, b) => (a.documentId < b.documentId ? -1 : 1));

  for (const leaf of workingSet) {
    if (ctx.touchedThisRun.has(leaf.documentId)) continue; // already archived this run
    // Cluster: every similar leaf in the SAME category above the cluster score
    // threshold. The threshold is coarser than the dedupe threshold on purpose
    // so the LLM-refresh prompt (Phase 3B) sees enough surrounding context.
    let cluster;
    try {
      cluster = await searchMemoryFiltered(
        /** @type {SearchOptions} */ ({
          query: String(leaf.text).slice(0, 1024),
          datasetId: leaf.category,
          limit: consolidateClusterTopK(),
          scoreThreshold: consolidateClusterScoreThreshold(),
        }),
      );
    } catch (err) {
      const e = /** @type {Error} */ (err);
      /** @type {PassReport} */ (ctx.report.get("dedupe-by-cosine")).errors++;
      process.stderr.write(
        `[consolidate] cluster search failed for ${leaf.documentId}: ${e?.message || e}\n`,
      );
      continue;
    }

    // For passes that need full leaves (sha256, lesson-key), materialise the
    // cluster's members once. The cosine pass works off `cluster.records`
    // directly because the score IS the cosine.
    /** @type {RunLeaf[]} */
    const clusterLeaves = [];
    for (const r of cluster.records) {
      if (r.documentId === leaf.documentId) continue;
      const cl = /** @type {RunLeaf | null} */ (
        readLeafForConsolidate({ documentId: r.documentId })
      );
      if (!cl) continue;
      cl.category = leaf.category;
      clusterLeaves.push(cl);
    }

    /** @type {MergeCandidate[]} */
    const localCandidates = [];
    const subCtx = { ...ctx, mergeCandidates: localCandidates };

    if (passEnabled("dedupe-by-sha256", allowed)) {
      dedupeBySha256({ leaf, clusterLeaves, ctx: subCtx, now });
    }
    if (passEnabled("dedupe-by-lesson-key", allowed)) {
      dedupeByLessonKey({ leaf, clusterLeaves, ctx: subCtx, now });
    }
    if (passEnabled("dedupe-by-cosine", allowed)) {
      dedupeByCosine({ leaf, cluster, ctx: subCtx, now });
    }

    // 3A — LLM merge runs BEFORE the deterministic finalize so it can
    // rewrite the keeper body. When the LLM provider is unavailable, ctx
    // .llmEnabled is false and this pass no-ops; finalize archives losers
    // unchanged. The candidates list carries each LLM decision so finalize
    // can honour "skip" (leave both active).
    if (
      ctx.llmEnabled &&
      passEnabled("llm-merge-near-duplicates", allowed) &&
      localCandidates.length > 0
    ) {
      await llmMergeNearDuplicates({ candidates: localCandidates, ctx, now, dryRun });
    }

    finalizeMergeCandidates({ candidates: localCandidates, ctx, now, dryRun });
  }

  // Corpus passes (run once, after the per-leaf loop). 3B llm-semantic-refresh
  // sits between the deterministic stalenessFlag (which marks candidates) and
  // the corpus cleanup that follows, so the refresh decision is the FIRST
  // thing acting on a freshly-flagged leaf.
  if (passEnabled("staleness-flag", allowed)) stalenessFlag({ ctx, now, dryRun });
  if (ctx.llmEnabled && passEnabled("llm-semantic-refresh", allowed)) {
    await llmSemanticRefresh({ ctx, now, dryRun });
  }
  if (passEnabled("prune-orphan-leaves", allowed)) pruneOrphanLeaves({ ctx, now, dryRun });
  if (passEnabled("compress-archived", allowed)) compressArchived({ ctx, now, dryRun });
  if (passEnabled("prune-empty-ancestors", allowed)) pruneEmptyAncestorsCorpus({ ctx, dryRun });
  if (passEnabled("prune-embeddings", allowed)) pruneEmbeddingsCorpus({ ctx, dryRun });
  if (passEnabled("index-rebuild", allowed)) indexRebuildCorpus({ ctx, dryRun });

  // Totals summary.
  const totals = {
    archived: 0,
    touched: 0,
    merged: 0,
    refreshed: 0,
    flagged: 0,
    errors: 0,
    freedBytes: 0,
  };
  for (const r of ctx.report.values()) {
    totals.archived += r.archived;
    totals.touched += r.touched;
    totals.merged += r.merged;
    totals.refreshed += r.refreshed;
    totals.flagged += r.flagged;
    totals.errors += r.errors;
    totals.freedBytes += r.freedBytes;
  }
  return {
    passes: Object.fromEntries(ctx.report),
    totals,
    workingSetSize: workingSet.length,
  };
}

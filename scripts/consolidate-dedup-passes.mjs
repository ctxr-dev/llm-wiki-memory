// ─── cluster passes ────────────────────────────────────────────────────────
//
// Deterministic dedup: each cluster pass marks (keeper, loser) tuples in the
// per-leaf mergeCandidates list; the per-leaf `finalizeMergeCandidates` step
// archives the losers (after the optional LLM merge pass has had a chance to
// rewrite the keeper body).

import { contentHash } from "./lib/embed.mjs";
import { readLeafForConsolidate, disableDocument } from "./lib/wiki-store.mjs";
import { priorityRank, normalisePriority } from "./lib/datasets.mjs";
import { toIso } from "./consolidate-time.mjs";
import { entityPairId, recordEntity, stampLeafMetadata } from "./consolidate-report.mjs";
import { LESSON_KEY_ELIGIBLE_ATOM_TYPES } from "./consolidate-constants.mjs";
import { pickKeeper, loserKey, lessonKey } from "./consolidate-dedup-keys.mjs";

export { pickKeeper, loserKey, lessonKey };

/** @typedef {import("./consolidate-report.mjs").RunLeaf} RunLeaf */
/** @typedef {import("./consolidate-report.mjs").ConsolidateCtx} ConsolidateCtx */
/** @typedef {import("./consolidate-report.mjs").MergeCandidate} MergeCandidate */
/** @typedef {import("./consolidate-report.mjs").ClusterResult} ClusterResult */
/** @typedef {import("./consolidate-report.mjs").PassReport} PassReport */
/** @typedef {import("./consolidate-time.mjs").NowInput} NowInput */

// 2B — exact byte-equal duplicates inside the cluster (single category).
/**
 * @param {Object} args
 * @param {RunLeaf} args.leaf
 * @param {RunLeaf[]} args.clusterLeaves
 * @param {ConsolidateCtx} args.ctx
 * @param {NowInput} [args.now]
 */
export function dedupeBySha256({ leaf, clusterLeaves, ctx, now: _now }) {
  const t0 = Date.now();
  const report = /** @type {PassReport} */ (ctx.report.get("dedupe-by-sha256"));
  const leafHash = contentHash(leaf.text);
  for (const m of clusterLeaves) {
    if (m.documentId === leaf.documentId) continue;
    if (ctx.touchedThisRun.has(m.documentId)) continue;
    if (m.category !== leaf.category) continue; // defensive
    if (contentHash(m.text) !== leafHash) continue;
    const keeper = pickKeeper(leaf, m);
    const loser = keeper.documentId === leaf.documentId ? m : leaf;
    // Pair already queued (same leaf may appear in multiple clusters across
    // the loop)? Skip — first marker wins.
    if (ctx.pairsSeen.has(loserKey(keeper, loser))) continue;
    ctx.pairsSeen.add(loserKey(keeper, loser));
    ctx.mergeCandidates.push({
      keeper,
      loser,
      sourcePass: "dedupe-by-sha256",
    });
    ctx.touchedThisRun.add(loser.documentId);
    report.flagged++;
    recordEntity(report, {
      id: entityPairId(keeper, loser),
      kind: "dedup-pair",
      action: "flag",
      ok: true,
      reason: "sha256-equal",
    });
  }
  report.ms += Date.now() - t0;
}

// 2C — lesson-key dedup. Atom-type-gated, NOT category-gated: any
// LESSON_KEY_ELIGIBLE_ATOM_TYPES leaf (default: self-improvement-lesson)
// can be grouped by (project_module, area, task_type, error_pattern).
// Empty error_pattern skips the pair (those are surfaced separately by
// audit_memory). Layout YAML still decides which categories are even
// walked (via `consolidate: refine`) — this pass only applies the
// atom-type semantic on top.
/**
 * @param {Object} args
 * @param {RunLeaf} args.leaf
 * @param {RunLeaf[]} args.clusterLeaves
 * @param {ConsolidateCtx} args.ctx
 * @param {NowInput} [args.now]
 */
export function dedupeByLessonKey({ leaf, clusterLeaves, ctx, now: _now }) {
  const leafAtom = String(leaf.memory?.atom_type || "");
  if (!LESSON_KEY_ELIGIBLE_ATOM_TYPES.has(leafAtom)) return;
  const t0 = Date.now();
  const report = /** @type {PassReport} */ (ctx.report.get("dedupe-by-lesson-key"));
  const leafKey = lessonKey(leaf);
  if (!leafKey) {
    report.ms += Date.now() - t0;
    return;
  }
  for (const m of clusterLeaves) {
    if (m.documentId === leaf.documentId) continue;
    if (ctx.touchedThisRun.has(m.documentId)) continue;
    const mAtom = String(m.memory?.atom_type || "");
    if (!LESSON_KEY_ELIGIBLE_ATOM_TYPES.has(mAtom)) continue;
    if (lessonKey(m) !== leafKey) continue;
    const keeper = pickKeeper(leaf, m);
    const loser = keeper.documentId === leaf.documentId ? m : leaf;
    if (ctx.pairsSeen.has(loserKey(keeper, loser))) continue;
    ctx.pairsSeen.add(loserKey(keeper, loser));
    ctx.mergeCandidates.push({
      keeper,
      loser,
      sourcePass: "dedupe-by-lesson-key",
    });
    ctx.touchedThisRun.add(loser.documentId);
    report.flagged++;
    recordEntity(report, {
      id: entityPairId(keeper, loser),
      kind: "dedup-pair",
      action: "flag",
      ok: true,
      reason: "lesson-key-equal",
    });
  }
  report.ms += Date.now() - t0;
}

// 2D — cosine-similarity archive inside the cluster. The cluster scores
// returned by `searchMemoryFiltered` already use the leaf body as the query,
// so `record.score === cosine(leaf, member)` — no extra vector math needed.
// The lexical-fallback warning is emitted ONCE per run at orchestrator
// startup (see consolidateMemory), so this pass just reads the resolved
// threshold off ctx.cosineThreshold without re-warning.
/**
 * @param {Object} args
 * @param {RunLeaf} args.leaf
 * @param {ClusterResult} args.cluster
 * @param {ConsolidateCtx} args.ctx
 * @param {NowInput} [args.now]
 */
export function dedupeByCosine({ leaf, cluster, ctx, now: _now }) {
  const t0 = Date.now();
  const report = /** @type {PassReport} */ (ctx.report.get("dedupe-by-cosine"));
  const threshold = ctx.cosineThreshold;
  // The LLM-only band exists ONLY when the merge pass can actually adjudicate
  // this run: when the LLM is unavailable, finalize archives every flagged
  // loser deterministically, so flagging a sub-threshold pair would archive
  // it without judgment — exactly what the band forbids.
  const bandActive = ctx.cosineBandFloor != null && ctx.llmEnabled === true;
  const effectiveFloor = bandActive ? /** @type {number} */ (ctx.cosineBandFloor) : threshold;
  for (const member of cluster.records) {
    if (member.documentId === leaf.documentId) continue;
    if (ctx.touchedThisRun.has(member.documentId)) continue;
    if (member.score < effectiveFloor) continue;
    const memberLeaf = /** @type {RunLeaf | null} */ (
      readLeafForConsolidate({
        documentId: member.documentId,
      })
    );
    if (!memberLeaf) continue; // vanished mid-walk
    if (memberLeaf.category && memberLeaf.category !== leaf.category) continue;
    // Defensive: cluster is already category-scoped via searchMemoryFiltered's
    // datasetId, but we double-check by category prefix on the documentId.
    if (!memberLeaf.documentId.startsWith(`${leaf.category}/`)) continue;
    memberLeaf.category = leaf.category;
    const keeper = pickKeeper(leaf, memberLeaf);
    const loser = keeper.documentId === leaf.documentId ? memberLeaf : leaf;
    if (ctx.pairsSeen.has(loserKey(keeper, loser))) continue;
    ctx.pairsSeen.add(loserKey(keeper, loser));
    const inBand = member.score < threshold;
    ctx.mergeCandidates.push({
      keeper,
      loser,
      sourcePass: "dedupe-by-cosine",
      score: member.score,
      band: inBand,
    });
    ctx.touchedThisRun.add(loser.documentId);
    report.flagged++;
    recordEntity(report, {
      id: entityPairId(keeper, loser),
      kind: "dedup-pair",
      action: "flag",
      ok: true,
      reason: `cosine ${Number(member.score).toFixed(4)}${inBand ? " (band)" : ""}`,
    });
  }
  report.ms += Date.now() - t0;
}

// Per-leaf finalize: archive every loser the cluster passes flagged. When
// Phase 3's LLM merge ran, candidates whose llmDecision.action==="skip" are
// LEFT ACTIVE; candidates with action==="merge"/"keep-keeper-unchanged"/
// "fallback" all archive the loser (the merge may have rewritten the
// keeper body first, but the archive of the loser is identical).
/**
 * @param {Object} args
 * @param {MergeCandidate[]} args.candidates
 * @param {ConsolidateCtx} args.ctx
 * @param {NowInput} [args.now]
 * @param {boolean} [args.dryRun]
 */
export function finalizeMergeCandidates({ candidates, ctx, now, dryRun }) {
  if (!candidates.length) return;
  for (const cand of candidates) {
    const { keeper, loser, sourcePass } = cand;
    const report = /** @type {PassReport} */ (ctx.report.get(sourcePass));
    // LLM said "skip" — leave both leaves active.
    if (cand.llmDecision?.action === "skip") continue;
    if (dryRun) {
      report.archived++;
      recordEntity(report, {
        id: entityPairId(keeper, loser),
        kind: "dedup-pair",
        action: "archive",
        ok: true,
      });
      continue;
    }
    try {
      // Re-read the loser right before mutating. If `frontmatter.updated`
      // changed since we queued the candidate, a concurrent write landed; skip
      // to avoid clobbering newer state. Same guard the plan calls out.
      const cur = /** @type {RunLeaf | null} */ (
        readLeafForConsolidate({ documentId: loser.documentId })
      );
      if (!cur || !cur.active) {
        report.skipped = true;
        recordEntity(report, {
          id: entityPairId(keeper, loser),
          kind: "dedup-pair",
          action: "skip-vanished",
          ok: true,
        });
        continue;
      }
      const beforeUpdated = String(loser.frontmatter?.updated || "");
      const curUpdated = String(cur.frontmatter?.updated || "");
      if (beforeUpdated && curUpdated && curUpdated !== beforeUpdated) {
        recordEntity(report, {
          id: entityPairId(keeper, loser),
          kind: "dedup-pair",
          action: "skip-changed",
          ok: true,
        });
        process.stderr.write(
          `[consolidate] skip-changed-under-pass: ${loser.documentId} ` +
            `(before=${beforeUpdated}, now=${curUpdated})\n`,
        );
        continue;
      }
      stampLeafMetadata(loser.documentId, {
        supersedes_id: keeper.documentId,
        consolidated_at: toIso(now),
      });
      disableDocument({ documentId: loser.documentId });
      // Merge must never demote the higher tier: bump the keeper to the MAX
      // priority of the pair so a P1/P0 loser isn't archived into a lower-priority
      // keeper. Best-effort — a priority bump never blocks the merge.
      try {
        const keeperCur = /** @type {RunLeaf | null} */ (
          readLeafForConsolidate({ documentId: keeper.documentId })
        );
        const kp = normalisePriority(keeperCur?.frontmatter?.memory?.priority) || "P2";
        const lp = normalisePriority(cur.frontmatter?.memory?.priority) || "P2";
        if (priorityRank(lp) < priorityRank(kp)) {
          stampLeafMetadata(keeper.documentId, { priority: lp });
        }
      } catch {
        /* best-effort; priority bump is non-fatal */
      }
      report.archived++;
      recordEntity(report, {
        id: entityPairId(keeper, loser),
        kind: "dedup-pair",
        action: "archive",
        ok: true,
      });
    } catch (err) {
      const e = /** @type {Error} */ (err);
      report.errors++;
      recordEntity(report, {
        id: entityPairId(keeper, loser),
        kind: "dedup-pair",
        action: "archive",
        ok: false,
        error: err,
      });
      process.stderr.write(
        `[consolidate] archive failed for ${loser.documentId} (${sourcePass}): ${e?.message || e}\n`,
      );
    }
  }
}

// 3A — LLM merge-near-duplicates pass. Follows the sanctioned decideAction
// pattern (fixed prompt + strict JSON schema + deterministic validation that
// rejects hallucinated ids and re-prompts) shared with compile.mjs.

import path from "node:path";
import { PROMPTS_DIR } from "./lib/env.mjs";
import { consolidateLlmMaxRetries, atomBodyMaxChars } from "./lib/settings.mjs";
import { truncateAtWordBoundary } from "./lib/slug.mjs";
import { saveDocument, isLeafFull } from "./lib/wiki-store.mjs";
import { preserveIdentityOnResave } from "./lib/wiki-identity.mjs";
import { callJSON } from "./lib/llm-callJSON.mjs";
import { generateWithJudge } from "./lib/quality-loop.mjs";
import { LLMOutputInvalid } from "./lib/llm.mjs";
import { toIso } from "./consolidate-time.mjs";
import { entityPairId, recordEntity, stampLeafMetadata } from "./consolidate-report.mjs";
import { MERGE_SCHEMA } from "./consolidate-schemas.mjs";

/** @typedef {import("./consolidate-report.mjs").ConsolidateCtx} ConsolidateCtx */
/** @typedef {import("./consolidate-report.mjs").MergeCandidate} MergeCandidate */
/** @typedef {import("./consolidate-report.mjs").LlmMergeDecision} LlmMergeDecision */
/** @typedef {import("./consolidate-report.mjs").PassReport} PassReport */
/** @typedef {import("./consolidate-time.mjs").NowInput} NowInput */

// 3A — LLM merge-near-duplicates. Consumes the mergeCandidates queued by
// 2B/2C/2D BEFORE the deterministic finalize archives the loser. For each
// (keeper, loser) pair we ask the LLM to either rewrite the keeper body
// (action="merge"), leave the keeper as-is and still archive the loser
// (action="keep-keeper-unchanged"), or skip the whole pair (action="skip")
// — which leaves BOTH leaves active.
//
// Mutates each candidate in place with `cand.llmDecision`:
//   - { action: "merge",  ...llm }                  -> keeper body rewritten here; finalize archives loser
//   - { action: "keep-keeper-unchanged", ...llm }   -> finalize archives loser unchanged
//   - { action: "skip",   ...llm }                  -> finalize skips this candidate (both leaves stay active)
//   - { action: "fallback", ...err }                -> LLM unreachable / schema failed; finalize archives loser
//
// `dryRun`: the LLM still runs (the orchestrator wants to know what WOULD
// change), but the keeper-body rewrite is skipped and the candidate is
// returned with the decision logged. The downstream finalize also honours
// dryRun.
/**
 * @param {Object} args
 * @param {MergeCandidate[]} args.candidates
 * @param {ConsolidateCtx} args.ctx
 * @param {NowInput} [args.now]
 * @param {boolean} [args.dryRun]
 */
export async function llmMergeNearDuplicates({ candidates, ctx, now, dryRun }) {
  if (!candidates.length) return;
  const report = /** @type {PassReport} */ (ctx.report.get("llm-merge-near-duplicates"));
  const t0 = Date.now();
  const maxRetries = consolidateLlmMaxRetries();
  const bodyCap = atomBodyMaxChars();
  const promptPath = path.join(PROMPTS_DIR, "consolidate-merge.md");
  for (const cand of candidates) {
    if (cand.llmDecision) continue; // already decided
    const { keeper, loser, sourcePass } = cand;
    const vars = {
      SOURCE_PASS: sourcePass,
      KEEPER_ID: keeper.documentId,
      KEEPER_UPDATED: String(keeper.frontmatter?.updated || ""),
      KEEPER_FRONTMATTER: keeper.memory || {},
      KEEPER_BODY: String(keeper.text || ""),
      LOSER_ID: loser.documentId,
      LOSER_UPDATED: String(loser.frontmatter?.updated || ""),
      LOSER_FRONTMATTER: loser.memory || {},
      LOSER_BODY: String(loser.text || ""),
      ATOM_BODY_MAX_CHARS: bodyCap,
    };
    try {
      // Judge-in-the-loop: a `merge` rewrites the keeper body (new durable
      // content), so it runs through the quality judge, regenerating with
      // feedback up to quality.maxRounds. `keep-keeper-unchanged`/`skip` write
      // no new body, so they bypass. FAIL-CLOSED: a judge/provider outage
      // throws, caught below → band pair keeps both, non-band falls back to a
      // deterministic archive-without-merge (the established unreachable path).
      const judged = await generateWithJudge({
        category: keeper.category,
        generate: async ({ recommendation }) => {
          const d = /** @type {LlmMergeDecision} */ (
            await callJSON({
              promptPath,
              userPrompt: recommendation
                ? `Emit STRICT JSON per the schema in the system prompt.\n\n---\nA QUALITY JUDGE REJECTED YOUR MERGED BODY. Rewrite merged_body to address this while preserving the durable facts from BOTH leaves:\n${recommendation}`
                : "Emit STRICT JSON per the schema in the system prompt.",
              vars,
              schema: MERGE_SCHEMA,
              maxRetries,
              maxTokens: 1200,
            })
          );
          // Hallucination guard against the documentIds — schema already
          // enforces string presence; here we enforce match to inputs.
          if (d.keeper_id !== keeper.documentId || d.loser_id !== loser.documentId) {
            throw new LLMOutputInvalid(
              `LLM emitted ids that don't match inputs: keeper=${d.keeper_id} (want ${keeper.documentId}), loser=${d.loser_id} (want ${loser.documentId})`,
              JSON.stringify(d),
            );
          }
          if (d.action !== "merge") return { decision: d, __bypassJudge: true };
          return {
            decision: d,
            title: String(keeper.frontmatter?.focus || keeper.name || ""),
            body: String(d.merged_body || ""),
          };
        },
      });
      const decision = /** @type {LlmMergeDecision} */ (
        /** @type {{ decision: LlmMergeDecision }} */ (judged.candidate).decision
      );
      const flaggedUnverified = judged.flagged;
      cand.llmDecision = decision;
      if (decision.action === "merge") {
        let body = String(decision.merged_body || "");
        if (body.length > bodyCap && !isLeafFull(keeper.category, keeper.memory)) {
          body =
            truncateAtWordBoundary(body, bodyCap, { preferSentence: true }) +
            `\n\n[truncated by consolidate at ${toIso(now)} — merged_body exceeded settings.compile.atomBodyMaxChars]\n`;
          process.stderr.write(
            `[consolidate] 3A merged_body truncated for keeper=${keeper.documentId} (${/** @type {string} */ (decision.merged_body).length} -> ${body.length} chars)\n`,
          );
        }
        if (!dryRun) {
          // Rewrite the keeper body in place. CRITICAL: saveDocument runs
          // facet inference on the passed metadata and would RELOCATE the
          // leaf if the inferred placement disagrees with the current dir.
          // That would silently invalidate keeper.documentId AND the
          // supersedes_id we're about to stamp on the loser. Pin the
          // placement via `placementOverride` (the leaf's existing dir)
          // so the rewrite stays in place. saveDocument's
          // normalisePlacementOverride accepts a directory; we strip the
          // leaf basename from keeper.documentId.
          const keeperMem = { ...(keeper.memory || {}) };
          // The judge just re-verified the merged body: set the flag when it
          // still fell short, CLEAR a stale one when it now passes (self-heal).
          if (flaggedUnverified) keeperMem.quality = "unverified";
          else delete keeperMem.quality;
          const keeperDir = path.posix.dirname(keeper.documentId);
          try {
            saveDocument({
              name: keeper.name,
              text: body,
              datasetId: keeper.category,
              metadata: preserveIdentityOnResave(keeperMem, keeper.memory),
              placementOverride: keeperDir,
            });
            stampLeafMetadata(keeper.documentId, { consolidated_at: toIso(now) });
            report.merged++;
            recordEntity(report, {
              id: entityPairId(keeper, loser),
              kind: "dedup-pair",
              action: "merge",
              ok: true,
            });
          } catch (err) {
            const e = /** @type {Error} */ (err);
            report.errors++;
            recordEntity(report, {
              id: entityPairId(keeper, loser),
              kind: "dedup-pair",
              action: "merge",
              ok: false,
              error: err,
            });
            process.stderr.write(
              `[consolidate] 3A merge-write failed for keeper=${keeper.documentId}: ${e?.message || e}\n`,
            );
            if (cand.band) {
              // Band pairs are LLM-judgment-only: a failed rewrite must not
              // degrade into a deterministic archive. Keep both leaves.
              cand.llmDecision = {
                action: "skip",
                reason: `band pair, merge-write failed — kept both active`,
                bandFallback: true,
              };
              ctx.flaggedSkips = ctx.flaggedSkips || [];
              ctx.flaggedSkips.push({
                class: "band-llm-unreachable",
                keeperId: keeper.documentId,
                loserId: loser.documentId,
                reason: String(e?.message || e),
              });
              recordEntity(report, {
                id: entityPairId(keeper, loser),
                kind: "dedup-pair",
                action: "skip",
                ok: true,
                reason: "band pair, merge-write failed — kept both active",
              });
            } else {
              // Treat as fallback so finalize still archives the loser.
              cand.llmDecision = {
                action: "fallback",
                reason: `merge-write failed: ${e?.message || e}`,
              };
            }
          }
        } else {
          report.merged++;
          recordEntity(report, {
            id: entityPairId(keeper, loser),
            kind: "dedup-pair",
            action: "merge",
            ok: true,
          });
        }
      } else if (decision.action === "keep-keeper-unchanged") {
        // No keeper rewrite; finalize still archives loser.
        recordEntity(report, {
          id: entityPairId(keeper, loser),
          kind: "dedup-pair",
          action: "keep-keeper",
          ok: true,
        });
      } else if (decision.action === "skip") {
        // Surface the LLM rejection on the merge-pass report (the source
        // pass already counted the deterministic flag at queue time, so
        // bumping it again here would double-count).
        report.flagged++;
        ctx.flaggedSkips = ctx.flaggedSkips || [];
        ctx.flaggedSkips.push({
          class: "llm-rejected-merge",
          keeperId: keeper.documentId,
          loserId: loser.documentId,
          reason: /** @type {string} */ (decision.reason),
        });
        recordEntity(report, {
          id: entityPairId(keeper, loser),
          kind: "dedup-pair",
          action: "skip",
          ok: true,
          reason: decision.reason,
        });
      }
    } catch (err) {
      const e = /** @type {Error} */ (err);
      // Terminal LLM failure. At/above the threshold the established
      // contract holds: fall back to deterministic archive-without-merge.
      // In the BAND the pair exists only for LLM adjudication, so an
      // unreachable LLM means keep both leaves (skip), never blind-archive.
      if (cand.band) {
        cand.llmDecision = {
          action: "skip",
          reason: `band pair, llm unreachable — kept both active`,
          bandFallback: true,
        };
        ctx.flaggedSkips = ctx.flaggedSkips || [];
        ctx.flaggedSkips.push({
          class: "band-llm-unreachable",
          keeperId: keeper.documentId,
          loserId: loser.documentId,
          reason: String(e?.message || e),
        });
        recordEntity(report, {
          id: entityPairId(keeper, loser),
          kind: "dedup-pair",
          action: "skip",
          ok: true,
          reason: "band pair, llm unreachable — kept both active",
        });
      } else {
        cand.llmDecision = {
          action: "fallback",
          reason: `llm-merge-failed: ${e?.message || String(e)}`,
        };
      }
      report.errors++;
      recordEntity(report, {
        id: entityPairId(keeper, loser),
        kind: "dedup-pair",
        action: "merge",
        ok: false,
        error: err,
      });
      process.stderr.write(
        `[consolidate] event=llm-merge-failed pair=${keeper.documentId}|${loser.documentId} ${e?.message || e}\n`,
      );
    }
  }
  report.ms += Date.now() - t0;
}

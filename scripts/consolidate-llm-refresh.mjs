// 3B — LLM semantic-refresh pass. Follows the sanctioned decideAction
// pattern (fixed prompt + strict JSON schema + deterministic validation that
// rejects hallucinated ids and re-prompts) shared with compile.mjs and the
// 3A merge pass.

import path from "node:path";
import { z } from "zod";
import { PROMPTS_DIR } from "./lib/env.mjs";
import {
  consolidateClusterTopK,
  consolidateClusterScoreThreshold,
  consolidateLlmMaxRetries,
  consolidateRefreshMaxPerRun,
  atomBodyMaxChars,
} from "./lib/settings.mjs";
import { truncateAtWordBoundary } from "./lib/slug.mjs";
import {
  listActiveLeavesForConsolidate,
  searchMemoryFiltered,
  disableDocument,
  saveDocument,
  embedTextForLeaf,
  isLeafFull,
} from "./lib/wiki-store.mjs";
import { preserveIdentityOnResave } from "./lib/wiki-identity.mjs";
import { callJSON } from "./lib/llm-callJSON.mjs";
import { LLMOutputInvalid } from "./lib/llm.mjs";
import { toIso } from "./consolidate-time.mjs";
import { entityLeafId, recordEntity, stampLeafMetadata } from "./consolidate-report.mjs";

/** @typedef {import("./consolidate-report.mjs").ConsolidateCtx} ConsolidateCtx */
/** @typedef {import("./consolidate-report.mjs").RunLeaf} RunLeaf */
/** @typedef {import("./consolidate-time.mjs").NowInput} NowInput */

/**
 * The adjudication the 3B LLM emits per stale leaf (the REFRESH_SCHEMA output).
 * @typedef {Object} RefreshDecision
 * @property {"keep" | "rewrite" | "archive"} action
 * @property {string} leaf_id
 * @property {string} [rewritten_body]
 * @property {string} [archive_reason]
 * @property {boolean} stale_after
 * @property {string} reason
 */

/**
 * The `searchMemoryFiltered` options the refresh pass supplies to build a
 * candidate cluster around a stale leaf.
 * @typedef {Object} SearchFilteredArgs
 * @property {string} [query]
 * @property {string} [datasetId]
 * @property {number} [limit]
 * @property {import("./lib/types.mjs").MetadataInput} [filters]
 * @property {number} [scoreThreshold]
 * @property {boolean} [withGlance]
 */

/**
 * The cluster envelope `searchMemoryFiltered` returns to the refresh pass.
 * @typedef {Object} RefreshCluster
 * @property {Array<{ documentId: string, score?: number, content?: string }>} [records]
 */

const REFRESH_SCHEMA = z
  .object({
    action: z.enum(["keep", "rewrite", "archive"]),
    leaf_id: z.string().min(1),
    rewritten_body: z.string().min(1).optional(),
    archive_reason: z.string().min(1).optional(),
    stale_after: z.boolean(),
    reason: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.action === "rewrite" && !v.rewritten_body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rewritten_body"],
        message: "rewritten_body is required when action='rewrite'",
      });
    }
    if (v.action === "archive" && !v.archive_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["archive_reason"],
        message: "archive_reason is required when action='archive'",
      });
    }
  });

export { REFRESH_SCHEMA };

// 3B — LLM semantic refresh. Runs AFTER stalenessFlag flagged leaves. Caps
// per-run LLM calls at consolidateRefreshMaxPerRun(); remaining stale leaves
// carry over to the next run. For each candidate the LLM either keeps it
// (optionally clearing the stale flag), rewrites the body (clearing stale +
// stamping last_refreshed_at), or archives it. Per-leaf failures DO NOT
// abort the loop.
/**
 * @param {Object} args
 * @param {ConsolidateCtx} args.ctx
 * @param {NowInput} [args.now]
 * @param {boolean} [args.dryRun]
 */
export async function llmSemanticRefresh({ ctx, now, dryRun }) {
  const report = /** @type {import("./consolidate-report.mjs").PassReport} */ (
    ctx.report.get("llm-semantic-refresh")
  );
  const t0 = Date.now();
  const maxRetries = consolidateLlmMaxRetries();
  const cap = consolidateRefreshMaxPerRun();
  const bodyCap = atomBodyMaxChars();
  const promptPath = path.join(PROMPTS_DIR, "consolidate-refresh.md");

  // Collect stale leaves across refine-eligible categories (layout-declared).
  /** @type {RunLeaf[]} */
  const stale = [];
  for (const cat of ctx.refineCategories || []) {
    for (const leaf of listActiveLeavesForConsolidate({ category: cat })) {
      if (leaf.memory?.stale !== true) continue;
      stale.push(/** @type {RunLeaf} */ ({ ...leaf, category: cat }));
    }
  }
  // Process most-recently-updated leaves first; they're more likely to be
  // load-bearing in current work. Tie-break by lex-ascending documentId
  // so two runs with identical timestamps pick the same leaves first
  // (deterministic ordering under the per-run cap).
  stale.sort((a, b) => {
    const aMs = Date.parse(a.frontmatter?.updated || "") || 0;
    const bMs = Date.parse(b.frontmatter?.updated || "") || 0;
    if (aMs !== bMs) return bMs - aMs;
    return a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0;
  });

  const limited = stale.slice(0, Math.max(0, cap));
  if (stale.length > limited.length) {
    process.stderr.write(
      `[consolidate] 3B refresh capped at ${cap}/run; ${stale.length - limited.length} stale leaves deferred to next run\n`,
    );
  }

  for (const leaf of limited) {
    /** @type {RefreshCluster | undefined} */
    let cluster;
    try {
      cluster = await searchMemoryFiltered(
        /** @type {SearchFilteredArgs} */ ({
          query: embedTextForLeaf(leaf.frontmatter, leaf.text).slice(0, 1024),
          datasetId: leaf.category,
          limit: consolidateClusterTopK(),
          scoreThreshold: consolidateClusterScoreThreshold(),
        }),
      );
    } catch (err) {
      report.errors++;
      recordEntity(report, {
        id: entityLeafId(leaf),
        kind: "leaf",
        action: "refresh",
        ok: false,
        error: err,
      });
      process.stderr.write(
        `[consolidate] 3B cluster lookup failed for ${leaf.documentId}: ${/** @type {Error} */ (err)?.message || err}\n`,
      );
      continue;
    }
    const filteredCluster = (cluster?.records || []).filter(
      (r) => r.documentId !== leaf.documentId,
    );
    const clusterBundle = filteredCluster.slice(0, consolidateClusterTopK()).map((r, i) => ({
      n: i + 1,
      documentId: r.documentId,
      score: Number(r.score?.toFixed?.(4) ?? r.score),
      content: String(r.content || "").slice(0, 600),
    }));

    const vars = {
      LEAF_ID: leaf.documentId,
      LEAF_UPDATED: String(leaf.frontmatter?.updated || ""),
      LEAF_FRONTMATTER: leaf.memory || {},
      LEAF_BODY: String(leaf.text || ""),
      CLUSTER_BUNDLE: clusterBundle,
      ATOM_BODY_MAX_CHARS: bodyCap,
    };

    let decision;
    try {
      decision = /** @type {RefreshDecision} */ (
        await callJSON({
          promptPath,
          userPrompt: "Emit STRICT JSON per the schema in the system prompt.",
          vars,
          schema: REFRESH_SCHEMA,
          maxRetries,
          maxTokens: 1200,
        })
      );
      if (decision.leaf_id !== leaf.documentId) {
        throw new LLMOutputInvalid(
          `LLM emitted leaf_id=${decision.leaf_id} that doesn't match input ${leaf.documentId}`,
          JSON.stringify(decision),
        );
      }
    } catch (err) {
      report.errors++;
      recordEntity(report, {
        id: entityLeafId(leaf),
        kind: "leaf",
        action: "refresh",
        ok: false,
        error: err,
      });
      process.stderr.write(
        `[consolidate] event=llm-refresh-failed leaf=${leaf.documentId} ${/** @type {Error} */ (err)?.message || err}\n`,
      );
      continue; // leave the stale flag in place
    }

    if (dryRun) {
      if (decision.action === "rewrite") report.refreshed++;
      else if (decision.action === "archive") report.archived++;
      else report.touched++;
      recordEntity(report, {
        id: entityLeafId(leaf),
        kind: "leaf",
        action: decision.action,
        ok: true,
      });
      continue;
    }

    try {
      if (decision.action === "keep") {
        stampLeafMetadata(leaf.documentId, { stale: decision.stale_after === true });
        report.touched++;
        recordEntity(report, { id: entityLeafId(leaf), kind: "leaf", action: "keep", ok: true });
      } else if (decision.action === "rewrite") {
        let body = String(decision.rewritten_body || "");
        if (body.length > bodyCap && !isLeafFull(leaf.category, leaf.memory)) {
          body =
            truncateAtWordBoundary(body, bodyCap, { preferSentence: true }) +
            `\n\n[truncated by consolidate at ${toIso(now)} — rewritten_body exceeded settings.compile.atomBodyMaxChars]\n`;
          process.stderr.write(
            `[consolidate] 3B rewritten_body truncated for ${leaf.documentId}\n`,
          );
        }
        // Same relocation hazard as 3A — pin to the leaf's existing dir.
        const leafDir = path.posix.dirname(leaf.documentId);
        saveDocument({
          name: leaf.name,
          text: body,
          datasetId: leaf.category,
          metadata: preserveIdentityOnResave(leaf.memory || {}, leaf.memory),
          placementOverride: leafDir,
        });
        stampLeafMetadata(leaf.documentId, {
          stale: false,
          last_refreshed_at: toIso(now),
          consolidated_at: toIso(now),
        });
        report.refreshed++;
        recordEntity(report, { id: entityLeafId(leaf), kind: "leaf", action: "rewrite", ok: true });
      } else if (decision.action === "archive") {
        stampLeafMetadata(leaf.documentId, { consolidated_at: toIso(now) });
        disableDocument({ documentId: leaf.documentId });
        ctx.flaggedRefreshArchives = ctx.flaggedRefreshArchives || [];
        ctx.flaggedRefreshArchives.push({
          leafId: leaf.documentId,
          archive_reason: decision.archive_reason,
          reason: decision.reason,
        });
        report.archived++;
        recordEntity(report, {
          id: entityLeafId(leaf),
          kind: "leaf",
          action: "archive",
          ok: true,
          reason: decision.archive_reason,
        });
      }
    } catch (err) {
      report.errors++;
      recordEntity(report, {
        id: entityLeafId(leaf),
        kind: "leaf",
        action: decision.action,
        ok: false,
        error: err,
      });
      process.stderr.write(
        `[consolidate] 3B apply failed for ${leaf.documentId} (action=${decision.action}): ${/** @type {Error} */ (err)?.message || err}\n`,
      );
    }
  }
  report.ms += Date.now() - t0;
}

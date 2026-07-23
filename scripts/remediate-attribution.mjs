#!/usr/bin/env node
// One-shot bulk remediation: de-personalize existing leaves (content-quality rule 18) —
// remove user attribution/quotes + irrelevant specifics, keep the technical evidence. A
// dedicated iterator (NOT consolidate: consolidate-refresh only touches a stale,
// atom-type-filtered, per-run-capped subset and its prompt forbids reducing specificity).
//
// SCOPE: the BODY-ONLY curated categories (knowledge + self_improvement). plans /
// investigations / issues carry top-level lifecycle frontmatter the renderer does not
// round-trip, so a body rewrite would strip it — they are out of scope for this one-shot
// pass (the content rule still governs them going forward). `full`/absorbed leaves are
// skipped (verbatim by contract). `daily` is raw and never in scope.
//
// Safety: runs inside the brain context under one withWikiCommit batch (auto-commit → the
// whole run is one revertible commit: `git -C <wiki> reset --hard <pre-run-sha>`). Default
// pre-filters by the deterministic attribution detector (only flagged leaves cost an LLM
// call and get rewritten; clean docs are left untouched). `--all` reviews every in-scope
// leaf. `--dry-run` reports planned rewrites without writing. LLM-unavailable is a no-op.

import path from "node:path";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { PROMPTS_DIR } from "./lib/env.mjs";
import { atomBodyMaxChars } from "./lib/settings.mjs";
import {
  getCategories,
  listActiveLeavesForConsolidate,
  saveDocument,
  isLeafFull,
} from "./lib/wiki-store.mjs";
import { withBrainContextSafe } from "./lib/wiki-context.mjs";
import { withWikiCommit } from "./lib/wiki-commit.mjs";
import { withSystemMaintenance } from "./lib/maintenance-tag.mjs";
import { preserveIdentityOnResave } from "./lib/wiki-identity.mjs";
import { callJSON } from "./lib/llm-callJSON.mjs";
import { health } from "./lib/llm.mjs";
import { hasReviewableAttribution } from "./lib/depersonalize.mjs";

// The bulk body-rewrite is restricted to the BODY-ONLY curated categories. plans /
// investigations / issues carry top-level lifecycle frontmatter (status / progress /
// archived) that the leaf renderer does not round-trip, so re-saving them would strip
// it (an archived plan would silently un-archive). The content-quality rule still
// governs those categories going forward (prompts + the interactive save path); they
// are simply out of scope for this one-shot body rewrite. daily is raw + exempt.
const REMEDIATE_CATEGORIES = ["knowledge", "self_improvement"];

const DECISION_SCHEMA = z.object({
  leaf_id: z.string(),
  action: z.enum(["rewrite", "keep"]),
  body: z.string().optional(),
});

/** @param {string[]} available @returns {string[]} */
export function remediationCategories(available) {
  return available.filter((c) => REMEDIATE_CATEGORIES.includes(c));
}

/**
 * @param {{ dryRun?: boolean, all?: boolean }} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function remediate({ dryRun = true, all = false } = {}) {
  return withBrainContextSafe(async () => {
    const probe = await health();
    if (!probe?.available) return { ok: false, skipped: "llm-unavailable", reason: probe?.reason };

    const promptPath = path.join(PROMPTS_DIR, "depersonalize.md");
    const bodyCap = atomBodyMaxChars();
    const categories = remediationCategories(getCategories());
    const report = {
      ok: true,
      dryRun,
      scanned: 0,
      skippedFull: 0,
      flagged: 0,
      rewritten: 0,
      kept: 0,
      errors: 0,
    };
    /** @type {Array<{ id: string, title: string }>} */
    const changes = [];

    await withWikiCommit({ op: "remediate", actor: "remediate", noCommit: dryRun }, () =>
      withSystemMaintenance(async () => {
        for (const category of categories) {
          for (const leaf of listActiveLeavesForConsolidate({ category })) {
            report.scanned += 1;
            // `full`/absorbed leaves are verbatim by contract — never rewrite them.
            if (isLeafFull(category, leaf.memory)) {
              report.skippedFull += 1;
              continue;
            }
            const documentId = String(leaf.documentId || "");
            const existingFocus = String(leaf.frontmatter?.focus || "").trim();
            const title = existingFocus || String(leaf.name || "");
            const body = String(leaf.text || "");
            if (!all && !hasReviewableAttribution(`${title}\n${body}`)) continue;
            report.flagged += 1;
            /** @type {z.infer<typeof DECISION_SCHEMA>} */
            let decision;
            try {
              decision = /** @type {z.infer<typeof DECISION_SCHEMA>} */ (
                await callJSON({
                  promptPath,
                  userPrompt: "Emit STRICT JSON per the schema in the system prompt.",
                  vars: {
                    LEAF_ID: documentId,
                    LEAF_TITLE: title,
                    LEAF_BODY: body,
                    ATOM_BODY_MAX_CHARS: bodyCap,
                  },
                  schema: DECISION_SCHEMA,
                  maxRetries: 2,
                  maxTokens: 1400,
                })
              );
              if (decision.leaf_id !== documentId) {
                throw new Error(`leaf_id mismatch: got ${decision.leaf_id}`);
              }
            } catch (err) {
              report.errors += 1;
              process.stderr.write(
                `[remediate] failed leaf=${documentId} ${err instanceof Error ? err.message : String(err)}\n`,
              );
              continue;
            }
            const rewritten = String(decision.body || "").trim();
            if (decision.action !== "rewrite" || !rewritten || rewritten === body.trim()) {
              report.kept += 1;
              continue;
            }
            report.rewritten += 1;
            changes.push({ id: documentId, title });
            if (dryRun) continue;
            saveDocument({
              name: leaf.name,
              text: rewritten,
              datasetId: category,
              // Preserve the leaf's `focus` explicitly: deriveTitle honours
              // metadata.title first, so the original title survives even when the
              // rewritten body drops its `# heading` (otherwise focus would fall back
              // to the filename slug — with the date suffix leaking in). `title` is
              // consumed for focus and dropped by normaliseMeta (not persisted to the
              // memory block).
              metadata: {
                ...preserveIdentityOnResave(leaf.memory || {}, leaf.memory),
                ...(existingFocus ? { title: existingFocus } : {}),
              },
              placementOverride: path.posix.dirname(documentId),
            });
          }
        }
      }),
    );
    return { ...report, changes };
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = !argv.includes("--apply");
  const all = argv.includes("--all");
  const result = await remediate({ dryRun, all });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`remediate error: ${err?.stack || err}\n`);
    process.exit(1);
  });
}

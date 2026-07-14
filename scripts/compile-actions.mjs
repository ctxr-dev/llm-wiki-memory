import { DRY_RUN } from "./compile-flags.mjs";
import { LLMOutputInvalid } from "./lib/llm.mjs";
import { callJSON } from "./lib/llm-callJSON.mjs";
import {
  writeMemory,
  updateDocMetadata,
  readDocument,
  WikiStoreUnavailable as DifyBridgeUnavailable,
} from "./lib/wiki-store.mjs";
import { metadataForDify } from "./lib/datasets.mjs";
import { recordGatedWrite } from "./lib/save-gate-audit.mjs";
import { nameBuilderForAtom, parserForAtom } from "./compile-routing.mjs";
import { buildPromotedDocText, forcedLessonUpdate } from "./compile-dedup.mjs";

/** @typedef {import("./lib/types.mjs").DistilledAtom} DistilledAtom */
/** @typedef {import("./lib/types.mjs").SearchHit} SearchHit */
/** @typedef {import("./lib/types.mjs").MutationResult} MutationResult */
/** @typedef {import("./compile-dedup.mjs").CompileDecision} CompileDecision */

/**
 * The write outcome compile threads through its execute/audit/metadata steps.
 * A superset of the write-door results (`writeMemory`) that also carries the
 * dry-run and action markers compile's own return literals add, and tolerates
 * the `created.id` fallback the metadata step reads.
 * @typedef {Object} CompileWriteResult
 * @property {boolean} [ok]
 * @property {boolean} [dryRun]
 * @property {string} [action]
 * @property {{ document?: { id?: string }, id?: string }} [created]
 * @property {string} [name]
 * @property {string} [datasetId]
 * @property {string} [supersedes]
 * @property {string} [reason]
 * @property {string} [error]
 * @property {string} [warning]
 */

/**
 * @param {DistilledAtom} atom
 * @param {SearchHit[]} candidates
 * @param {string} systemPrompt
 * @returns {Promise<CompileDecision>}
 */
export async function decideAction(atom, candidates, systemPrompt) {
  const forced = forcedLessonUpdate(atom, candidates);
  if (forced) return forced;
  const userPrompt = [
    "NEW ATOM:",
    JSON.stringify(atom, null, 2),
    "",
    `EXISTING CANDIDATES (already filtered by atom_type=${atom.type} and matching metadata):`,
    candidates.length === 0
      ? "[]"
      : JSON.stringify(
          candidates.map((c) => ({
            documentId: c.documentId,
            documentName: c.documentName,
            score: c.score,
            content: String(c.content || "").slice(0, 800),
          })),
          null,
          2,
        ),
  ].join("\n");
  return /** @type {Promise<CompileDecision>} */ (
    callJSON(
      /** @type {{ systemPrompt: string, userPrompt: string, maxTokens: number, maxRetries?: number }} */ ({
        systemPrompt,
        userPrompt,
        maxTokens: 800,
      }),
    )
  );
}

// Observability only: record that the compile pipeline distilled a
// self_improvement lesson into the wiki. Compile bypasses the MCP write-gate by
// design (it is the auto-learn system path, not an interactive save), so these
// promotions would otherwise be invisible in the gate-audit ledger. This NEVER
// gates, blocks, or alters compile: recordGatedWrite is best-effort and a no-op
// when auditing is off, and the whole call is wrapped so nothing here can affect
// the promotion. Only a successful (non-dry-run) self-improvement-lesson write is
// recorded.
/**
 * @param {DistilledAtom} atom
 * @param {string} action
 * @param {CompileWriteResult} writeResult
 */
function auditCompileLessonPromotion(atom, action, writeResult) {
  try {
    if (atom?.type !== "self-improvement-lesson") return;
    if (!writeResult || writeResult.dryRun || !writeResult.created) return;
    const md = atom?.metadata || {};
    recordGatedWrite({
      layer: "compile",
      tool: "compile",
      status: "accepted",
      consent: "compile-distilled",
      action,
      title: atom?.title,
      area: md.area || md.project_module,
      error_pattern: md.error_pattern,
    });
  } catch {
    /* auditing must never affect distillation */
  }
}

// Read the superseded leaf's stored metadata so an `update` can preserve its
// apply-strength + workspace identity. Defensive: a missing/unreadable candidate
// leaf falls back to atom-only metadata (never aborts the compile run).
/**
 * @param {SearchHit | undefined} candidate
 * @param {string} datasetId
 * @returns {import("./lib/types.mjs").MemoryMetadata | null}
 */
function readSupersededMetadata(candidate, datasetId) {
  if (!candidate) return null;
  try {
    return readDocument({ documentId: candidate.documentId, datasetId })?.metadata || null;
  } catch {
    return null;
  }
}

/**
 * @param {DistilledAtom} atom
 * @param {CompileDecision} decision
 * @param {SearchHit[]} candidates
 * @param {string} targetDataset
 */
export async function executeAction(atom, decision, candidates, targetDataset) {
  if (decision.action === "skip") {
    return { ok: true, action: "skip", reason: decision.reason };
  }
  const buildName = nameBuilderForAtom(atom);
  if (decision.action === "create") {
    const text = buildPromotedDocText(atom);
    const name = buildName(atom.title);
    if (DRY_RUN)
      return { ok: true, dryRun: true, action: "create", name, datasetId: targetDataset };
    // Pass metadata at write so placement nests by the atom's facets
    // (project_module / atom_type / task_type). applyMetadataToWritten still
    // re-merges it afterwards (idempotent) for the retry/un-filterable bookkeeping.
    const result = /** @type {CompileWriteResult} */ (
      await writeMemory({ name, text, datasetId: targetDataset, metadata: metadataForDify(atom) })
    );
    auditCompileLessonPromotion(atom, "create", result);
    return result;
  }
  if (decision.action === "update") {
    if (!decision.supersedes) throw new Error("update action missing supersedes");
    const merged = String(decision.merged_text || "").trim();
    if (!merged) throw new Error("update action missing merged_text");
    const candidate = candidates.find((c) => c.documentId === decision.supersedes);
    // The LLM may hallucinate a documentId not in the candidate set.
    // Without this check, writeMemory would create a new doc and then
    // disableDocument would 404 against a nonexistent id, leaving a
    // duplicate in the target dataset. Refuse and let the retry path
    // re-prompt for a valid decision.
    if (!candidate) {
      throw new LLMOutputInvalid(
        `update.supersedes='${decision.supersedes}' is not in the candidate set; the LLM hallucinated an id`,
        JSON.stringify(decision),
      );
    }
    const parser = parserForAtom(atom);
    const parsed = candidate ? parser(candidate.documentName) : null;
    const slugSource = parsed?.slug ? parsed.slug : decision.merged_name || atom.title;
    const text = buildPromotedDocText(
      { ...atom, title: decision.merged_name || atom.title },
      merged,
    );
    const name = buildName(slugSource);
    if (DRY_RUN) {
      return {
        ok: true,
        dryRun: true,
        action: "update",
        name,
        supersedes: decision.supersedes,
        datasetId: targetDataset,
      };
    }
    // An `update` REPLACES the superseded lesson (writeMemory + supersedes:disable),
    // and metadataForDify carries only the NEW atom's fields. Preserve the
    // superseded leaf's apply-strength + workspace identity so the merge doesn't
    // rebuild a user-gated P0 lesson at the atom_type rubric default (P1) or reset a
    // deliberately cross-project lesson to defaultProjectModule().
    const metadata = metadataForDify(atom);
    const superseded = readSupersededMetadata(candidate, targetDataset);
    if (superseded) {
      // priority: preserve unless the atom carries its own (metadataForDify only
      // emits priority when the atom set one).
      if (!metadata.priority && superseded.priority) metadata.priority = superseded.priority;
      // project_module: preserve ONLY from a POST-SPLIT leaf (one carrying `area`,
      // where project_module is the real workspace identity). A pre-split legacy
      // leaf's project_module IS a sub-module alias — propagating it would mis-stamp
      // it as the workspace, so fall through to defaultProjectModule() there. A
      // compile atom has no channel to re-identify the workspace (it carries a
      // sub-module, not a cross-project override), so this is the only signal.
      if (!metadata.project_module_override && superseded.project_module && superseded.area)
        metadata.project_module_override = superseded.project_module;
    }
    const result = /** @type {CompileWriteResult} */ (
      await writeMemory({
        name,
        text,
        datasetId: targetDataset,
        metadata,
        supersedes: decision.supersedes,
        supersedesAction: "disable",
      })
    );
    auditCompileLessonPromotion(atom, "update", result);
    return result;
  }
  throw new Error(`unknown decision action: ${decision.action}`);
}

// After writeMemory creates the new document, set the per-document Dify
// metadata so subsequent retrieve calls can filter on it. Failure is
// recorded but does not abort the compile run - EXCEPT bridge-unavailable
// errors are re-thrown so the outer per-atom catch can fire `process.exit(0)`
// instead of grinding through more dailies against a dead bridge.
/**
 * @param {DistilledAtom} atom
 * @param {CompileWriteResult} writeResult
 * @param {string} targetDataset
 * @returns {Promise<MutationResult | null>}
 */
export async function applyMetadataToWritten(atom, writeResult, targetDataset) {
  if (!writeResult || writeResult.dryRun) return null;
  const docId = writeResult?.created?.document?.id || writeResult?.created?.id;
  if (!docId) return { ok: false, reason: "writeMemory response missing created.document.id" };
  const md = metadataForDify(atom);
  try {
    return /** @type {MutationResult} */ (
      await updateDocMetadata({ datasetId: targetDataset, documentId: docId, metadata: md })
    );
  } catch (err) {
    if (err instanceof DifyBridgeUnavailable) throw err;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

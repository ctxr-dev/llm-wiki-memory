import fs from "node:fs";
import path from "node:path";
import { PROMPTS_DIR } from "../lib/env.mjs";
import { atomBodyMaxChars } from "../lib/settings.mjs";
import { collectFacetVocab, renderVocabVars } from "../lib/facet-vocab.mjs";
import { callLLMChain } from "../lib/llm.mjs";
import { validateAtoms } from "./flush-validate.mjs";
import { logBreadcrumb, sleep } from "./flush-state.mjs";

// The distill type vocabulary lives in flush-distill.mjs (its canonical home,
// where downstream siblings already reference it). These are type-only imports
// (`import(...)` in JSDoc), so they carry no runtime dependency and do not form
// an import cycle with flush-distill.mjs's runtime import of this module.
/** @typedef {import("../lib/types.mjs").DistilledAtom} DistilledAtom */
/** @typedef {import("./flush-distill.mjs").LLMProvenance} LLMProvenance */
/** @typedef {import("./flush-distill.mjs").ProviderFailure} ProviderFailure */
/** @typedef {import("./flush-distill.mjs").FailedChunk} FailedChunk */
/** @typedef {import("./flush-distill.mjs").DistillAudit} DistillAudit */
/** @typedef {import("./flush-distill.mjs").DistillError} DistillError */
/** @typedef {import("./flush-distill.mjs").SourceChunk} SourceChunk */
/** @typedef {import("./flush-distill.mjs").ChunkSuccess} ChunkSuccess */

function loadPrompt() {
  const file = path.join(PROMPTS_DIR, "flush.md");
  if (!fs.existsSync(file)) {
    throw new Error(`flush prompt missing at ${file}`);
  }
  const cap = atomBodyMaxChars();
  const vocab = renderVocabVars(collectFacetVocab());
  return fs
    .readFileSync(file, "utf8")
    .replace(/\{\{ATOM_BODY_MAX_CHARS\}\}/g, String(cap))
    .replace(/\{\{KNOWN_AREAS\}\}/g, vocab.KNOWN_AREAS)
    .replace(/\{\{KNOWN_ERROR_PATTERNS\}\}/g, vocab.KNOWN_ERROR_PATTERNS);
}
export { loadPrompt };
export const __loadPromptForTest = loadPrompt;

// Single-chunk distill — used both for tiny single-pass sessions and for the
// per-chunk leg of map-reduce. Returns `{ atoms, provenance }`. Throws after
// every attempt errored; the caller decides what to do with the failure.
/**
 * @param {{ systemPrompt: string, userPrompt: string, tag: string, attempts: number, retryMs: number }} args
 * @returns {Promise<{ atoms: DistilledAtom[], provenance: LLMProvenance }>}
 */
export async function distillOneChunk({ systemPrompt, userPrompt, tag, attempts, retryMs }) {
  /** @type {unknown} */
  let lastErr;
  /** @type {LLMProvenance | null} */
  let lastProvenance = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { result, provenance } = await callLLMChain(
        /** @type {{ systemPrompt: string, userPrompt: string, maxTokens: number }} */
        ({ systemPrompt, userPrompt, maxTokens: 1500 }),
      );
      return {
        atoms: validateAtoms(result),
        provenance: /** @type {LLMProvenance} */ (provenance),
      };
    } catch (err) {
      lastErr = err;
      if (err && /** @type {DistillError} */ (err).provenance) {
        lastProvenance = /** @type {LLMProvenance} */ (
          /** @type {DistillError} */ (err).provenance
        );
      }
      // Log the full per-provider failure breakdown so an operator can see
      // WHICH provider failed for WHAT reason. The `err.message` alone
      // surfaces only the LAST chain step; the provenance carries every
      // attempt's reason (e.g. claude:'timeout', codex:'ENOENT', ...).
      const reasons = /** @type {DistillError} */ (err)?.provenance?.failure_reasons
        ?.map(
          (f) =>
            `${f.provider}${f.model ? `:${f.model}` : ""}=${String(f.error || "").slice(0, 120)}`,
        )
        .join("; ");
      const detail = reasons ? ` — [${reasons}]` : "";
      logBreadcrumb(
        `${tag}: chunk attempt ${attempt}/${attempts} failed (${/** @type {Error} */ (err)?.message || err})${detail}`,
      );
      if (attempt < attempts) await sleep(retryMs);
    }
  }
  const wrapped = /** @type {DistillError} */ (lastErr ?? new Error("distillation failed"));
  if (lastProvenance) wrapped.provenance = lastProvenance;
  throw wrapped;
}

/**
 * @param {{ chunk: SourceChunk, baseHeader: string, systemPrompt: string, tag: string, attempts: number, retryMs: number, succeeded: ChunkSuccess[], failed: FailedChunk[], provenances: LLMProvenance[] }} args
 * @returns {Promise<void>}
 */
export async function distillSingleChunkInto({
  chunk,
  baseHeader,
  systemPrompt,
  tag,
  attempts,
  retryMs,
  succeeded,
  failed,
  provenances,
}) {
  const userPrompt = `${baseHeader}Chunk ${chunk.index + 1} of session\n\n--- TRANSCRIPT CHUNK ---\n\n${chunk.text}`;
  try {
    const { atoms, provenance } = await distillOneChunk({
      systemPrompt,
      userPrompt,
      tag: `${tag} chunk ${chunk.index}`,
      attempts,
      retryMs,
    });
    succeeded.push({ index: chunk.index, atoms });
    provenances.push(provenance);
  } catch (err) {
    failed.push({
      index: chunk.index,
      text: chunk.text,
      error: /** @type {Error} */ (err)?.message || String(err),
    });
    if (err && /** @type {DistillError} */ (err).provenance) {
      provenances.push(/** @type {LLMProvenance} */ (/** @type {DistillError} */ (err).provenance));
    }
  }
}

/**
 * @param {{ chunks: SourceChunk[], succeeded: ChunkSuccess[], failed: FailedChunk[], provenances: LLMProvenance[] }} args
 * @returns {DistillAudit}
 */
export function collectAudit({ chunks, succeeded, failed, provenances }) {
  /** @type {Set<string>} */
  const triedSet = new Set();
  /** @type {ProviderFailure[]} */
  const reasons = [];
  /** @type {string | null} */
  let finalProvider = null;
  for (const p of provenances) {
    if (!p) continue;
    for (const t of p.provider_chain_tried || []) triedSet.add(t);
    for (const r of p.failure_reasons || []) reasons.push(r);
    if (p.final_provider && !finalProvider) finalProvider = p.final_provider;
  }
  return {
    chunks_total: chunks.length,
    chunks_succeeded: succeeded.length,
    failed_chunks: failed.map((f) => f.index),
    provider_chain_tried: [...triedSet],
    final_provider: finalProvider,
    failure_reasons: reasons,
  };
}

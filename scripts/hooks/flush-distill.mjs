import {
  flushChunkTargetK,
  flushChunkParallelism,
  flushDistillAttempts,
  flushDistillRetryMs,
} from "../lib/settings.mjs";
import { chunkSource } from "../lib/chunker.mjs";
import { reduceMerge } from "./flush-reduce.mjs";
import { logBreadcrumb } from "./flush-state.mjs";
import {
  loadPrompt,
  distillOneChunk,
  distillSingleChunkInto,
  collectAudit,
} from "./flush-chunk-distill.mjs";

export { __loadPromptForTest } from "./flush-chunk-distill.mjs";

/** @typedef {import("../lib/types.mjs").DistilledAtom} DistilledAtom */
/** @typedef {import("./flush-source.mjs").SourceMaterial} SourceMaterial */

/**
 * One provider/model attempt failure recorded in provenance.
 * @typedef {Object} ProviderFailure
 * @property {string} provider
 * @property {string | null} model
 * @property {string} error
 */

/**
 * Which provider/model combinations were tried and which answered.
 * @typedef {Object} LLMProvenance
 * @property {string[]} provider_chain_tried
 * @property {string | null} final_provider
 * @property {ProviderFailure[]} failure_reasons
 */

/**
 * The raw text and error of a chunk whose distillation failed.
 * @typedef {Object} FailedChunk
 * @property {number} index
 * @property {string} text
 * @property {string} error
 */

/**
 * Map-reduce + provider-chain breadcrumbs recorded in the daily leaf header.
 * @typedef {Object} DistillAudit
 * @property {number} chunks_total
 * @property {number} chunks_succeeded
 * @property {number[]} failed_chunks
 * @property {string[]} provider_chain_tried
 * @property {string | null} final_provider
 * @property {ProviderFailure[]} failure_reasons
 * @property {string | null} [redistilled_from]
 * @property {number} [redistill_attempts]
 * @property {string} [original_outcome]
 * @property {string} [recovered_from_leaf]
 */

/**
 * The distillation result: merged atoms plus the audit breadcrumb.
 * @typedef {Object} DistillResult
 * @property {DistilledAtom[]} atoms
 * @property {DistillAudit} audit
 * @property {FailedChunk[]} [failedChunks]
 */

/**
 * An Error augmented by the distill pipeline with provenance / audit / chunk
 * detail so callers can render a full failure breadcrumb.
 * @typedef {Error & { provenance?: LLMProvenance, chunk_failures?: FailedChunk[], audit?: DistillAudit, failedChunks?: FailedChunk[] }} DistillError
 */

/** @typedef {{ index: number, text: string }} SourceChunk */
/** @typedef {{ index: number, atoms: DistilledAtom[] }} ChunkSuccess */

// Distil the staged context using naive map-reduce when body length exceeds
// the chunk threshold. Single-pass for small sessions. Returns:
//
//   {
//     atoms,                  // merged validated atoms across all chunks
//     audit: {
//       chunks_total, chunks_succeeded,
//       failed_chunks: [{ index, text, error }, ...],
//       provider_chain_tried, final_provider, failure_reasons,
//     },
//   }
//
// Throws ONLY when EVERY chunk fails (caller writes raw fallback + stash).
/**
 * @param {SourceMaterial} source
 * @param {string} tag
 * @returns {Promise<DistillResult>}
 */
export async function distillByChunks(source, tag) {
  const attempts = Math.max(1, flushDistillAttempts());
  const retryMs = flushDistillRetryMs();
  const systemPrompt = loadPrompt();
  const baseHeader = `Hook event: ${source.hookEvent}\nSession id: ${source.sessionId}\nCwd: ${source.cwd}\n\n`;

  const targetK = flushChunkTargetK();
  const chunks = chunkSource(String(source.body || ""), { targetK });

  // Fast path: single chunk → preserve existing single-pass cost profile.
  if (chunks.length <= 1) {
    const userPrompt = `${baseHeader}--- TRANSCRIPT ---\n\n${source.body}`;
    const { atoms, provenance } = await distillOneChunk({
      systemPrompt,
      userPrompt,
      tag,
      attempts,
      retryMs,
    });
    return {
      atoms,
      audit: {
        chunks_total: chunks.length || 1,
        chunks_succeeded: chunks.length || 1,
        failed_chunks: [],
        provider_chain_tried: provenance?.provider_chain_tried || [],
        final_provider: provenance?.final_provider || null,
        failure_reasons: provenance?.failure_reasons || [],
      },
    };
  }

  logBreadcrumb(`${tag}: map-reduce across ${chunks.length} chunks (target_k=${targetK})`);

  /** @type {ChunkSuccess[]} */
  const succeeded = [];
  /** @type {FailedChunk[]} */
  const failed = [];
  /** @type {LLMProvenance[]} */
  const provenances = [];
  // Serial by default; raise via MEMORY_FLUSH_CHUNK_PARALLELISM. We honour the
  // knob but cap concurrency at the chunk count itself.
  const parallelism = Math.max(1, Math.min(flushChunkParallelism(), chunks.length));

  if (parallelism === 1) {
    for (const chunk of chunks) {
      await distillSingleChunkInto({
        chunk,
        baseHeader,
        systemPrompt,
        tag,
        attempts,
        retryMs,
        succeeded,
        failed,
        provenances,
      });
    }
  } else {
    // Bounded parallelism: simple pool. Each worker pulls the next chunk
    // from a shared cursor. Avoid Promise.all with all chunks at once when
    // chunks.length >> parallelism.
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= chunks.length) return;
        await distillSingleChunkInto({
          chunk: chunks[i],
          baseHeader,
          systemPrompt,
          tag,
          attempts,
          retryMs,
          succeeded,
          failed,
          provenances,
        });
      }
    };
    await Promise.all(Array.from({ length: parallelism }, () => worker()));
  }

  if (succeeded.length === 0) {
    const err = /** @type {DistillError} */ (new Error("all chunks failed"));
    err.chunk_failures = failed;
    err.audit = collectAudit({ chunks, succeeded, failed, provenances });
    err.failedChunks = failed.slice();
    throw err;
  }

  // Reduce step: merge all per-chunk atoms into a single, de-duplicated atom
  // set. Uses a "one tier stronger" model when reduce_model_promote is on.
  const allAtoms = succeeded.flatMap((s) => s.atoms);
  const reducedAtoms = await reduceMerge({
    atoms: allAtoms,
    tag,
    attempts,
    retryMs,
    systemPrompt,
    baseHeader,
    sourceProvenances: provenances,
  });

  return {
    atoms: reducedAtoms,
    audit: collectAudit({ chunks, succeeded, failed, provenances }),
    failedChunks: failed.slice(),
  };
}

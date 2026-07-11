// Types hub for the consolidate orchestrator's report/state layer: it declares
// every shared @typedef (so `import("./consolidate-report.mjs").X` stays valid
// across the pass modules) and re-exports the implementations, which live in
// two sibling modules:
//   - consolidate-pass-report.mjs  — per-pass report objects, per-entity outcome
//     recording, and the in-place leaf-metadata stamp shared by every pass.
//   - consolidate-run-state.mjs    — throttle-state IO + pass-selection resolution.

export {
  stampLeafMetadata,
  emptyPassReport,
  entityPairId,
  entityLeafId,
  recordEntity,
  sortPassEntities,
  stripPassEntities,
} from "./consolidate-pass-report.mjs";
export {
  readState,
  writeState,
  resolveAllowedPasses,
  passEnabled,
} from "./consolidate-run-state.mjs";

/** @typedef {import("./lib/types.mjs").ConsolidateLeaf} ConsolidateLeaf */
/** @typedef {import("./lib/types.mjs").MemoryMetadata} MemoryMetadata */
/** @typedef {import("./lib/types.mjs").MetadataInput} MetadataInput */
/** @typedef {import("./lib/types.mjs").MutationResult} MutationResult */
/** @typedef {import("./consolidate-time.mjs").NowInput} NowInput */

/**
 * A consolidate working leaf: the `ConsolidateLeaf` read shape plus the
 * `category` the orchestrator stamps on it as it walks each refine category.
 * @typedef {ConsolidateLeaf & { category?: string }} RunLeaf
 */

/**
 * A cluster hit from `searchMemoryFiltered` — the fields the consolidate passes
 * read off each ranked record (the score IS the cosine to the query leaf).
 * @typedef {Object} ClusterHit
 * @property {string} documentId
 * @property {number} score
 * @property {string} [content]
 */

/**
 * The cluster envelope `searchMemoryFiltered` returns to the consolidate passes.
 * @typedef {Object} ClusterResult
 * @property {ClusterHit[]} records
 */

/**
 * The LLM adjudication attached to a merge candidate by the 3A pass.
 * @typedef {Object} LlmMergeDecision
 * @property {"merge" | "keep-keeper-unchanged" | "skip" | "fallback"} action
 * @property {string} [merged_body]
 * @property {string} [keeper_id]
 * @property {string} [loser_id]
 * @property {string} [reason]
 * @property {boolean} [bandFallback]
 */

/**
 * A (keeper, loser) pair queued by a dedup pass and finalized (loser archived)
 * after the optional LLM merge pass has had a chance to rewrite the keeper.
 * @typedef {Object} MergeCandidate
 * @property {RunLeaf} keeper
 * @property {RunLeaf} loser
 * @property {string} sourcePass
 * @property {number} [score]
 * @property {boolean} [band]
 * @property {LlmMergeDecision} [llmDecision]
 */

/**
 * A per-entity outcome recorded on a pass report (`entities` on success,
 * `failures` with a redacted `excerpt` on error).
 * @typedef {Object} EntityRecord
 * @property {string} id
 * @property {string} kind
 * @property {string} action
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {string} [excerpt]
 */

/**
 * The argument bag `recordEntity` accepts. `reason`/`error` are optional; a
 * success record carries `reason`, a failure carries `error`.
 * @typedef {Object} RecordEntityArgs
 * @property {string} id
 * @property {string} kind
 * @property {string} action
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {unknown} [error]
 */

/**
 * The per-pass report accumulated across a run. `entities`/`failures` are the
 * per-entity trail; the numeric fields are the summable counts.
 * @typedef {Object} PassReport
 * @property {string} name
 * @property {number} archived
 * @property {number} touched
 * @property {number} merged
 * @property {number} refreshed
 * @property {number} flagged
 * @property {number} errors
 * @property {number} freedBytes
 * @property {number} ms
 * @property {boolean} skipped
 * @property {EntityRecord[]} entities
 * @property {EntityRecord[]} failures
 */

/**
 * The `stripPassEntities` output shape: a PassReport minus its per-entity arrays.
 * @typedef {Omit<PassReport, "entities" | "failures">} PassReportCounts
 */

/**
 * Run totals, summed across every pass.
 * @typedef {Object} ConsolidateTotals
 * @property {number} archived
 * @property {number} touched
 * @property {number} merged
 * @property {number} refreshed
 * @property {number} flagged
 * @property {number} errors
 * @property {number} freedBytes
 */

/**
 * The mutable run context threaded through every pass.
 * @typedef {Object} ConsolidateCtx
 * @property {Map<string, PassReport>} report
 * @property {Set<string>} touchedThisRun
 * @property {Set<string>} pairsSeen
 * @property {MergeCandidate[]} mergeCandidates
 * @property {string} activeBackend
 * @property {number} cosineThreshold
 * @property {number | null} cosineBandFloor
 * @property {boolean} llmEnabled
 * @property {string[]} refineCategories
 * @property {string[]} excludedCategories
 * @property {Array<{ class: string, keeperId: string, loserId: string, reason: string }>} [flaggedSkips]
 * @property {Array<{ leafId: string, archive_reason?: string, reason?: string }>} [flaggedRefreshArchives]
 */

/**
 * The self-throttle state persisted between runs.
 * @typedef {Object} ConsolidateState
 * @property {string} [last_run_utc]
 * @property {number} [durationMs]
 * @property {boolean} [dryRun]
 * @property {Record<string, PassReportCounts>} [passes]
 * @property {ConsolidateTotals} [totals]
 */

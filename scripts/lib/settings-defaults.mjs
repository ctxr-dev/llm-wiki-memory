import { DEFAULT_EMBED_MODEL } from "./settings.mjs";

/**
 * @typedef {Object} ConsolidateSection
 * @property {boolean} enabled
 * @property {number} intervalDays
 * @property {number} cosineThreshold
 * @property {number} cosineLexicalThreshold
 * @property {number | null} cosineBandFloor
 * @property {number} clusterTopK
 * @property {number} clusterScoreThreshold
 * @property {number} orphanTtlDays
 * @property {number} staleAfterMonths
 * @property {number} archiveBodyMax
 * @property {number} archiveAgeDays
 * @property {string} passes
 * @property {boolean} llmPassesEnabled
 * @property {number} llmMaxRetries
 * @property {number} refreshMaxPerRun
 * @property {number} attemptsKeep
 * @property {number} fullLogRetentionDays
 * @property {number} escalateAfterAttempts
 */

/**
 * @typedef {Object} FlushSection
 * @property {string} slot
 * @property {number} distillAttempts
 * @property {number} distillRetryMs
 * @property {number} lockStaleMs
 * @property {number} chunkTargetK
 * @property {number} chunkParallelism
 * @property {number} reduceMaxChars
 * @property {number} rawFallbackChars
 * @property {boolean} reduceModelPromote
 */

/**
 * @typedef {Object} HookSection
 * @property {number} maxTurns
 * @property {number} maxChars
 * @property {number} sessionEndMinTurns
 * @property {number} precompactMinTurns
 * @property {boolean} exitPlanModeDisable
 * @property {number} exitPlanModeMaxBytes
 */

/**
 * @typedef {Object} EmbedChunkSection
 * @property {boolean} enabled
 * @property {number} maxChunks
 * @property {number} penalty
 * @property {number} fullMaxChunks
 * @property {number} fullPenalty
 */

/**
 * @typedef {Object} EmbedSection
 * @property {string} backend
 * @property {string} model
 * @property {EmbedChunkSection} chunk
 */

/**
 * @typedef {Object} RecallSection
 * @property {number} scoreThreshold
 * @property {number} priorityBand
 * @property {number} recentActivityDays
 * @property {number} planContextMax
 * @property {number} depthBoostPerLevel
 * @property {number} depthBoostBand
 * @property {number} searchPerLevelCap
 */

/**
 * @typedef {Object} CompileSection
 * @property {string} slot
 * @property {number} searchLimit
 * @property {number} atomBodyMaxChars
 * @property {boolean} qualityStrict
 * @property {number} lockStaleMs
 * @property {number} metadataRetryLimit
 */

/**
 * @typedef {Object} GcSection
 * @property {number} intervalDays
 */

/**
 * @typedef {Object} GateSection
 * @property {boolean} selfImprovementEnabled
 * @property {boolean} claudeHookEnabled
 * @property {boolean} auditTrailEnabled
 * @property {boolean} perLessonConsent
 * @property {number} auditKeep
 */

/**
 * @typedef {Object} WikiSection
 * @property {boolean} autoCommit
 */

/**
 * A per-provider model list.
 * @typedef {Object} ProviderModels
 * @property {string[]} models
 */

/**
 * The providers section: the ordered `chain` plus one model-list entry per
 * known provider, keyed by provider name. The string index signature models the
 * dynamic `providers[name]` access the loader and dispatcher rely on.
 * @typedef {{ chain: string[], [provider: string]: ProviderModels | string[] }} ProvidersSection
 */

/**
 * The fully-resolved settings object (also the shape of the mutable working
 * `sections` object the overlay/validate passes mutate before it is frozen).
 * @typedef {Object} Settings
 * @property {ConsolidateSection} consolidate
 * @property {FlushSection} flush
 * @property {HookSection} hook
 * @property {EmbedSection} embed
 * @property {RecallSection} recall
 * @property {CompileSection} compile
 * @property {GcSection} gc
 * @property {GateSection} gate
 * @property {WikiSection} wiki
 * @property {ProvidersSection} providers
 * @property {string[]} crossCuttingAreas
 */

// The structural (code) defaults for every settings section, returned fresh on
// each call so a build never mutates a shared literal. Provider model lists ship
// EMPTY here (no model name strings in code); the real lists live in
// templates/settings.yaml. The single sanctioned model-name exception is
// DEFAULT_EMBED_MODEL, imported from settings.mjs.
export function structuralDefaults() {
  const consolidate = {
    enabled: false,
    intervalDays: 1,
    cosineThreshold: 0.97,
    cosineLexicalThreshold: 0.995,
    cosineBandFloor: null,
    clusterTopK: 12,
    clusterScoreThreshold: 0.75,
    orphanTtlDays: 365,
    staleAfterMonths: 6,
    archiveBodyMax: 1200,
    archiveAgeDays: 30,
    passes: "all",
    llmPassesEnabled: true,
    llmMaxRetries: 2,
    refreshMaxPerRun: 25,
    attemptsKeep: 50,
    fullLogRetentionDays: 90,
    escalateAfterAttempts: 3,
  };
  const flush = {
    slot: "daily",
    distillAttempts: 3,
    distillRetryMs: 3000,
    lockStaleMs: 600_000,
    chunkTargetK: 5,
    chunkParallelism: 1,
    reduceMaxChars: 30_000,
    rawFallbackChars: Number.MAX_SAFE_INTEGER,
    reduceModelPromote: true,
  };
  const hook = {
    maxTurns: 30,
    maxChars: 80_000,
    sessionEndMinTurns: 1,
    precompactMinTurns: 5,
    exitPlanModeDisable: false,
    exitPlanModeMaxBytes: 256_000,
  };
  const embed = {
    backend: "transformers",
    model: DEFAULT_EMBED_MODEL,
    // Length-aware recall: a leaf whose embed text exceeds the model's token
    // window is split into <=maxChunks windows; recall scores it by its best
    // chunk minus penalty*(chunks-1) so a long doc can't win on chunk count.
    // A FULL leaf (whole document) uncaps to fullMaxChunks and drops the penalty
    // to fullPenalty (0) so its whole body is searchable and length never hurts.
    chunk: { enabled: true, maxChunks: 6, penalty: 0.015, fullMaxChunks: 256, fullPenalty: 0 },
  };
  const recall = {
    // A small relevance FLOOR: hits below this cosine are dropped before ranking,
    // so noise-level matches (from any tree) can't be depth-boosted above a strong
    // hit or crowd the results. Small by default; tune per embedding backend.
    scoreThreshold: 0.05,
    // Cosine proximity within which priority breaks ties at recall (a relevant
    // P0/P1 orders above an equally-relevant P2). Relevance stays dominant: a
    // hit more than this far below the band leader keeps its cosine rank.
    priorityBand: 0.05,
    // SessionStart "Recently" reminder: how many recent days of daily notes to
    // surface (as brief + link). 0 disables the reminder.
    recentActivityDays: 3,
    // SessionStart plan list: max plans to surface, unfinished preferred. 0 hides plans.
    planContextMax: 2,
    // Federated read fan-out (Phase E): additive per-level ranking boost. A hit's
    // adjustedConfidence = cosine + depth * depthBoostPerLevel, so with the default
    // (>= 1 per level, exceeding the [0,1] cosine spread) a DEEPER/more-local level's
    // hits outrank a shallower one's. 0 disables the boost (pure cosine ranking).
    depthBoostPerLevel: 1,
    // The depth boost is BANDED: a hit gets its per-level boost ONLY when its cosine
    // is within depthBoostBand of the best hit for the query. So a repo hit that is
    // COMPARABLY relevant still outranks the brain (repo-preference preserved), but a
    // clearly-less-relevant deeper hit can no longer bury a strongly-relevant
    // shallower one. 0 = only exact-top-cosine hits are boosted; a large value
    // restores the old always-boost behaviour.
    depthBoostBand: 0.15,
    // Per-level cap on hits pulled from EACH tree before the fan-out merge.
    searchPerLevelCap: 20,
  };
  const compile = {
    slot: "knowledge",
    searchLimit: 5,
    atomBodyMaxChars: 700,
    qualityStrict: false,
    lockStaleMs: 1_800_000,
    metadataRetryLimit: 3,
  };
  const gc = { intervalDays: 7 };
  const gate = {
    selfImprovementEnabled: true,
    claudeHookEnabled: true,
    auditTrailEnabled: true,
    perLessonConsent: true,
    auditKeep: 1000,
  };
  const wiki = { autoCommit: true };
  const providers = {
    chain: [],
    anthropic: { models: [] },
    openai: { models: [] },
    "openai-compatible": { models: [] },
    claude: { models: [] },
    codex: { models: [] },
    cursor: { models: [] },
    mock: { models: [] },
  };
  const crossCuttingAreas = /** @type {string[]} */ ([]);

  return {
    consolidate,
    flush,
    hook,
    embed,
    recall,
    compile,
    gc,
    gate,
    wiki,
    providers,
    crossCuttingAreas,
  };
}

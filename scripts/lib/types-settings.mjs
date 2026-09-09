// The settings SHAPE: one typedef per section, plus the composed Settings object.
// Split from settings-defaults.mjs, which owns the VALUES — together they exceeded the
// 300-line module ceiling, and a shape and a default are different concerns anyway.
// JSDoc typedefs are erased at compile time, so this module has no runtime footprint.

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
 * @property {string} dtype
 * @property {number} threads
 * @property {number} maxColdPerRead
 * @property {number} warmIntervalMinutes 0 = no scheduled warm
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
 * @typedef {Object} QualitySection
 * @property {boolean} judgeEnabled
 * @property {number} maxRounds
 */

/**
 * @typedef {Object} GateSection
 * @property {boolean} enabled
 * @property {boolean} [selfImprovementEnabled] pre-rename alias for `enabled` (honoured on override)
 * @property {boolean} claudeHookEnabled
 * @property {boolean} recallFirstEnabled the L2 recall-first nudge (separate from the write gate)
 * @property {boolean} auditTrailEnabled
 * @property {boolean} perLessonConsent
 * @property {number} auditKeep
 * @property {number} maxInlineBodyBytes 0 = unlimited; see templates/settings.yaml
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
 * @typedef {Object} DedupeSection
 * @property {boolean} enabled
 * @property {number} probeThreshold below this cosine a save is silent
 * @property {number} duplicateThreshold at or above this a save is refused
 */

/**
 * @typedef {Object} DiagramsSection
 * @property {"auto" | "svg" | "mermaid"} mode
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
 * @property {QualitySection} quality
 * @property {WikiSection} wiki
 * @property {DedupeSection} dedupe
 * @property {DiagramsSection} diagrams
 * @property {ProvidersSection} providers
 * @property {string[]} crossCuttingAreas
 */

export {};

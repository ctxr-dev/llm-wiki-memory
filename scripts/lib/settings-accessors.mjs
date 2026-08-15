import { settings } from "./settings.mjs";

const DEFAULT_MAX_COLD_PER_READ = 32;
const DEFAULT_MAX_INLINE_BODY_BYTES = 32_768;

// Convenience helpers (mirror the OLD env.mjs API so the call-site refactor
// is one-line per call). Each just reads from settings().<section>.<key>.

export function consolidateEnabled() {
  return Boolean(settings().consolidate.enabled);
}
export function consolidateIntervalDays() {
  return settings().consolidate.intervalDays;
}
export function consolidateCosineThreshold() {
  return settings().consolidate.cosineThreshold;
}
export function consolidateCosineLexicalThreshold() {
  return settings().consolidate.cosineLexicalThreshold;
}
export function consolidateCosineBandFloor() {
  return settings().consolidate.cosineBandFloor;
}
export function consolidateClusterTopK() {
  return settings().consolidate.clusterTopK;
}
export function consolidateClusterScoreThreshold() {
  return settings().consolidate.clusterScoreThreshold;
}
export function consolidateOrphanTtlDays() {
  return settings().consolidate.orphanTtlDays;
}
export function consolidateStaleAfterMonths() {
  return settings().consolidate.staleAfterMonths;
}
export function consolidateArchiveBodyMax() {
  return settings().consolidate.archiveBodyMax;
}
export function consolidateArchiveAgeDays() {
  return settings().consolidate.archiveAgeDays;
}
export function consolidatePassesEnv() {
  return settings().consolidate.passes || "all";
}
export function consolidateLlmPassesEnabled() {
  return Boolean(settings().consolidate.llmPassesEnabled);
}
export function consolidateLlmMaxRetries() {
  return settings().consolidate.llmMaxRetries;
}
export function consolidateRefreshMaxPerRun() {
  return settings().consolidate.refreshMaxPerRun;
}
export function consolidateAttemptsKeep() {
  return settings().consolidate.attemptsKeep;
}
export function consolidateFullLogRetentionDays() {
  return settings().consolidate.fullLogRetentionDays;
}
export function consolidateEscalateAfterAttempts() {
  return settings().consolidate.escalateAfterAttempts;
}

export function flushChunkTargetK() {
  return settings().flush.chunkTargetK;
}
export function flushChunkParallelism() {
  return settings().flush.chunkParallelism;
}
export function flushReduceMaxChars() {
  return settings().flush.reduceMaxChars;
}
export function flushRawFallbackChars() {
  return settings().flush.rawFallbackChars;
}
export function flushDistillAttempts() {
  return settings().flush.distillAttempts;
}
export function flushDistillRetryMs() {
  return settings().flush.distillRetryMs;
}
export function flushLockStaleMs() {
  return settings().flush.lockStaleMs;
}
export function flushSlotName() {
  return settings().flush.slot;
}

export function hookMaxTurns() {
  return settings().hook.maxTurns;
}
export function hookMaxChars() {
  return settings().hook.maxChars;
}
export function hookSessionEndMinTurns() {
  return settings().hook.sessionEndMinTurns;
}
export function hookPrecompactMinTurns() {
  return settings().hook.precompactMinTurns;
}
export function hookExitPlanModeDisable() {
  return Boolean(settings().hook.exitPlanModeDisable);
}
export function hookExitPlanModeMaxBytes() {
  return settings().hook.exitPlanModeMaxBytes;
}

export function embedBackend() {
  return settings().embed.backend;
}
export function embedModel() {
  return settings().embed.model;
}
export function embedDtype() {
  return settings().embed.dtype;
}
export function embedThreads() {
  return settings().embed.threads;
}
// Only a literal 0 means "no bound". Anything malformed falls back to the default
// rather than to Infinity — failing OPEN here would silently remove the very
// protection that keeps one request from cold-embedding a whole corpus.
export function embedMaxColdPerRead() {
  const configured = settings().embed.maxColdPerRead;
  if (configured === 0) return Infinity;
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_COLD_PER_READ;
}
export function embedWarmIntervalMinutes() {
  return settings().embed.warmIntervalMinutes;
}
/** @returns {import("./settings-defaults.mjs").EmbedChunkSection} */
export function embedChunk() {
  return settings().embed.chunk;
}

export function recallScoreThreshold() {
  return settings().recall.scoreThreshold;
}
export function recallPriorityBand() {
  return settings().recall.priorityBand;
}
export function recallRecentActivityDays() {
  return settings().recall.recentActivityDays;
}
export function recallPlanContextMax() {
  return settings().recall.planContextMax;
}
export function recallDepthBoostPerLevel() {
  return settings().recall.depthBoostPerLevel;
}
export function recallDepthBoostBand() {
  return settings().recall.depthBoostBand;
}
export function recallSearchPerLevelCap() {
  return settings().recall.searchPerLevelCap;
}

export function compileSlot() {
  return settings().compile.slot;
}
export function compileSearchLimit() {
  return settings().compile.searchLimit;
}
export function atomBodyMaxChars() {
  return settings().compile.atomBodyMaxChars;
}
export function compileQualityStrict() {
  return Boolean(settings().compile.qualityStrict);
}
export function compileLockStaleMs() {
  return settings().compile.lockStaleMs;
}
export function compileMetadataRetryLimit() {
  return settings().compile.metadataRetryLimit;
}

export function gcIntervalDays() {
  return settings().gc.intervalDays;
}
export function qualityJudgeEnabled() {
  return Boolean(settings().quality.judgeEnabled);
}
export function qualityMaxRounds() {
  return settings().quality.maxRounds;
}
// The write-gate master switch. `gate.enabled` is canonical (governs every
// layout-gated category); `gate.selfImprovementEnabled` is the pre-rename ALIAS.
// The YAML overlay maps the alias onto `gate.enabled`, but a process/test
// OVERRIDE (deepMerged post-overlay) may still set the old key — so honour BOTH
// here, fail-CLOSED: the gate is ON unless EITHER is explicitly false.
export function writeGateEnabled() {
  const g = settings().gate;
  return !(g.enabled === false || g.selfImprovementEnabled === false);
}
export function writeGateClaudeHookEnabled() {
  return Boolean(settings().gate.claudeHookEnabled);
}

// Separate from claudeHookEnabled on purpose: silencing the recall nudge must not also disable
// the write gate, which is the safety-critical hook.
export function recallFirstHookEnabled() {
  return Boolean(settings().gate.recallFirstEnabled);
}
export function writeGateAuditTrailEnabled() {
  return Boolean(settings().gate.auditTrailEnabled);
}
export function writeGatePerLessonConsent() {
  return Boolean(settings().gate.perLessonConsent);
}
export function writeGateAuditKeep() {
  return settings().gate.auditKeep;
}
// The inline-body byte cap for an MCP write. INDEPENDENT of `gate.enabled` (that
// flag is about user CONSENT; this is a token/latency bound). Only a literal 0
// means "no cap"; anything malformed falls back to the default rather than to
// Infinity, so a typo can never silently remove the bound.
export function writeGateMaxInlineBodyBytes() {
  const configured = settings().gate.maxInlineBodyBytes;
  if (configured === 0) return Infinity;
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_INLINE_BODY_BYTES;
}
export function wikiAutoCommit() {
  return Boolean(settings().wiki.autoCommit);
}
export function crossCuttingAreas() {
  return settings().crossCuttingAreas;
}

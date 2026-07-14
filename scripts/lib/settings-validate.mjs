import { DEFAULT_EMBED_MODEL } from "./settings.mjs";
import {
  coercePos,
  coerceNonNeg,
  coerceFloat01,
  coerceBandFloor,
  coerceBool,
} from "./settings-coerce.mjs";

// Validate EVERY numeric / float / bool field defensively. A YAML knob set
// to a string, null, or NaN must NOT flow through to the runtime — the
// worst case is catastrophic: a string/empty consolidate.cosineThreshold
// coerces to `score >= 0` in the dedup comparison and archives every
// cluster member. So each typed field falls back to its structural default
// when the YAML value isn't the right shape. This replaces the per-knob
// envInt/envFloat/envBool validation the old env.mjs path provided.
//
// posInt: finite, > 0. nonNegInt: finite, >= 0 (0 = "disabled" for the
// interval knobs). float01: finite, in [0, 1]. bool: a real boolean (a
// string like "false" would otherwise be truthy at the Boolean() accessor).
/**
 * @param {import("./settings-defaults.mjs").Settings} sections
 * @returns {void}
 */
export function coerceSections(sections) {
  const { consolidate, flush, hook, embed, recall, compile, gc, gate, wiki } = sections;

  consolidate.intervalDays = coerceNonNeg(consolidate.intervalDays, 1);
  consolidate.cosineThreshold = coerceFloat01(consolidate.cosineThreshold, 0.97);
  consolidate.cosineLexicalThreshold = coerceFloat01(consolidate.cosineLexicalThreshold, 0.995);
  consolidate.cosineBandFloor = coerceBandFloor(
    consolidate.cosineBandFloor,
    consolidate.cosineThreshold,
  );
  consolidate.clusterTopK = coercePos(consolidate.clusterTopK, 12);
  consolidate.clusterScoreThreshold = coerceFloat01(consolidate.clusterScoreThreshold, 0.75);
  consolidate.orphanTtlDays = coercePos(consolidate.orphanTtlDays, 365);
  consolidate.staleAfterMonths = coercePos(consolidate.staleAfterMonths, 6);
  consolidate.archiveBodyMax = coercePos(consolidate.archiveBodyMax, 1200);
  consolidate.archiveAgeDays = coercePos(consolidate.archiveAgeDays, 30);
  consolidate.llmMaxRetries = coerceNonNeg(consolidate.llmMaxRetries, 2);
  consolidate.refreshMaxPerRun = coercePos(consolidate.refreshMaxPerRun, 25);
  consolidate.attemptsKeep = coercePos(consolidate.attemptsKeep, 50);
  consolidate.fullLogRetentionDays = coercePos(consolidate.fullLogRetentionDays, 90);
  consolidate.escalateAfterAttempts = coercePos(consolidate.escalateAfterAttempts, 3);
  consolidate.llmPassesEnabled = coerceBool(consolidate.llmPassesEnabled, true);
  consolidate.enabled = coerceBool(consolidate.enabled, false);
  if (typeof consolidate.passes !== "string") consolidate.passes = "all";

  flush.chunkTargetK = coercePos(flush.chunkTargetK, 5);
  flush.chunkParallelism = coercePos(flush.chunkParallelism, 1);
  flush.reduceMaxChars = coercePos(flush.reduceMaxChars, 30_000);
  flush.distillAttempts = coercePos(flush.distillAttempts, 3);
  flush.distillRetryMs = coercePos(flush.distillRetryMs, 3000);
  flush.lockStaleMs = coercePos(flush.lockStaleMs, 600_000);
  flush.rawFallbackChars = coercePos(flush.rawFallbackChars, Number.MAX_SAFE_INTEGER);
  flush.reduceModelPromote = coerceBool(flush.reduceModelPromote, true);
  if (typeof flush.slot !== "string") flush.slot = "daily";

  hook.maxTurns = coercePos(hook.maxTurns, 30);
  hook.maxChars = coercePos(hook.maxChars, 80_000);
  hook.sessionEndMinTurns = coercePos(hook.sessionEndMinTurns, 1);
  hook.precompactMinTurns = coercePos(hook.precompactMinTurns, 5);
  hook.exitPlanModeMaxBytes = coercePos(hook.exitPlanModeMaxBytes, 256_000);
  hook.exitPlanModeDisable = coerceBool(hook.exitPlanModeDisable, false);

  if (typeof embed.backend !== "string") embed.backend = "transformers";
  if (typeof embed.model !== "string") embed.model = DEFAULT_EMBED_MODEL;

  recall.scoreThreshold = coerceFloat01(recall.scoreThreshold, 0.05);
  recall.priorityBand = coerceFloat01(recall.priorityBand, 0.05);
  recall.recentActivityDays = coerceNonNeg(recall.recentActivityDays, 3);
  recall.planContextMax = coerceNonNeg(recall.planContextMax, 2);
  // 0 is a valid depthBoostPerLevel (disables the boost -> pure cosine ranking).
  recall.depthBoostPerLevel = coerceNonNeg(recall.depthBoostPerLevel, 1);
  recall.depthBoostBand = coerceFloat01(recall.depthBoostBand, 0.15);
  recall.searchPerLevelCap = coercePos(recall.searchPerLevelCap, 20);

  if (typeof compile.slot !== "string") compile.slot = "knowledge";
  compile.searchLimit = coercePos(compile.searchLimit, 5);
  compile.atomBodyMaxChars = coercePos(compile.atomBodyMaxChars, 700);
  compile.lockStaleMs = coercePos(compile.lockStaleMs, 1_800_000);
  compile.metadataRetryLimit = coercePos(compile.metadataRetryLimit, 3);
  compile.qualityStrict = coerceBool(compile.qualityStrict, false);

  gc.intervalDays = coerceNonNeg(gc.intervalDays, 7);
  gate.selfImprovementEnabled = coerceBool(gate.selfImprovementEnabled, true);
  gate.claudeHookEnabled = coerceBool(gate.claudeHookEnabled, true);
  gate.auditTrailEnabled = coerceBool(gate.auditTrailEnabled, true);
  gate.perLessonConsent = coerceBool(gate.perLessonConsent, true);
  gate.auditKeep = coercePos(gate.auditKeep, 1000);
  wiki.autoCommit = coerceBool(wiki.autoCommit, true);
}

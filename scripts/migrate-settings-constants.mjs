const STRICT_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_MODEL",
  "OPENAI_MODEL",
  "MEMORY_LLM_PROVIDER",
  "MEMORY_LLM_MODEL",
  "MEMORY_LLM_BASE_URL",
  "MEMORY_LLM_TIMEOUT_MS",
  "MEMORY_DATA_DIR",
  "LLM_WIKI_MEMORY_ROOT",
  "MEMORY_SETTINGS_PATH",
  "MEMORY_EMBED_CACHE",
  "MEMORY_EMBED_CACHE_DIR",
  "MEMORY_DEFAULT_PROJECT_MODULE",
  "LLM_WIKI_MEMORY_PROJECT",
  "MEMORY_LLM_MOCK_RESPONSE",
  "MEMORY_LLM_MOCK_FILE",
  "MEMORY_LLM_MOCK_FAIL_INDICES",
  "MEMORY_LLM_MOCK_FAIL_ERROR",
  "MEMORY_MCP_SERVER_NAME",
]);

// Env vars renamed in the v2 release: the migrator copies their old value
// to the new name when only the old name is set, so an upgrade preserves
// the user's choice.
const RENAMED_KEYS = {
  MEMORY_LLM_CONFIG_PATH: "MEMORY_SETTINGS_PATH",
};

// Old env var → settings.yaml dotted path. When the old value's range or
// type isn't trivially compatible (e.g. CSV → list) the migrate function
// handles it inline.
const ENV_TO_SETTINGS = {
  MEMORY_CONSOLIDATE_ENABLED: "consolidate.enabled",
  MEMORY_CONSOLIDATE_INTERVAL_DAYS: "consolidate.intervalDays",
  MEMORY_CONSOLIDATE_COSINE_THRESHOLD: "consolidate.cosineThreshold",
  MEMORY_CONSOLIDATE_COSINE_LEXICAL_THRESHOLD: "consolidate.cosineLexicalThreshold",
  MEMORY_CONSOLIDATE_CLUSTER_TOP_K: "consolidate.clusterTopK",
  MEMORY_CONSOLIDATE_CLUSTER_SCORE_THRESHOLD: "consolidate.clusterScoreThreshold",
  MEMORY_CONSOLIDATE_ORPHAN_TTL_DAYS: "consolidate.orphanTtlDays",
  MEMORY_CONSOLIDATE_STALE_AFTER_MONTHS: "consolidate.staleAfterMonths",
  MEMORY_CONSOLIDATE_ARCHIVE_BODY_MAX: "consolidate.archiveBodyMax",
  MEMORY_CONSOLIDATE_ARCHIVE_AGE_DAYS: "consolidate.archiveAgeDays",
  MEMORY_CONSOLIDATE_PASSES: "consolidate.passes",
  MEMORY_CONSOLIDATE_LLM_PASSES: "consolidate.llmPassesEnabled",
  MEMORY_CONSOLIDATE_LLM_MAX_RETRIES: "consolidate.llmMaxRetries",
  MEMORY_CONSOLIDATE_REFRESH_MAX_PER_RUN: "consolidate.refreshMaxPerRun",

  MEMORY_FLUSH_SLOT: "flush.slot",
  MEMORY_FLUSH_DISTILL_ATTEMPTS: "flush.distillAttempts",
  MEMORY_FLUSH_DISTILL_RETRY_MS: "flush.distillRetryMs",
  MEMORY_FLUSH_LOCK_STALE_MS: "flush.lockStaleMs",
  MEMORY_FLUSH_CHUNK_TARGET_K: "flush.chunkTargetK",
  MEMORY_FLUSH_CHUNK_PARALLELISM: "flush.chunkParallelism",
  MEMORY_FLUSH_REDUCE_MAX_CHARS: "flush.reduceMaxChars",
  MEMORY_FLUSH_RAW_FALLBACK_CHARS: "flush.rawFallbackChars",

  MEMORY_HOOK_MAX_TURNS: "hook.maxTurns",
  MEMORY_HOOK_MAX_CHARS: "hook.maxChars",
  MEMORY_HOOK_SESSION_END_MIN_TURNS: "hook.sessionEndMinTurns",
  MEMORY_HOOK_PRECOMPACT_MIN_TURNS: "hook.precompactMinTurns",
  MEMORY_HOOK_EXITPLANMODE_DISABLE: "hook.exitPlanModeDisable",
  MEMORY_HOOK_EXITPLANMODE_MAX_BYTES: "hook.exitPlanModeMaxBytes",

  MEMORY_EMBED_BACKEND: "embed.backend",
  MEMORY_EMBED_MODEL: "embed.model",

  MEMORY_RECALL_SCORE_THRESHOLD: "recall.scoreThreshold",

  MEMORY_COMPILE_SLOT: "compile.slot",
  MEMORY_COMPILE_SEARCH_LIMIT: "compile.searchLimit",
  MEMORY_ATOM_BODY_MAX_CHARS: "compile.atomBodyMaxChars",
  MEMORY_COMPILE_QUALITY_STRICT: "compile.qualityStrict",
  MEMORY_COMPILE_LOCK_STALE_MS: "compile.lockStaleMs",
  MEMORY_COMPILE_METADATA_RETRY_LIMIT: "compile.metadataRetryLimit",

  MEMORY_GC_INTERVAL_DAYS: "gc.intervalDays",

  MEMORY_WRITE_GATE_SELF_IMPROVEMENT: "gate.selfImprovementEnabled",

  MEMORY_CROSS_CUTTING_AREAS: "crossCuttingAreas",
};

const BOOL_KEYS = new Set([
  "consolidate.enabled",
  "consolidate.llmPassesEnabled",
  "hook.exitPlanModeDisable",
  "compile.qualityStrict",
  "gate.selfImprovementEnabled",
]);

const FLOAT_KEYS = new Set([
  "consolidate.cosineThreshold",
  "consolidate.cosineLexicalThreshold",
  "consolidate.clusterScoreThreshold",
  "recall.scoreThreshold",
]);

export { STRICT_KEYS, RENAMED_KEYS, ENV_TO_SETTINGS, BOOL_KEYS, FLOAT_KEYS };

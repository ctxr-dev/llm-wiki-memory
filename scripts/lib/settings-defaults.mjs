import { DEFAULT_EMBED_MODEL } from "./settings.mjs";

// The section typedefs live in types-settings.mjs. Only the three referenced from other
// modules are re-aliased here, so existing `import("./settings-defaults.mjs").X` references
// keep resolving without touching their 12 call sites.
/** @typedef {import("./types-settings.mjs").Settings} Settings */
/** @typedef {import("./types-settings.mjs").ProviderModels} ProviderModels */
/** @typedef {import("./types-settings.mjs").EmbedChunkSection} EmbedChunkSection */

// The structural (code) defaults for every settings section, returned fresh on
// each call so a build never mutates a shared literal. Provider model lists ship
// EMPTY here (no model name strings in code); the real lists live in
// templates/settings.yaml. The single sanctioned model-name exception is
// DEFAULT_EMBED_MODEL, imported from settings.mjs.
export function structuralDefaults() {
  const consolidate = {
    enabled: false,
    intervalDays: 1,
    // Empirically remapped for EmbeddingGemma (2026-07-28): true near-duplicates
    // scored >=0.9925, the highest non-duplicate pair <0.956 on a 537-leaf corpus.
    cosineThreshold: 0.975,
    cosineLexicalThreshold: 0.995,
    cosineBandFloor: null,
    clusterTopK: 12,
    clusterScoreThreshold: 0.7,
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
    exitPlanModeMaxBytes: 1_048_576,
  };
  const embed = {
    backend: "transformers",
    model: DEFAULT_EMBED_MODEL,
    // "" resolves per model family (EmbeddingGemma: q4, classic BERT-family: q8).
    dtype: "",
    // onnxruntime intra-op threads per forward pass; 0 = ORT default (all cores).
    // 2 keeps a background warm at roughly 200% CPU — slower, but it leaves the
    // machine usable, which matters more than warm throughput.
    threads: 2,
    // Most leaves ONE read may cold-embed before it stops and leaves the rest to
    // the background warm. Bounds worst-case search latency on a cold/partial
    // cache (a whole category inline used to stall a request for minutes).
    // 0 = unlimited (pre-budget behaviour).
    maxColdPerRead: 32,
    // How often a scheduler (the hourly cron, the webapp timer) may re-run the
    // gradual warm for a given wiki. Without it, warming happened once at webapp
    // boot, so a leaf saved afterwards stayed cold until a restart — and an
    // MCP-only install never warmed at all. 0 = no scheduled warm.
    warmIntervalMinutes: 30,
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
    // EmbeddingGemma's unrelated-pair cosines sit near 0.14 (bge's sat near 0.05),
    // so the noise floor moves with the model (quantile-equivalent ~0.139).
    scoreThreshold: 0.12,
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
  // The judge-in-the-loop quality gate (see scripts/lib/quality-loop.mjs).
  // judgeEnabled fails CLOSED like the write-gate flags: a persistently-down
  // judge halts generation rather than saving unverified leaves; set false only
  // for offline/CI/bulk-import. maxRounds bounds the generate->judge->revise loop.
  const quality = { judgeEnabled: true, maxRounds: 3 };
  const gate = {
    enabled: true,
    claudeHookEnabled: true,
    recallFirstEnabled: true,
    auditTrailEnabled: true,
    perLessonConsent: true,
    auditKeep: 1000,
    maxInlineBodyBytes: 32_768,
  };
  const wiki = { autoCommit: true };
  // Write-time duplicate detection. Thresholds are the SAME calibrated numbers
  // consolidate already uses (see the consolidate block above, remapped for
  // EmbeddingGemma on a 537-leaf corpus: true near-duplicates scored >= 0.9925,
  // the closest non-duplicate pair < 0.956). Reusing them keeps one definition of
  // "these are the same note" across the write path and the offline pass.
  //
  // `probeThreshold` is the floor for "worth mentioning"; below it a save is
  // silent. `duplicateThreshold` is the ceiling for "almost certainly the same
  // leaf"; at or above it a save is REFUSED and names the existing leaf, unless
  // the caller asserts a new leaf is intended. enabled:false skips the probe
  // entirely (one embedding plus one category scan per write).
  const dedupe = {
    enabled: true,
    probeThreshold: 0.7,
    duplicateThreshold: 0.975,
  };
  // Which diagram form an agent should reach for. `auto` means the agent decides
  // per the diagram rule (inline SVG for a wiki leaf, mermaid for a non-wiki
  // surface or a trivial diagram); the other two force one form. Surfaced through
  // get_memory_config, because a setting no agent can read instructs nobody.
  const diagrams = { mode: /** @type {"auto" | "svg" | "mermaid"} */ ("auto") };
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
    quality,
    gate,
    wiki,
    dedupe,
    diagrams,
    providers,
    crossCuttingAreas,
  };
}

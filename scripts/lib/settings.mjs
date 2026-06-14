import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { parse as parseYaml } from "yaml";
import { MEMORY_DIR, MEMORY_DATA_DIR, envValue } from "./env.mjs";

// Canonical settings loader. Reads <data>/settings/settings.yaml (the
// operator-edited file) and falls back to the shipped templates/settings.yaml
// when no user file exists. Cached at module scope with an mtime check on
// every access so a hot-edit to the YAML invalidates without restart.
//
// The ONLY env vars that affect the returned settings are the strict subset
// declared in .env (provider switches + paths + identity + secrets). Every
// other MEMORY_* env var is silently IGNORED — application config lives in
// the YAML, period. This is a deliberate breaking change from earlier
// versions; see docs/releases/2026/06/03/v2/update-prompt.md for the
// migration runbook.

const TEMPLATE_PATH = path.join(MEMORY_DIR, "templates", "settings.yaml");

export const KNOWN_PROVIDERS = ["mock", "anthropic", "openai", "openai-compatible", "claude", "codex", "cursor"];
const CLI_PROVIDERS = new Set(["claude", "codex", "cursor"]);
const API_PROVIDERS = new Set(["anthropic", "openai", "openai-compatible"]);

// Structural fallback when settings.yaml lacks embed.model (a broken template).
// The canonical default ships in templates/settings.yaml; this is the one model
// name that legitimately lives in code, because it backstops a missing config
// rather than being a swappable provider/model choice.
export const DEFAULT_EMBED_MODEL = "Xenova/bge-large-en-v1.5";

// Structural-only fallback (no model name strings here). The provider chain
// priority IS a structural choice — it controls auto-detect ORDER, not which
// specific models are tried.
const STRUCTURAL_PROVIDER_ORDER = Object.freeze(["anthropic", "openai", "claude", "codex", "cursor"]);

// ---- Cached singleton + override surface ----

let cached = null;                 // { path, mtimeMs, envKey, settings }
let globalOverride = null;         // process-level override (tests, CLI one-shot)
const overrideStorage = new AsyncLocalStorage();  // per-async-context override

// Push a process-level settings override. Used by tests (before/after pairs)
// AND by one-shot CLI flags (e.g. `consolidate --cosine-threshold=0.9` in
// cli.mjs). The `__set/__clearSettingsForTest` names are kept as aliases for
// test files already written against them.
//
// For CONCURRENT-SAFE overrides (e.g. an MCP server handling parallel tool
// calls that each want their own cosineThreshold), use `withSettingsOverride`
// instead — it scopes the override to an AsyncLocalStorage frame so two
// in-flight callers don't trample each other.
export function __setSettingsOverride(overrides) {
  globalOverride = overrides && typeof overrides === "object" ? overrides : null;
  cached = null;
}
export function __clearSettingsOverride() {
  globalOverride = null;
  cached = null;
}
export const __setSettingsForTest = __setSettingsOverride;
export const __clearSettingsForTest = __clearSettingsOverride;

// Run `fn` inside an async frame where `settings()` deep-merges `overrides`
// on top of the YAML. Concurrent calls each see their own override; the
// frame disappears when fn resolves/rejects. Preferred over the global seam
// for production code paths that handle parallel work.
export function withSettingsOverride(overrides, fn) {
  return overrideStorage.run(overrides || null, fn);
}

// Internal: the override that should be applied to THIS call's settings.
// AsyncLocalStorage frame wins over the global seam — the frame is the
// concurrent-safe surface; the global is the fallback for one-shot tools
// and tests.
function activeOverride() {
  return overrideStorage.getStore() || globalOverride || null;
}

// ---- Path resolution ----

export function settingsPath() {
  const configured = envValue("MEMORY_SETTINGS_PATH", "");
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(MEMORY_DATA_DIR, configured);
  }
  return path.join(MEMORY_DATA_DIR, "settings", "settings.yaml");
}

// ---- YAML helpers ----

// Parse a YAML file. Returns { ok, value } | { ok: false, error }. Never
// throws on a parse error (the caller decides whether a bad file is fatal).
function parseYamlFile(p) {
  if (!fs.existsSync(p)) return { ok: true, value: null };
  try {
    return { ok: true, value: parseYaml(fs.readFileSync(p, "utf8")) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function readEffectiveYaml(file) {
  const user = parseYamlFile(file);
  if (!user.ok) {
    // A malformed USER settings.yaml (a hand-edit typo, or a crash-truncated
    // write) must NOT take down the whole memory system — every flush, recall,
    // compile, and cron tick reads settings(). Warn loudly and fall back to
    // the shipped template so the system stays UP on safe defaults; the
    // operator sees the path to fix (or restore from .env.bak). Throwing here
    // would crash every hook + the MCP server until the file is hand-repaired.
    process.stderr.write(
      `[llm-wiki-memory] WARNING: settings file ${file} is malformed ` +
        `(${user.error?.message || user.error}); falling back to shipped defaults. ` +
        `Fix the YAML to re-apply your configuration.\n`,
    );
  } else if (user.value) {
    return user.value;
  }
  // Fall back to the shipped template. If the TEMPLATE is malformed, that's a
  // packaging bug, not an operator error — fail loudly.
  const tmpl = parseYamlFile(TEMPLATE_PATH);
  if (!tmpl.ok) {
    throw new Error(`settings: shipped template ${TEMPLATE_PATH} failed to parse: ${tmpl.error?.message || tmpl.error}`);
  }
  return tmpl.value;
}

// ---- Strict-subset env overlays ----

function envHasAnthropicKey() {
  return Boolean(envValue("ANTHROPIC_API_KEY", "").trim());
}
function envHasOpenAiKey() {
  return Boolean(envValue("OPENAI_API_KEY", "").trim()) || Boolean(envValue("MEMORY_LLM_BASE_URL", "").trim());
}

export function detectAvailableProviders({ cmdProbe } = {}) {
  const probe = typeof cmdProbe === "function" ? cmdProbe : null;
  const out = new Set();
  if (envHasAnthropicKey()) out.add("anthropic");
  if (envHasOpenAiKey()) {
    out.add("openai");
    out.add("openai-compatible");
  }
  if (probe) {
    if (probe("claude")) out.add("claude");
    if (probe("codex")) out.add("codex");
    if (probe("cursor-agent")) out.add("cursor");
  } else {
    out.add("claude");
    out.add("codex");
    out.add("cursor");
  }
  return out;
}

// ---- Normalisers ----

function normaliseModels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => String(m || "").trim()).filter(Boolean);
}

function normaliseChain(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    const name = String(entry || "").trim().toLowerCase();
    if (!name || !KNOWN_PROVIDERS.includes(name)) continue;
    if (out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

// Strict numeric parse for YAML-sourced fields. Accepts a real finite number
// or a NON-EMPTY fully-numeric string; rejects null / "" / "  " / arrays /
// objects / booleans / "high". CRITICAL: `Number("")`, `Number(null)`, and
// `Number([])` all return 0 — which would pass a [0,1] range check and silently
// produce a catastrophic `cosineThreshold: 0` (the dedup pass then archives
// every cluster member). So we must reject those BEFORE any range test.
function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Defensive coercion for YAML-sourced typed fields. Each returns the value
// when it's the right shape, else the supplied structural default.
function coercePos(v, def) {
  const n = toNumber(v);
  return n !== null && n > 0 ? n : def;
}
function coerceNonNeg(v, def) {
  const n = toNumber(v);
  return n !== null && n >= 0 ? n : def;
}
function coerceFloat01(v, def) {
  const n = toNumber(v);
  return n !== null && n >= 0 && n <= 1 ? n : def;
}

// Band floor for the LLM-only merge band. null/0/absent disables the band;
// anything outside [0.8, threshold) also disables it (fail-safe OFF — a low
// floor must never silently widen the deterministic-archive surface).
function coerceBandFloor(v, threshold) {
  const n = toNumber(v);
  if (n === null || n <= 0) return null;
  if (n < 0.8 || n >= threshold) return null;
  return n;
}
function coerceBool(v, def) {
  if (typeof v === "boolean") return v;
  return def;
}

function deepMerge(into, on) {
  if (!on || typeof on !== "object") return into;
  for (const [k, v] of Object.entries(on)) {
    if (v && typeof v === "object" && !Array.isArray(v) && into[k] && typeof into[k] === "object" && !Array.isArray(into[k])) {
      into[k] = deepMerge({ ...into[k] }, v);
    } else {
      into[k] = v;
    }
  }
  return into;
}

// ---- Build the settings object ----

function buildSettings({ configPath, cmdProbe } = {}) {
  const file = configPath || settingsPath();
  const raw = readEffectiveYaml(file) || {};

  const consolidate = {
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
  };
  const recall = {
    scoreThreshold: 0,
    touchEnabled: true,
    touchMinHours: 24,
    // Cosine proximity within which priority breaks ties at recall (a relevant
    // P0/P1 orders above an equally-relevant P2). Relevance stays dominant: a
    // hit more than this far below the band leader keeps its cosine rank.
    priorityBand: 0.05,
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
  let crossCuttingAreas = [];

  // Apply YAML values on top of structural defaults.
  if (raw.consolidate) {
    for (const k of Object.keys(consolidate)) {
      if (raw.consolidate[k] !== undefined) consolidate[k] = raw.consolidate[k];
    }
  }
  if (raw.flush) {
    for (const k of Object.keys(flush)) {
      if (raw.flush[k] !== undefined) flush[k] = raw.flush[k];
    }
  }
  if (raw.hook) {
    for (const k of Object.keys(hook)) {
      if (raw.hook[k] !== undefined) hook[k] = raw.hook[k];
    }
  }
  if (raw.embed) {
    for (const k of Object.keys(embed)) {
      if (raw.embed[k] !== undefined) embed[k] = raw.embed[k];
    }
  }
  if (raw.recall) {
    for (const k of Object.keys(recall)) {
      if (raw.recall[k] !== undefined) recall[k] = raw.recall[k];
    }
  }
  if (raw.compile) {
    for (const k of Object.keys(compile)) {
      if (raw.compile[k] !== undefined) compile[k] = raw.compile[k];
    }
  }
  if (raw.gc && raw.gc.intervalDays !== undefined) gc.intervalDays = raw.gc.intervalDays;
  if (raw.gate && raw.gate.selfImprovementEnabled !== undefined) {
    // Copy the raw value through UNCOERCED and let coerceBool(..., true) below
    // finalise it. Do NOT Boolean()-coerce here: Boolean(null) is a real
    // `false` that coerceBool then accepts, so an empty / commented-out /
    // null `selfImprovementEnabled:` in settings.yaml would silently DISABLE
    // the write-gate (fail-open). Passing null through makes coerceBool fall
    // back to the safe default (true), while an explicit `false` still
    // disables. The write-gate must fail CLOSED.
    gate.selfImprovementEnabled = raw.gate.selfImprovementEnabled;
  }
  if (raw.gate && raw.gate.claudeHookEnabled !== undefined) {
    // Same fail-closed rule as selfImprovementEnabled above: pass the raw
    // value through uncoerced so null/empty falls back to the safe default
    // (true) in the coerceBool below, while an explicit false still disables.
    gate.claudeHookEnabled = raw.gate.claudeHookEnabled;
  }
  if (raw.gate && raw.gate.auditTrailEnabled !== undefined) {
    // Fail-closed like the gate flags above: pass the raw value uncoerced so a
    // null/empty value falls back to the safe default (true) in coerceBool below.
    gate.auditTrailEnabled = raw.gate.auditTrailEnabled;
  }
  if (raw.gate && raw.gate.perLessonConsent !== undefined) {
    // Same fail-closed rule: a null/empty value keeps per-lesson consent ON.
    gate.perLessonConsent = raw.gate.perLessonConsent;
  }
  if (raw.gate && raw.gate.auditKeep !== undefined) {
    gate.auditKeep = raw.gate.auditKeep;
  }
  if (raw.wiki && raw.wiki.autoCommit !== undefined) {
    wiki.autoCommit = raw.wiki.autoCommit;
  }
  if (raw.providers && typeof raw.providers === "object") {
    const rp = raw.providers;
    for (const name of KNOWN_PROVIDERS) {
      const entry = rp[name];
      if (entry && Array.isArray(entry.models)) {
        providers[name] = { models: normaliseModels(entry.models) };
      }
    }
    if (Array.isArray(rp.chain)) providers.chain = normaliseChain(rp.chain);
  }
  if (Array.isArray(raw.crossCuttingAreas)) {
    crossCuttingAreas = raw.crossCuttingAreas.map((s) => String(s || "").trim()).filter(Boolean);
  } else if (typeof raw.crossCuttingAreas === "string") {
    crossCuttingAreas = raw.crossCuttingAreas.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // Auto-detect providers chain when YAML supplies an empty (or missing) list.
  if (!providers.chain.length) {
    const available = detectAvailableProviders({ cmdProbe });
    providers.chain = STRUCTURAL_PROVIDER_ORDER.filter((p) => available.has(p));
  }

  // Strict-subset env overlay (provider + model). MEMORY_LLM_PROVIDER
  // collapses the chain; MEMORY_LLM_MODEL prepends to the head provider's
  // model list.
  const envProvider = envValue("MEMORY_LLM_PROVIDER", "").trim().toLowerCase();
  if (envProvider && KNOWN_PROVIDERS.includes(envProvider)) {
    providers.chain = [envProvider];
  }
  const envModel = envValue("MEMORY_LLM_MODEL", "").trim();
  if (envModel) {
    const head = providers.chain[0];
    if (head) {
      const existing = providers[head]?.models || [];
      providers[head] = { models: [envModel, ...existing.filter((m) => m !== envModel)] };
    }
  }

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
  consolidate.intervalDays = coerceNonNeg(consolidate.intervalDays, 1);
  consolidate.cosineThreshold = coerceFloat01(consolidate.cosineThreshold, 0.97);
  consolidate.cosineLexicalThreshold = coerceFloat01(consolidate.cosineLexicalThreshold, 0.995);
  consolidate.cosineBandFloor = coerceBandFloor(consolidate.cosineBandFloor, consolidate.cosineThreshold);
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

  recall.scoreThreshold = coerceFloat01(recall.scoreThreshold, 0);
  recall.touchMinHours = coercePos(recall.touchMinHours, 24);
  recall.touchEnabled = coerceBool(recall.touchEnabled, true);
  recall.priorityBand = coerceFloat01(recall.priorityBand, 0.05);

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

  const built = {
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

  // Override overlay (last; wins over file + env). AsyncLocalStorage frame
  // takes priority over the global seam — see activeOverride().
  const override = activeOverride();
  if (override) deepMerge(built, override);

  return Object.freeze({
    consolidate: Object.freeze(built.consolidate),
    flush: Object.freeze(built.flush),
    hook: Object.freeze(built.hook),
    embed: Object.freeze(built.embed),
    recall: Object.freeze(built.recall),
    compile: Object.freeze(built.compile),
    gc: Object.freeze(built.gc),
    gate: Object.freeze(built.gate),
    wiki: Object.freeze(built.wiki),
    providers: Object.freeze({
      chain: Object.freeze(built.providers.chain.slice()),
      ...Object.fromEntries(
        KNOWN_PROVIDERS.map((p) => [p, Object.freeze({ models: Object.freeze((built.providers[p]?.models || []).slice()) })]),
      ),
    }),
    crossCuttingAreas: Object.freeze(built.crossCuttingAreas.slice()),
  });
}

// Public accessor. Cached per-process keyed by (path, mtime, env-overlay).
// One stat per call (cheap); a parse only happens on cache miss. Strict-
// subset env changes (MEMORY_LLM_PROVIDER, MEMORY_LLM_MODEL) bust the
// cache so a test or runtime override is picked up without restart.
export function settings(opts = {}) {
  // Any override (frame OR global) forces a fresh build — the cache key
  // doesn't include the override, so caching would let one async call leak
  // its override into another concurrent call.
  if (opts.configPath || opts.cmdProbe || activeOverride()) {
    return buildSettings(opts);
  }
  const file = settingsPath();
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* file may not exist; that's fine */ }
  // Fold in EVERY strict-subset input that changes the resolved settings:
  // provider/model collapse-or-re-head the chain; API-key presence drives
  // auto-detection when the YAML chain is empty. Without the key-presence
  // terms a long-lived process that gained an API key mid-session kept
  // serving the stale keyless chain until the YAML mtime changed. Presence
  // only (a1/a0), never the secret value.
  const envKey = [
    envValue("MEMORY_LLM_PROVIDER", ""),
    envValue("MEMORY_LLM_MODEL", ""),
    envHasAnthropicKey() ? "a1" : "a0",
    envHasOpenAiKey() ? "o1" : "o0",
  ].join(" ");
  if (cached && cached.path === file && cached.mtimeMs === mtimeMs && cached.envKey === envKey) {
    return cached.settings;
  }
  const built = buildSettings();
  cached = { path: file, mtimeMs, envKey, settings: built };
  return built;
}

// Convenience helpers (mirror the OLD env.mjs API so the call-site refactor
// is one-line per call). Each just reads from settings().<section>.<key>.

export function consolidateIntervalDays() { return settings().consolidate.intervalDays; }
export function consolidateCosineThreshold() { return settings().consolidate.cosineThreshold; }
export function consolidateCosineLexicalThreshold() { return settings().consolidate.cosineLexicalThreshold; }
export function consolidateCosineBandFloor() { return settings().consolidate.cosineBandFloor; }
export function consolidateClusterTopK() { return settings().consolidate.clusterTopK; }
export function consolidateClusterScoreThreshold() { return settings().consolidate.clusterScoreThreshold; }
export function consolidateOrphanTtlDays() { return settings().consolidate.orphanTtlDays; }
export function consolidateStaleAfterMonths() { return settings().consolidate.staleAfterMonths; }
export function consolidateArchiveBodyMax() { return settings().consolidate.archiveBodyMax; }
export function consolidateArchiveAgeDays() { return settings().consolidate.archiveAgeDays; }
export function consolidatePassesEnv() { return settings().consolidate.passes || "all"; }
export function consolidateLlmPassesEnabled() { return Boolean(settings().consolidate.llmPassesEnabled); }
export function consolidateLlmMaxRetries() { return settings().consolidate.llmMaxRetries; }
export function consolidateRefreshMaxPerRun() { return settings().consolidate.refreshMaxPerRun; }
export function consolidateAttemptsKeep() { return settings().consolidate.attemptsKeep; }
export function consolidateFullLogRetentionDays() { return settings().consolidate.fullLogRetentionDays; }
export function consolidateEscalateAfterAttempts() { return settings().consolidate.escalateAfterAttempts; }

export function flushChunkTargetK() { return settings().flush.chunkTargetK; }
export function flushChunkParallelism() { return settings().flush.chunkParallelism; }
export function flushReduceMaxChars() { return settings().flush.reduceMaxChars; }
export function flushRawFallbackChars() { return settings().flush.rawFallbackChars; }
export function flushDistillAttempts() { return settings().flush.distillAttempts; }
export function flushDistillRetryMs() { return settings().flush.distillRetryMs; }
export function flushLockStaleMs() { return settings().flush.lockStaleMs; }
export function flushSlotName() { return settings().flush.slot; }

export function hookMaxTurns() { return settings().hook.maxTurns; }
export function hookMaxChars() { return settings().hook.maxChars; }
export function hookSessionEndMinTurns() { return settings().hook.sessionEndMinTurns; }
export function hookPrecompactMinTurns() { return settings().hook.precompactMinTurns; }
export function hookExitPlanModeDisable() { return Boolean(settings().hook.exitPlanModeDisable); }
export function hookExitPlanModeMaxBytes() { return settings().hook.exitPlanModeMaxBytes; }

export function embedBackend() { return settings().embed.backend; }
export function embedModel() { return settings().embed.model; }

export function recallScoreThreshold() { return settings().recall.scoreThreshold; }
export function recallTouchEnabled() { return Boolean(settings().recall.touchEnabled); }
export function recallTouchMinHours() { return settings().recall.touchMinHours; }
export function recallPriorityBand() { return settings().recall.priorityBand; }

export function compileSlot() { return settings().compile.slot; }
export function compileSearchLimit() { return settings().compile.searchLimit; }
export function atomBodyMaxChars() { return settings().compile.atomBodyMaxChars; }
export function compileQualityStrict() { return Boolean(settings().compile.qualityStrict); }
export function compileLockStaleMs() { return settings().compile.lockStaleMs; }
export function compileMetadataRetryLimit() { return settings().compile.metadataRetryLimit; }

export function gcIntervalDays() { return settings().gc.intervalDays; }
export function writeGateSelfImprovementEnabled() { return Boolean(settings().gate.selfImprovementEnabled); }
export function writeGateClaudeHookEnabled() { return Boolean(settings().gate.claudeHookEnabled); }
export function writeGateAuditTrailEnabled() { return Boolean(settings().gate.auditTrailEnabled); }
export function writeGatePerLessonConsent() { return Boolean(settings().gate.perLessonConsent); }
export function writeGateAuditKeep() { return settings().gate.auditKeep; }
export function wikiAutoCommit() { return Boolean(settings().wiki.autoCommit); }
export function crossCuttingAreas() { return settings().crossCuttingAreas; }

// Provider helpers (replace llm-config.mjs's exports).

export function resolvedChain(cfg = settings()) {
  return cfg.providers.chain.map((p) => ({ provider: p, models: cfg.providers[p]?.models || [] }));
}
export function isCliProvider(provider) { return CLI_PROVIDERS.has(provider); }
export function isApiProvider(provider) { return API_PROVIDERS.has(provider); }
export function pickStrongerModel(currentModel, providerModels) {
  if (!Array.isArray(providerModels) || providerModels.length === 0) return currentModel;
  const idx = providerModels.indexOf(currentModel);
  if (idx === -1) return providerModels[0];
  if (idx >= providerModels.length - 1) return currentModel;
  return providerModels[idx + 1];
}

export const __testing = Object.freeze({
  TEMPLATE_PATH,
  KNOWN_PROVIDERS: Object.freeze(KNOWN_PROVIDERS.slice()),
  STRUCTURAL_PROVIDER_ORDER,
  normaliseChain,
  normaliseModels,
});

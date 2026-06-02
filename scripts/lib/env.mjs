import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// scripts/lib/env.mjs -> project clone root is two levels up.
export const MEMORY_DIR = path.resolve(here, "../..");

// Resolve the host workspace root from the clone location.
// Installed layout (<workspace>/.llm-wiki-memory/src) -> workspace is two
// levels up. A bare repo checkout / repo-dev workflow -> one level up.
// CAVEAT: `here` is derived from import.meta.url, which resolves symlinks. If
// `src` is itself a symlink into a store OUTSIDE the workspace (non-standard
// install), WORKSPACE_DIR/MEMORY_DATA_DIR will derive from the link TARGET, not
// the workspace. Set MEMORY_DATA_DIR (or LLM_WIKI_MEMORY_ROOT) explicitly for
// such layouts; the standard <workspace>/.llm-wiki-memory/src install is fine.
const inMemorySrc =
  path.basename(MEMORY_DIR) === "src" &&
  path.basename(path.dirname(MEMORY_DIR)) === ".llm-wiki-memory";
export const WORKSPACE_DIR = path.resolve(MEMORY_DIR, inMemorySrc ? "../.." : "..");

// Durable, (by default) gitignored data dir holding the wiki, the embedding
// index, and settings. Overridable via MEMORY_DATA_DIR for tests.
export const MEMORY_DATA_DIR =
  process.env.MEMORY_DATA_DIR && process.env.MEMORY_DATA_DIR !== ""
    ? process.env.MEMORY_DATA_DIR
    : path.join(WORKSPACE_DIR, ".llm-wiki-memory");

export const ENV_PATH = path.join(MEMORY_DATA_DIR, "settings", ".env");
// Runtime compile state/lock live under the durable data dir (not the repo
// clone), so the source tree stays clean and parallel installs don't collide.
export const COMPILE_STATE_PATH = path.join(MEMORY_DATA_DIR, "state", ".compile-state.json");
export const COMPILE_LOCK_PATH = path.join(MEMORY_DATA_DIR, "state", ".compile.lock");
// Last-run state for the throttled, on-demand embedding-cache GC (gc-embeddings
// --if-due / the SessionEnd embed-gc hook). { last_run_utc, removed }.
export const GC_STATE_PATH = path.join(MEMORY_DATA_DIR, "state", ".embed-gc.json");
// Last-run state for the throttled consolidate orchestrator. { last_run_utc,
// passes: { name: { archived, touched, merged, refreshed, flagged, freedBytes, ms } } }.
export const CONSOLIDATE_STATE_PATH = path.join(MEMORY_DATA_DIR, "state", ".consolidate.json");
export const PROMPTS_DIR = path.join(MEMORY_DIR, "prompts");

// Parse one .env value. Deliberately small (NOT a full dotenv parser): it
// trims, honours a simple pair of surrounding single or double quotes (the
// content from the first quote to the next matching quote is taken literally,
// including a '#'; escaped quotes / backslashes are NOT handled, which is fine
// for the simple values this project stores), and otherwise drops an inline
// "# comment" (a '#' at the start, or preceded by whitespace). Without this, an
// inline comment on a value line (e.g. `MEMORY_FLUSH_SLOT=daily   # ...`) leaks
// into the value, so the slot name becomes "daily   # ..." and every consumer
// silently reads a polluted string.
export function parseEnvValue(raw) {
  let v = String(raw ?? "").trim();
  if (!v) return "";
  // Quoted value: return the literal inside the first matching quote pair and
  // ignore anything after the closing quote (e.g. a trailing inline comment,
  // `"value" # note`). A '#' inside the quotes is kept.
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    if (end !== -1) return v.slice(1, end);
    // Unterminated quote (malformed): return the trimmed value literally rather
    // than guessing, so a stray '#' inside it is not mistaken for a comment.
    return v;
  }
  if (v[0] === "#") return "";
  // Unquoted: a '#' preceded by whitespace starts an inline comment.
  const hash = v.search(/\s#/);
  if (hash !== -1) v = v.slice(0, hash);
  return v.trim();
}

export function readEnvFile(file = ENV_PATH) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    out[line.slice(0, i).trim()] = parseEnvValue(line.slice(i + 1));
  }
  return out;
}

export function envValue(name, fallback = "") {
  if (process.env[name] != null && process.env[name] !== "") return process.env[name];
  const file = readEnvFile();
  return file[name] ?? fallback;
}

export function envInt(name, fallback) {
  const raw = envValue(name, "");
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Parse a float env var. Out-of-range values (or NaN / garbage) -> fallback.
// `min`/`max` are inclusive bounds. Use for ratios like cosine thresholds.
export function envFloat(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = envValue(name, "");
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

// Parse a boolean-ish env var. Empty -> fallback. `0`/`off`/`false`/`no`
// (case-insensitive) -> false; `1`/`on`/`true`/`yes` -> true; anything else ->
// fallback (don't guess on garbage). Use for opt-out / opt-in switches.
export function envBool(name, fallback) {
  const raw = envValue(name, "");
  if (raw === "") return fallback;
  const s = String(raw).trim().toLowerCase();
  if (s === "1" || s === "on" || s === "true" || s === "yes") return true;
  if (s === "0" || s === "off" || s === "false" || s === "no") return false;
  return fallback;
}

// Cadence (in DAYS) for the throttled embedding-cache GC. Unset -> 7 (weekly).
// `0`/`off`/`false` -> 0 (disabled). Garbage -> the default. Generic name so a
// future periodic GC can share the cadence knob.
export const GC_INTERVAL_DAYS_DEFAULT = 7;
export function gcIntervalDays() {
  const raw = envValue("MEMORY_GC_INTERVAL_DAYS", "");
  if (raw === "") return GC_INTERVAL_DAYS_DEFAULT;
  const s = String(raw).trim().toLowerCase();
  if (s === "off" || s === "false") return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return GC_INTERVAL_DAYS_DEFAULT;
  return n;
}

export const ATOM_BODY_MAX_CHARS_DEFAULT = 700;
export function atomBodyMaxChars() {
  return envInt("MEMORY_ATOM_BODY_MAX_CHARS", ATOM_BODY_MAX_CHARS_DEFAULT);
}

// Absolute path to the hosted wiki root. Override with LLM_WIKI_MEMORY_ROOT
// (absolute, or relative to the workspace). Defaults to <data>/wiki.
export function wikiRoot() {
  const configured = envValue("LLM_WIKI_MEMORY_ROOT", "");
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(WORKSPACE_DIR, configured);
  }
  return path.join(MEMORY_DATA_DIR, "wiki");
}

// Absolute path to the embedding cache JSON.
export function embedCachePath() {
  const configured = envValue("MEMORY_EMBED_CACHE", "");
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(WORKSPACE_DIR, configured);
  }
  return path.join(MEMORY_DATA_DIR, "index", "embeddings.json");
}

// Workspace identifier used to scope recall so two installs don't cross-leak.
// Mirrors the boilerplate's COMPOSE_PROJECT_NAME / MEMORY_DEFAULT_PROJECT_MODULE.
export function defaultProjectModule() {
  return (
    envValue("MEMORY_DEFAULT_PROJECT_MODULE", "") ||
    envValue("LLM_WIKI_MEMORY_PROJECT", "") ||
    path.basename(WORKSPACE_DIR) ||
    ""
  );
}

// ─── Consolidate orchestrator knobs ──────────────────────────────────────────
// Cadence (DAYS) for the throttled consolidate. Unset -> 1 (daily). `0`/`off`/
// `false` -> 0 (disabled). Garbage -> default.
export const CONSOLIDATE_INTERVAL_DAYS_DEFAULT = 1;
export function consolidateIntervalDays() {
  const raw = envValue("MEMORY_CONSOLIDATE_INTERVAL_DAYS", "");
  if (raw === "") return CONSOLIDATE_INTERVAL_DAYS_DEFAULT;
  const s = String(raw).trim().toLowerCase();
  if (s === "off" || s === "false") return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return CONSOLIDATE_INTERVAL_DAYS_DEFAULT;
  return n;
}

// Cosine threshold above which a cluster pair is treated as a dedup candidate.
// Real bge-large-en-v1.5 cosine pushes near-paraphrases to ~0.97+ in practice;
// 0.97 reserves auto-action for "almost the same leaf". Override per env.
export function consolidateCosineThreshold() {
  return envFloat("MEMORY_CONSOLIDATE_COSINE_THRESHOLD", 0.97, { min: 0, max: 1 });
}
// When the embedding backend falls back to the lexical hash, scores inflate
// across the board; bump the threshold so we don't mass-archive false positives.
export function consolidateCosineLexicalThreshold() {
  return envFloat("MEMORY_CONSOLIDATE_COSINE_LEXICAL_THRESHOLD", 0.995, { min: 0, max: 1 });
}

// Max search hits per leaf when computing its similarity cluster.
export function consolidateClusterTopK() {
  return envInt("MEMORY_CONSOLIDATE_CLUSTER_TOP_K", 12);
}
// Minimum cosine for a search hit to enter a leaf's cluster. Coarser than the
// dedupe threshold so the LLM-refresh prompt sees enough surrounding context.
export function consolidateClusterScoreThreshold() {
  return envFloat("MEMORY_CONSOLIDATE_CLUSTER_SCORE_THRESHOLD", 0.75, { min: 0, max: 1 });
}

export function consolidateOrphanTtlDays() {
  return envInt("MEMORY_CONSOLIDATE_ORPHAN_TTL_DAYS", 365);
}
export function consolidateStaleAfterMonths() {
  return envInt("MEMORY_CONSOLIDATE_STALE_AFTER_MONTHS", 6);
}
export function consolidateArchiveBodyMax() {
  return envInt("MEMORY_CONSOLIDATE_ARCHIVE_BODY_MAX", 1200);
}
export function consolidateArchiveAgeDays() {
  return envInt("MEMORY_CONSOLIDATE_ARCHIVE_AGE_DAYS", 30);
}

// Pass allow-list. Empty / "all" -> every pass enabled. CSV of pass names ->
// only those. Unknown names ignored (logged at orchestrator level).
export function consolidatePassesEnv() {
  const raw = envValue("MEMORY_CONSOLIDATE_PASSES", "");
  return raw === "" ? "all" : String(raw).trim();
}

// LLM-driven passes (merge near-duplicates, semantic refresh). Default on; turn
// off in environments without a provider configured or when running pure
// deterministic mode.
export function consolidateLlmPassesEnabled() {
  return envBool("MEMORY_CONSOLIDATE_LLM_PASSES", true);
}
export function consolidateLlmMaxRetries() {
  return envInt("MEMORY_CONSOLIDATE_LLM_MAX_RETRIES", 2);
}
// Per-run cap on the semantic-refresh pass. Bounds the LLM-call budget so a
// stale-flag explosion cannot blow through the API quota in one run.
export function consolidateRefreshMaxPerRun() {
  return envInt("MEMORY_CONSOLIDATE_REFRESH_MAX_PER_RUN", 25);
}

// ─── Recall-touch instrumentation ────────────────────────────────────────────
// Throttle (in HOURS) for recall-driven freshness writes. Each leaf's
// `memory.last_recalled_at` updates at most once per this many hours.
export function recallTouchMinHours() {
  return envInt("MEMORY_RECALL_TOUCH_MIN_HOURS", 24);
}
// Safety valve: set to false to disable recall-touch frontmatter writes
// entirely. Default true.
export function recallTouchEnabled() {
  return envBool("MEMORY_RECALL_TOUCH", true);
}

// ─── Write-gate (self_improvement) ───────────────────────────────────────────
// The L3 server-side guard rejecting save_lesson / save_to_dataset(
// dataset="self_improvement") without `userRequested:true`. Default on. Set to
// false as an operator escape hatch (L1/L2/L5 still in place).
export function writeGateSelfImprovementEnabled() {
  return envBool("MEMORY_WRITE_GATE_SELF_IMPROVEMENT", true);
}

// ─── LLM provider config (provider-agnostic overrides) ───────────────────────
// Base URL for OpenAI-compatible local endpoints (ollama at
// http://localhost:11434/v1, vLLM, lm-studio, llama.cpp server, litellm proxy).
// Unset -> provider's own default URL.
export function llmBaseUrl() {
  return envValue("MEMORY_LLM_BASE_URL", "");
}
// Provider-agnostic model name override. When unset, llm.mjs falls back to the
// provider-specific name (ANTHROPIC_MODEL / OPENAI_MODEL), preserving existing
// behaviour.
export function llmModel() {
  return envValue("MEMORY_LLM_MODEL", "");
}

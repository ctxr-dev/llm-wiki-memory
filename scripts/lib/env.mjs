import {
  parseEnvValue,
  readEnvValueFrom,
  envFileHas,
  __resetEnvFileCache,
  __envFileCacheSnapshot,
} from "./env-file.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalRepoId, gitOriginUrl } from "./project-identity.mjs";
import { assertTestBrainIsolation } from "./real-brain-guard.mjs";

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
const WORKSPACE_DIR = path.resolve(MEMORY_DIR, inMemorySrc ? "../.." : "..");

// Durable, (by default) gitignored data dir holding the wiki, the embedding
// index, and settings. Overridable via MEMORY_DATA_DIR for tests.
export const MEMORY_DATA_DIR =
  process.env.MEMORY_DATA_DIR && process.env.MEMORY_DATA_DIR !== ""
    ? process.env.MEMORY_DATA_DIR
    : path.join(WORKSPACE_DIR, ".llm-wiki-memory");

// TEST-SAFETY GUARD (production-inert): refuse the developer's real brain in a test
// context. See scripts/lib/real-brain-guard.mjs for the contract.
assertTestBrainIsolation(MEMORY_DATA_DIR);

const ENV_PATH = path.join(MEMORY_DATA_DIR, "settings", ".env");
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
// Per-entity consolidation attempt history (entity-level self-healing).
export const CONSOLIDATE_ENTITIES_PATH = path.join(
  MEMORY_DATA_DIR,
  "state",
  ".consolidate-entities.json",
);
// Sharded full cron-run logs: <CRON_LOGS_DIR>/<yyyy>/<mm>/cron-<ts>.json.
export const CRON_LOGS_DIR = path.join(MEMORY_DATA_DIR, "state", "logs");
// Escalation issue reports: <ISSUES_DIR>/<yyyy>/<mm>/<dd>/<sig>.<version>.md.
export const ISSUES_DIR = path.join(MEMORY_DATA_DIR, "issues");
// Episode index for issue reports: signature -> { version, path, status }.
export const ISSUES_INDEX_PATH = path.join(MEMORY_DATA_DIR, "state", ".issues-index.json");
// Append-only ledger of write activity on the gated (self_improvement) category:
// one redacted JSONL record per L2 hook allow/ask, L3 server accepted/refused, and
// compile-distilled lesson promotion. Observability only. Gitignored.
export const SAVE_GATE_AUDIT_PATH = path.join(MEMORY_DATA_DIR, "state", ".save-gate-audit.log");
// Durable job queue (better-sqlite3) for the post-git sync hook. Brain-global;
// jobs are keyed by wiki, so all mounts share this one file. Gitignored.
export const SYNC_QUEUE_PATH = path.join(MEMORY_DATA_DIR, "state", "sync-queue.sqlite");
export const PROMPTS_DIR = path.join(MEMORY_DIR, "prompts");

/**
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
export { parseEnvValue, __resetEnvFileCache, __envFileCacheSnapshot };

// Whether a value is configured, WITHOUT materialising it. For a credential this is the only form
// that is both cached and safe: `settings()` builds its cache key from these booleans, so routing
// them through envValue would take the uncached secret path twice per settings() hit.
/**
 * @param {string} name
 * @returns {boolean}
 */
export function envHas(name) {
  const fromProcess = process.env[name];
  if (fromProcess != null && String(fromProcess).trim() !== "") return true;
  return envFileHas(ENV_PATH, name);
}

/**
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function envValue(name, fallback = "") {
  if (process.env[name] != null && process.env[name] !== "")
    return /** @type {string} */ (process.env[name]);
  // Routed per key: a secret-named lookup takes a fresh read and is never retained.
  return readEnvValueFrom(ENV_PATH, name) ?? fallback;
}

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export function envInt(name, fallback) {
  const raw = envValue(name, "");
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Parse a float env var. Out-of-range values (or NaN / garbage) -> fallback.
// `min`/`max` are inclusive bounds. Use for ratios like cosine thresholds.
/**
 * @param {string} name
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number}
 */
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
/**
 * @param {string} name
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function envBool(name, fallback) {
  const raw = envValue(name, "");
  if (raw === "") return fallback;
  const s = String(raw).trim().toLowerCase();
  if (s === "1" || s === "on" || s === "true" || s === "yes") return true;
  if (s === "0" || s === "off" || s === "false" || s === "no") return false;
  return fallback;
}

// Per-operation wiki-root override for the federated (layered) wiki. env is the
// low-level module, so the ALS lives HERE — wiki-context.mjs imports
// `withWikiRoot` (never the reverse), which keeps the dependency acyclic.
/** @type {AsyncLocalStorage<string>} */
const activeRootStore = new AsyncLocalStorage();

/**
 * Run `fn` inside an async frame where the active wiki root is `root`, so
 * `wikiRoot()` (and the embed-cache path derived from it) resolves to that root
 * instead of the env-derived default. Composable and nestable: an inner frame
 * shadows an outer one and the previous override is restored on exit; each async
 * frame sees only its own override. Only these per-operation, wiki-tree-scoped
 * paths follow the override — the brain-global config/state (MEMORY_DATA_DIR,
 * settingsPath, the state dir, .env) stays anchored to MEMORY_DATA_DIR.
 * @template T
 * @param {string} root absolute path to the wiki root directory
 * @param {() => T} fn
 * @returns {T}
 */
export function withWikiRoot(root, fn) {
  return activeRootStore.run(root, fn);
}

// Absolute path to the hosted wiki root. An active `withWikiRoot` frame wins;
// otherwise override with LLM_WIKI_MEMORY_ROOT (absolute, or relative to the
// workspace), defaulting to <data>/wiki. With no active frame this is
// byte-identical to the pre-federation resolver.
export function wikiRoot() {
  const active = activeRootStore.getStore();
  if (active) return active;
  const configured = envValue("LLM_WIKI_MEMORY_ROOT", "");
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(WORKSPACE_DIR, configured);
  }
  return path.join(MEMORY_DATA_DIR, "wiki");
}

// Absolute path to the embedding cache JSON. Under an active `withWikiRoot`
// frame it is that root's per-mount cache (`<root>/../index/embeddings.json`),
// so mounts never share one cache. With no active frame the explicit
// MEMORY_EMBED_CACHE override wins, else it is the brain default under
// MEMORY_DATA_DIR — byte-identical to the pre-federation resolver.
export function embedCachePath() {
  const active = activeRootStore.getStore();
  if (active) return path.join(path.dirname(active), "index", "embeddings.json");
  const configured = envValue("MEMORY_EMBED_CACHE", "");
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(WORKSPACE_DIR, configured);
  }
  return path.join(MEMORY_DATA_DIR, "index", "embeddings.json");
}

// Per-category embedding cache file. Phase D split the one monolithic per-root
// cache into a file per category, living in the category's OWN hidden dir so a
// leaf's vectors sit beside the leaf (and Phase E can fan a search across only
// the categories it touches). The leading-dot `.embeddings/` keeps every wiki
// walk (walkLeaves / listDocuments / doctor) from seeing the cache as a leaf.
// `root` is the wiki root; `category` is a top-level dir under it.
/**
 * @param {string} root absolute wiki root directory
 * @param {string} category top-level category dir name
 * @returns {string}
 */
export function embedCacheFor(root, category) {
  return path.join(root, String(category), ".embeddings", "embeddings.json");
}

/** @type {string | undefined} */
let cachedWorkspaceIdentity;
export function workspaceIdentity() {
  if (cachedWorkspaceIdentity === undefined) {
    cachedWorkspaceIdentity =
      canonicalRepoId(gitOriginUrl(WORKSPACE_DIR)) ||
      (WORKSPACE_DIR ? `file://${WORKSPACE_DIR}` : "");
  }
  return cachedWorkspaceIdentity;
}

// Workspace identifier used to scope recall so two installs don't cross-leak.
export function defaultProjectModule() {
  return (
    envValue("MEMORY_DEFAULT_PROJECT_MODULE", "") ||
    envValue("LLM_WIKI_MEMORY_PROJECT", "") ||
    workspaceIdentity() ||
    path.basename(WORKSPACE_DIR) ||
    ""
  );
}

/** @returns {string} */
export function workspaceBasename() {
  return WORKSPACE_DIR ? path.basename(WORKSPACE_DIR) : "";
}

// ─── Strict env-var subset (provider switches; secrets via dotenv) ──────────
// Base URL for OpenAI-compatible local endpoints (ollama at
// http://localhost:11434/v1, vLLM, lm-studio, llama.cpp server, litellm proxy).
// Unset -> provider's own default URL.
export function llmBaseUrl() {
  return envValue("MEMORY_LLM_BASE_URL", "");
}
// Provider-agnostic model name override. When set, wins over provider-specific
// names; see settings.providers for the fallback chain.
export function llmModel() {
  return envValue("MEMORY_LLM_MODEL", "");
}

// NOTE: all OTHER configuration (consolidate / flush / hook / embed / recall /
// compile / gc / gate / providers) lives in <data>/settings/settings.yaml.
// Read via scripts/lib/settings.mjs. The 2026-06-03 release removed every
// MEMORY_FOO env var on the non-strict surface — setting them at the shell
// is now a SILENT no-op.

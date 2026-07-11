import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { MEMORY_DATA_DIR, envValue } from "./env.mjs";
import { TEMPLATE_PATH, readEffectiveYaml } from "./settings-yaml.mjs";
import { structuralDefaults } from "./settings-defaults.mjs";
import { applyYamlOverlay, applyProviderChainAndEnv } from "./settings-overlay.mjs";
import { coerceSections } from "./settings-validate.mjs";
import { deepMerge, normaliseChain, normaliseModels } from "./settings-coerce.mjs";
import { envHasAnthropicKey, envHasOpenAiKey } from "./settings-providers.mjs";

/** @typedef {import("./settings-defaults.mjs").Settings} Settings */
/** @typedef {import("./settings-defaults.mjs").ProviderModels} ProviderModels */
/** @typedef {import("./settings-providers.mjs").CmdProbe} CmdProbe */
/** A caller-supplied settings override, deep-merged over the resolved YAML. @typedef {Record<string, unknown>} SettingsOverride */
/**
 * @typedef {Object} BuildSettingsOpts
 * @property {string} [configPath]
 * @property {CmdProbe} [cmdProbe]
 */
/**
 * @typedef {Object} SettingsCacheEntry
 * @property {string} path
 * @property {number} mtimeMs
 * @property {string} envKey
 * @property {ReturnType<typeof buildSettings>} settings
 */

export * from "./settings-accessors.mjs";
export {
  resolvedChain,
  isCliProvider,
  isApiProvider,
  pickStrongerModel,
} from "./settings-providers.mjs";

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

export const KNOWN_PROVIDERS = [
  "mock",
  "anthropic",
  "openai",
  "openai-compatible",
  "claude",
  "codex",
  "cursor",
];

// Structural fallback when settings.yaml lacks embed.model (a broken template).
// The canonical default ships in templates/settings.yaml; this is the one model
// name that legitimately lives in code, because it backstops a missing config
// rather than being a swappable provider/model choice.
export const DEFAULT_EMBED_MODEL = "Xenova/bge-large-en-v1.5";

// Structural-only fallback (no model name strings here). The provider chain
// priority IS a structural choice — it controls auto-detect ORDER, not which
// specific models are tried.
export const STRUCTURAL_PROVIDER_ORDER = Object.freeze([
  "anthropic",
  "openai",
  "claude",
  "codex",
  "cursor",
]);

/** @type {SettingsCacheEntry | null} */
let cached = null; // { path, mtimeMs, envKey, settings }
/** @type {SettingsOverride | null} */
let globalOverride = null; // process-level override (tests, CLI one-shot)
/** @type {AsyncLocalStorage<SettingsOverride | null>} */
const overrideStorage = new AsyncLocalStorage(); // per-async-context override

// Push a process-level settings override. Used by tests (before/after pairs)
// AND by one-shot CLI flags (e.g. `consolidate --cosine-threshold=0.9` in
// cli.mjs). The `__set/__clearSettingsForTest` names are kept as aliases for
// test files already written against them.
//
// For CONCURRENT-SAFE overrides (e.g. an MCP server handling parallel tool
// calls that each want their own cosineThreshold), use `withSettingsOverride`
// instead — it scopes the override to an AsyncLocalStorage frame so two
// in-flight callers don't trample each other.
/** @param {SettingsOverride | null | undefined} overrides */
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
/**
 * @template T
 * @param {SettingsOverride | null | undefined} overrides
 * @param {() => T} fn
 * @returns {T}
 */
export function withSettingsOverride(overrides, fn) {
  return overrideStorage.run(overrides || null, fn);
}

// Internal: the override that should be applied to THIS call's settings.
// AsyncLocalStorage frame wins over the global seam — the frame is the
// concurrent-safe surface; the global is the fallback for one-shot tools
// and tests.
/** @returns {SettingsOverride | null} */
function activeOverride() {
  return overrideStorage.getStore() || globalOverride || null;
}

export function settingsPath() {
  const configured = envValue("MEMORY_SETTINGS_PATH", "");
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(MEMORY_DATA_DIR, configured);
  }
  return path.join(MEMORY_DATA_DIR, "settings", "settings.yaml");
}

/**
 * @param {BuildSettingsOpts} [opts]
 * @returns {Settings}
 */
function buildSettings({ configPath, cmdProbe } = {}) {
  const file = configPath || settingsPath();
  const raw = readEffectiveYaml(file) || {};

  const sections = structuralDefaults();
  applyYamlOverlay(sections, raw);
  applyProviderChainAndEnv(sections, { cmdProbe });
  coerceSections(sections);

  /** @type {Settings} */
  const built = {
    consolidate: sections.consolidate,
    flush: sections.flush,
    hook: sections.hook,
    embed: sections.embed,
    recall: sections.recall,
    compile: sections.compile,
    gc: sections.gc,
    gate: sections.gate,
    wiki: sections.wiki,
    providers: sections.providers,
    crossCuttingAreas: sections.crossCuttingAreas,
  };

  // Override overlay (last; wins over file + env). AsyncLocalStorage frame
  // takes priority over the global seam — see activeOverride().
  const override = activeOverride();
  if (override) deepMerge(built, override);

  return /** @type {Settings} */ (
    Object.freeze({
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
          KNOWN_PROVIDERS.map((p) => {
            const entry = /** @type {{ models?: string[] }} */ (built.providers[p]);
            return [
              p,
              Object.freeze({
                models: Object.freeze((entry?.models || []).slice()),
              }),
            ];
          }),
        ),
      }),
      crossCuttingAreas: Object.freeze(built.crossCuttingAreas.slice()),
    })
  );
}

// Public accessor. Cached per-process keyed by (path, mtime, env-overlay).
// One stat per call (cheap); a parse only happens on cache miss. Strict-
// subset env changes (MEMORY_LLM_PROVIDER, MEMORY_LLM_MODEL) bust the
// cache so a test or runtime override is picked up without restart.
/** @param {BuildSettingsOpts} [opts] */
export function settings(opts = {}) {
  // Any override (frame OR global) forces a fresh build — the cache key
  // doesn't include the override, so caching would let one async call leak
  // its override into another concurrent call.
  if (opts.configPath || opts.cmdProbe || activeOverride()) {
    return buildSettings(opts);
  }
  const file = settingsPath();
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    /* file may not exist; that's fine */
  }
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

export const __testing = Object.freeze({
  TEMPLATE_PATH,
  KNOWN_PROVIDERS: Object.freeze(KNOWN_PROVIDERS.slice()),
  STRUCTURAL_PROVIDER_ORDER,
  normaliseChain,
  normaliseModels,
});

import { envValue } from "./env.mjs";
import { settings } from "./settings.mjs";

/** @typedef {import("./settings-defaults.mjs").Settings} Settings */
/** @typedef {import("./settings-defaults.mjs").ProviderModels} ProviderModels */
/**
 * A synchronous "is this CLI on PATH" probe, injected for testing.
 * @typedef {(cmd: string) => boolean} CmdProbe
 */

const CLI_PROVIDERS = new Set(["claude", "codex", "cursor"]);
const API_PROVIDERS = new Set(["anthropic", "openai", "openai-compatible"]);

export function envHasAnthropicKey() {
  return Boolean(envValue("ANTHROPIC_API_KEY", "").trim());
}
export function envHasOpenAiKey() {
  return (
    Boolean(envValue("OPENAI_API_KEY", "").trim()) ||
    Boolean(envValue("MEMORY_LLM_BASE_URL", "").trim())
  );
}

/**
 * @param {{ cmdProbe?: CmdProbe }} [opts]
 * @returns {Set<string>}
 */
export function detectAvailableProviders({ cmdProbe } = {}) {
  const probe = typeof cmdProbe === "function" ? cmdProbe : null;
  /** @type {Set<string>} */
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

// Provider helpers (replace llm-config.mjs's exports).

/**
 * @param {Settings} [cfg]
 * @returns {Array<{ provider: string, models: string[] }>}
 */
export function resolvedChain(cfg = settings()) {
  return cfg.providers.chain.map((p) => ({
    provider: p,
    models: /** @type {ProviderModels | undefined} */ (cfg.providers[p])?.models || [],
  }));
}
/** @param {string} provider @returns {boolean} */
export function isCliProvider(provider) {
  return CLI_PROVIDERS.has(provider);
}
/** @param {string} provider @returns {boolean} */
export function isApiProvider(provider) {
  return API_PROVIDERS.has(provider);
}
/**
 * @param {string} currentModel
 * @param {string[]} providerModels
 * @returns {string}
 */
export function pickStrongerModel(currentModel, providerModels) {
  if (!Array.isArray(providerModels) || providerModels.length === 0) return currentModel;
  const idx = providerModels.indexOf(currentModel);
  if (idx === -1) return providerModels[0];
  if (idx >= providerModels.length - 1) return currentModel;
  return providerModels[idx + 1];
}

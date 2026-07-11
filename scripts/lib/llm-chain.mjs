import { envInt } from "./env.mjs";
import { settings, isCliProvider, isApiProvider } from "./settings.mjs";
import { LLMProviderUnavailable, LLMOutputInvalid } from "./llm-errors.mjs";
import { mockResponse, parseStrictJson } from "./llm-parse.mjs";
import { callClaudeCli, callCodexCli, callCursorCli } from "./llm-cli-providers.mjs";
import { callAnthropicApi, callOpenAiApi } from "./llm-api-providers.mjs";

/** @typedef {import("./settings-defaults.mjs").Settings} Settings */
/** @typedef {import("./settings-defaults.mjs").ProviderModels} ProviderModels */

/**
 * The arguments callLLM / callLLMWithRetry accept.
 * @typedef {Object} LLMCallArgs
 * @property {string} [systemPrompt]
 * @property {string} [userPrompt]
 * @property {number} [maxTokens]
 */

/**
 * A single failed (provider, model) attempt recorded on the provenance trail.
 * @typedef {Object} FailureReason
 * @property {string} provider
 * @property {string | null} model
 * @property {string} error
 */

/**
 * The trail of provider/model combinations tried, attached to the result and
 * (on total failure) to the thrown LLMProviderUnavailable.
 * @typedef {Object} ChainProvenance
 * @property {string[]} provider_chain_tried
 * @property {string | null} final_provider
 * @property {FailureReason[]} failure_reasons
 */

/**
 * A single (provider, model) attempt's arguments.
 * @typedef {Object} AttemptArgs
 * @property {string} provider
 * @property {string | null} model
 * @property {string} [systemPrompt]
 * @property {string} [userPrompt]
 * @property {number} maxTokens
 * @property {number} timeoutMs
 */

const DEFAULT_TIMEOUT_MS = 120_000;

// Detect "model is gone / wrong" errors from API providers. Promotes the
// chain iteration: we keep trying within the SAME provider's model list
// before giving up on that provider. Heuristic — providers emit slightly
// different messages, so the matcher errs on the side of including more
// signals than fewer.
/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function looksLikeModelNotFound(err) {
  const msg = String(/** @type {Error} */ (err)?.message || err || "").toLowerCase();
  return (
    msg.includes("model_not_found") ||
    msg.includes("not_found_error") ||
    msg.includes("model does not exist") ||
    msg.includes("invalid_model") ||
    msg.includes("model not found") ||
    msg.includes("unknown model") ||
    msg.includes("decommissioned") ||
    msg.includes("deprecated_model")
  );
}

// Single attempt at a (provider, model) pair. Returns parsed JSON; throws
// LLMProviderUnavailable / LLMOutputInvalid. The strict-JSON retry that
// previously lived inside callLLMWithRetry is kept at the WRAPPER level (not
// here), so each chain step is exactly one LLM call per pass; the wrapper
// can re-run the whole chain with a stricter prompt if the final answer
// was invalid.
/**
 * @param {AttemptArgs} args
 * @returns {Promise<unknown>}
 */
async function attemptProvider({
  provider,
  model,
  systemPrompt,
  userPrompt,
  maxTokens,
  timeoutMs,
}) {
  let raw;
  switch (provider) {
    case "mock":
      raw = mockResponse();
      break;
    case "claude":
      raw = await callClaudeCli({ systemPrompt, userPrompt, timeoutMs });
      break;
    case "codex":
      raw = await callCodexCli({ systemPrompt, userPrompt, timeoutMs });
      break;
    case "cursor":
      raw = await callCursorCli({ systemPrompt, userPrompt, timeoutMs });
      break;
    case "anthropic":
      raw = await callAnthropicApi({ systemPrompt, userPrompt, maxTokens, timeoutMs, model });
      break;
    case "openai":
    case "openai-compatible":
      raw = await callOpenAiApi({ systemPrompt, userPrompt, maxTokens, timeoutMs, model });
      break;
    default:
      throw new LLMProviderUnavailable(`Unknown provider in chain: ${provider}`);
  }
  return parseStrictJson(raw);
}

// Iterate the configured provider chain and (per API provider) the model
// list, returning `{ result, provenance }` where `result` is the parsed JSON
// and provenance carries which combinations were tried and which one
// answered. Callers that just want the parsed JSON should use `callLLM`.
//
// Within a provider: a model-not-found / deprecated error advances to the
// next model in the same provider's list. ANY other error (timeout, auth,
// network, output invalid) advances to the NEXT provider — never iterate
// past a transient error within the same provider, since the per-model
// retry budget would multiply by the model-list length.
/**
 * @param {LLMCallArgs & { configOverride?: Settings }} [args]
 * @returns {Promise<{ result: unknown, provenance: ChainProvenance }>}
 */
export async function callLLMChain({
  systemPrompt,
  userPrompt,
  maxTokens = 1500,
  configOverride,
} = {}) {
  // No sync cmdProbe here: detecting "claude on PATH" requires spawning
  // /usr/bin/which, which settings() is synchronous to support. We
  // accept that detectAvailableProviders' default keeps all CLIs in the
  // chain; the dispatcher then fast-fails an absent CLI via the spawn
  // 'error' event and moves on to the next provider — one ENOENT per
  // missing CLI is negligible.
  const config = configOverride || settings();
  const timeoutMs = envInt("MEMORY_LLM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

  const chain = config.providers.chain;
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new LLMProviderUnavailable(
      "no LLM providers configured (chain empty; set MEMORY_LLM_PROVIDER, populate settings/settings.yaml, or supply an API key)",
    );
  }

  /** @type {string[]} */
  const tried = [];
  /** @type {FailureReason[]} */
  const failures = [];

  for (const provider of chain) {
    if (provider === "mock" || isCliProvider(provider)) {
      // No per-model loop: mock has no model, CLIs defer to their own
      // logged-in model. One attempt per CLI provider.
      const label = `${provider}:(default)`;
      tried.push(label);
      try {
        const result = await attemptProvider({
          provider,
          model: null,
          systemPrompt,
          userPrompt,
          maxTokens,
          timeoutMs,
        });
        return {
          result,
          provenance: {
            provider_chain_tried: tried.slice(),
            final_provider: label,
            failure_reasons: failures.slice(),
          },
        };
      } catch (err) {
        failures.push({
          provider,
          model: null,
          error: /** @type {Error} */ (err)?.message || String(err),
        });
        continue;
      }
    }

    if (isApiProvider(provider)) {
      const models = /** @type {ProviderModels} */ (config.providers[provider])?.models || [];
      if (models.length === 0) {
        failures.push({ provider, model: null, error: "no models configured for provider" });
        continue;
      }
      let movedToNextProvider = false;
      for (const model of models) {
        if (movedToNextProvider) break;
        const label = `${provider}:${model}`;
        tried.push(label);
        try {
          const result = await attemptProvider({
            provider,
            model,
            systemPrompt,
            userPrompt,
            maxTokens,
            timeoutMs,
          });
          return {
            result,
            provenance: {
              provider_chain_tried: tried.slice(),
              final_provider: label,
              failure_reasons: failures.slice(),
            },
          };
        } catch (err) {
          failures.push({
            provider,
            model,
            error: /** @type {Error} */ (err)?.message || String(err),
          });
          if (looksLikeModelNotFound(err)) {
            // Try the next model under the same provider.
            continue;
          }
          // Anything else (timeout, auth, output invalid, network) — move
          // on to the next provider.
          movedToNextProvider = true;
        }
      }
      continue;
    }

    failures.push({ provider, model: null, error: `unknown provider in chain: ${provider}` });
  }

  const lastErr = failures[failures.length - 1];
  const detail = lastErr
    ? `${lastErr.provider}${lastErr.model ? `:${lastErr.model}` : ""}: ${lastErr.error}`
    : "no providers attempted";
  /** @type {LLMProviderUnavailable & { provenance?: ChainProvenance }} */
  const err = new LLMProviderUnavailable(
    `all providers exhausted (${tried.join(", ") || "none"}); last: ${detail}`,
  );
  err.provenance = {
    provider_chain_tried: tried.slice(),
    final_provider: null,
    failure_reasons: failures.slice(),
  };
  throw err;
}

/**
 * @param {LLMCallArgs} [args]
 * @returns {Promise<unknown>}
 */
async function callLLM({ systemPrompt, userPrompt, maxTokens = 1500 } = {}) {
  const { result } = await callLLMChain({ systemPrompt, userPrompt, maxTokens });
  return result;
}

/**
 * @param {LLMCallArgs} args
 * @returns {Promise<unknown>}
 */
export async function callLLMWithRetry(args) {
  try {
    return await callLLM(args);
  } catch (err) {
    if (!(err instanceof LLMOutputInvalid)) throw err;
    const stricter = {
      ...args,
      userPrompt:
        `${args.userPrompt}\n\n---\nIMPORTANT: respond with STRICT JSON only. ` +
        `No prose before or after. No markdown code fences.`,
    };
    return callLLM(stricter);
  }
}

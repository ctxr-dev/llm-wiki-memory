import { envValue } from "./env.mjs";
import { LLMProviderUnavailable, LLMOutputInvalid } from "./llm-errors.mjs";

/**
 * The arguments accepted by the API-provider dispatch helpers.
 * @typedef {Object} ApiCallArgs
 * @property {string} [systemPrompt]
 * @property {string} [userPrompt]
 * @property {number} maxTokens
 * @property {number} timeoutMs
 * @property {string | null} [model]
 */

/**
 * The subset of the Anthropic Messages API response this helper reads.
 * @typedef {Object} AnthropicResponse
 * @property {Array<{ type?: string, text?: string }>} [content]
 */

/**
 * The subset of the OpenAI-compatible chat/completions response this helper reads.
 * @typedef {Object} OpenAiResponse
 * @property {Array<{ message?: { content?: string } }>} [choices]
 */

/**
 * @param {ApiCallArgs} args
 * @returns {Promise<string>}
 */
export async function callAnthropicApi({
  systemPrompt,
  userPrompt,
  maxTokens,
  timeoutMs,
  model: explicitModel,
}) {
  // Defensive sanitisation: a key copied from a wrapped UI line may carry
  // trailing CR/LF that would CRLF-inject the x-api-key header. Strip it.
  const apiKey = envValue("ANTHROPIC_API_KEY")
    .replace(/[\r\n]+/g, "")
    .trim();
  // Explicit model from the chain wins; falls back to env overrides. No
  // baked-in fallback string here — model names live only in
  // templates/settings.yaml / settings/settings.yaml / settings/.env.
  const model =
    (explicitModel && String(explicitModel).trim()) ||
    envValue("MEMORY_LLM_MODEL", "") ||
    envValue("ANTHROPIC_MODEL", "");
  if (!apiKey) throw new LLMProviderUnavailable("ANTHROPIC_API_KEY not set");
  if (!model) {
    throw new LLMProviderUnavailable(
      "no Anthropic model configured (set settings/settings.yaml providers.anthropic.models, MEMORY_LLM_MODEL, or ANTHROPIC_MODEL)",
    );
  }

  const body = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt || undefined,
    messages: [{ role: "user", content: userPrompt }],
  };

  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new LLMProviderUnavailable(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = /** @type {AnthropicResponse} */ (await res.json());
  const text = json?.content?.find?.((c) => c?.type === "text")?.text;
  if (!text)
    throw new LLMOutputInvalid("Anthropic response missing text content", JSON.stringify(json));
  return text;
}

// Returns true iff `baseUrl`'s hostname is loopback or RFC1918 (i.e. on a
// trust boundary the user has already accepted). Used to gate
// "API-key-optional" mode: a local model server (ollama, vLLM, lm-studio,
// llama.cpp, litellm) usually has no auth; an external endpoint without a
// key would either fail or, worse, leak prompts to a random host.
/**
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function isLocalEndpoint(baseUrl) {
  try {
    const u = new URL(baseUrl);
    // WHATWG URL keeps the surrounding brackets on an IPv6 hostname (e.g.
    // `[::1]`); strip them so loopback comparison matches the bare address.
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h === "::1") return true;
    if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
    if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
    if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
    const m = h.match(/^172\.(\d+)\.\d+\.\d+$/);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * @param {ApiCallArgs} args
 * @returns {Promise<string>}
 */
export async function callOpenAiApi({
  systemPrompt,
  userPrompt,
  maxTokens,
  timeoutMs,
  model: explicitModel,
}) {
  // Defensive sanitisation: strip stray CR/LF before interpolating into
  // the Bearer header (mirror of the Anthropic helper).
  const apiKey = envValue("OPENAI_API_KEY")
    .replace(/[\r\n]+/g, "")
    .trim();
  const baseUrl = (envValue("MEMORY_LLM_BASE_URL", "") || "https://api.openai.com/v1").replace(
    /\/+$/,
    "",
  );
  const local = isLocalEndpoint(baseUrl);
  if (!apiKey && !local) {
    throw new LLMProviderUnavailable(
      `OPENAI_API_KEY not set; refusing to call ${baseUrl} unauthenticated. ` +
        "Only loopback / RFC1918 endpoints are allowed without an API key " +
        "(set MEMORY_LLM_BASE_URL=http://localhost:11434/v1 for ollama, etc.).",
    );
  }
  // Explicit model wins; falls back to env overrides. No baked-in fallback
  // string — model names live only in templates/settings.yaml /
  // settings/settings.yaml / settings/.env.
  const model =
    (explicitModel && String(explicitModel).trim()) ||
    envValue("MEMORY_LLM_MODEL", "") ||
    envValue("OPENAI_MODEL", "");
  if (!model) {
    throw new LLMProviderUnavailable(
      "no OpenAI-compatible model configured (set settings/settings.yaml providers.openai.models, MEMORY_LLM_MODEL, or OPENAI_MODEL)",
    );
  }

  // OpenAI deprecated `max_tokens` in favour of `max_completion_tokens`
  // for newer models (gpt-4o family and later). Send the new key as
  // primary; older models that only accept `max_tokens` ignore it.
  const body = {
    model,
    max_completion_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      { role: "user", content: userPrompt },
    ],
  };

  const headers = /** @type {Record<string, string>} */ ({ "content-type": "application/json" });
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeoutMs,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new LLMProviderUnavailable(
      `OpenAI-compatible API ${res.status} at ${baseUrl}: ${text.slice(0, 300)}`,
    );
  }
  const json = /** @type {OpenAiResponse} */ (await res.json());
  const text = json?.choices?.[0]?.message?.content;
  if (!text) {
    throw new LLMOutputInvalid("OpenAI-compatible response missing content", JSON.stringify(json));
  }
  return text;
}

/**
 * @param {string | URL} url
 * @param {RequestInit & { timeoutMs?: number }} [opts]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, { timeoutMs, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

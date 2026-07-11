import fs from "node:fs";
import { envValue } from "./env.mjs";
import { LLMProviderUnavailable, LLMOutputInvalid } from "./llm-errors.mjs";

// Per-process call counter for the mock provider. Lets tests inject "first N
// calls fail" patterns via MEMORY_LLM_MOCK_FAIL_INDICES (comma-separated
// indices) without rewriting the dispatcher. The counter is shared across
// the whole process so a chain that retries through the same mock provider
// sees the index advance on every call.
let __mockCallIndex = 0;
export function __resetMockCallIndex() {
  __mockCallIndex = 0;
}

export function mockResponse() {
  const current = __mockCallIndex++;
  // Test seam: throw a specific error on the listed call indices so tests
  // can drive the chain through its failure paths without HTTP mocking.
  const failIndices = envValue("MEMORY_LLM_MOCK_FAIL_INDICES", "");
  if (failIndices) {
    const indices = failIndices
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter(Number.isFinite);
    if (indices.includes(current)) {
      const errType = envValue("MEMORY_LLM_MOCK_FAIL_ERROR", "model_not_found: mock-fail");
      // Use LLMProviderUnavailable so the chain treats it as a real provider
      // failure (transient → next provider, or model_not_found → next model).
      throw new LLMProviderUnavailable(errType);
    }
  }
  const inline = envValue("MEMORY_LLM_MOCK_RESPONSE", "");
  if (inline) return inline;
  const file = envValue("MEMORY_LLM_MOCK_FILE", "");
  if (file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      /* fall through */
    }
  }
  throw new LLMProviderUnavailable(
    "MEMORY_LLM_PROVIDER=mock but no MEMORY_LLM_MOCK_RESPONSE/FILE set",
  );
}

/**
 * @param {unknown} raw
 * @returns {unknown}
 */
export function parseStrictJson(raw) {
  const text = stripCodeFence(String(raw || "").trim());
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}\s*$|^\s*\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // fall through
      }
    }
    throw new LLMOutputInvalid("LLM output was not valid JSON", text);
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripCodeFence(text) {
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return fence ? fence[1] : text;
}

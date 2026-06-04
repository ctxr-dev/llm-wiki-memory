import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llm-chain-"));
process.env.MEMORY_DATA_DIR = TMP_DATA_DIR;
fs.mkdirSync(path.join(TMP_DATA_DIR, "settings"), { recursive: true });

const { callLLMChain, LLMProviderUnavailable, LLMOutputInvalid } = await import("../scripts/lib/llm.mjs");

after(() => {
  fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

const ENV_KEYS = [
  "MEMORY_LLM_PROVIDER",
  "MEMORY_LLM_MODEL",
  "MEMORY_LLM_BASE_URL",
  "MEMORY_LLM_MOCK_RESPONSE",
  "MEMORY_LLM_MOCK_FILE",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_MODEL",
  "OPENAI_MODEL",
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

// Build an in-memory config so we don't hit the filesystem on every chain
// scenario. The dispatcher accepts `configOverride` to short-circuit
// settings() for tests.
function chainConfig({ chain, providerModels = {} }) {
  // callLLMChain reads ONLY config.providers.{chain,<provider>.models}; it
  // never touches config.flush. So this stub deliberately omits a flush block
  // (an earlier version carried a snake_case one that was both inert AND a
  // copy-paste trap for the camelCase schema — removed).
  const known = ["mock", "anthropic", "openai", "openai-compatible", "claude", "codex", "cursor"];
  const providers = { chain: chain.slice() };
  for (const p of known) {
    providers[p] = { models: (providerModels[p] || []).slice() };
  }
  return Object.freeze({
    providers: Object.freeze({
      chain: Object.freeze(providers.chain),
      ...Object.fromEntries(known.map((p) => [p, Object.freeze({ models: Object.freeze(providers[p].models) })])),
    }),
  });
}

test("chain: empty chain -> LLMProviderUnavailable", async () => {
  clearEnv();
  await assert.rejects(
    () => callLLMChain({ systemPrompt: "s", userPrompt: "u", configOverride: chainConfig({ chain: [] }) }),
    /no LLM providers configured/i,
  );
});

test("chain: mock provider returns parsed JSON via the chain wrapper with provenance", async (t) => {
  clearEnv();
  t.after(clearEnv);
  process.env.MEMORY_LLM_MOCK_RESPONSE = '{"atoms":[{"id":"a"}]}';
  const cfg = chainConfig({ chain: ["mock"] });
  const { result, provenance } = await callLLMChain({ systemPrompt: "s", userPrompt: "u", configOverride: cfg });
  assert.deepEqual(result, { atoms: [{ id: "a" }] });
  assert.equal(provenance.final_provider, "mock:(default)");
  assert.deepEqual(provenance.provider_chain_tried, ["mock:(default)"]);
  assert.deepEqual(provenance.failure_reasons, []);
});

test("chain: anthropic with no API key -> failure recorded; chain continues to next provider", async (t) => {
  clearEnv();
  t.after(clearEnv);
  process.env.MEMORY_LLM_MOCK_RESPONSE = '{"ok":1}';
  const cfg = chainConfig({
    chain: ["anthropic", "mock"],
    providerModels: { anthropic: ["fixture-a"] },
  });
  const { result, provenance } = await callLLMChain({ systemPrompt: "s", userPrompt: "u", configOverride: cfg });
  assert.deepEqual(result, { ok: 1 });
  // Anthropic was tried (and failed because no API key); mock answered.
  assert.equal(provenance.final_provider, "mock:(default)");
  assert.equal(provenance.provider_chain_tried[0], "anthropic:fixture-a");
  assert.equal(provenance.provider_chain_tried[1], "mock:(default)");
  assert.equal(provenance.failure_reasons.length, 1);
  assert.equal(provenance.failure_reasons[0].provider, "anthropic");
  assert.equal(provenance.failure_reasons[0].model, "fixture-a");
  assert.match(provenance.failure_reasons[0].error, /ANTHROPIC_API_KEY/);
});

test("chain: API provider with empty models[] is skipped entirely", async (t) => {
  clearEnv();
  t.after(clearEnv);
  process.env.MEMORY_LLM_MOCK_RESPONSE = '{"x":1}';
  const cfg = chainConfig({
    chain: ["anthropic", "mock"],
    providerModels: { anthropic: [] },
  });
  const { provenance } = await callLLMChain({ systemPrompt: "s", userPrompt: "u", configOverride: cfg });
  // Anthropic recorded as a failure ("no models configured") without
  // actually trying any model:label combination.
  const tried = provenance.provider_chain_tried;
  assert.equal(tried.includes("anthropic:"), false);
  // mock answered.
  assert.equal(provenance.final_provider, "mock:(default)");
  const f = provenance.failure_reasons.find((x) => x.provider === "anthropic");
  assert.ok(f && /no models configured/i.test(f.error), `expected no-models reason, got ${JSON.stringify(f)}`);
});

test("chain: all providers exhausted -> LLMProviderUnavailable carries provenance", async () => {
  clearEnv();
  const cfg = chainConfig({
    chain: ["anthropic"],
    providerModels: { anthropic: ["fixture-a", "fixture-b"] },
  });
  let caught;
  try {
    await callLLMChain({ systemPrompt: "s", userPrompt: "u", configOverride: cfg });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof LLMProviderUnavailable);
  assert.ok(caught.provenance);
  // anthropic failed once on "no API key" (transient → moves on to next
  // provider, doesn't iterate models within), so only the first model
  // label is recorded.
  assert.equal(caught.provenance.provider_chain_tried.length, 1);
  assert.equal(caught.provenance.failure_reasons.length, 1);
});

test("chain: mock with invalid JSON throws LLMOutputInvalid; chain still advances", async (t) => {
  clearEnv();
  t.after(clearEnv);
  process.env.MEMORY_LLM_MOCK_RESPONSE = "not-json-at-all";
  const cfg = chainConfig({ chain: ["mock"] });
  let caught;
  try {
    await callLLMChain({ systemPrompt: "s", userPrompt: "u", configOverride: cfg });
  } catch (err) {
    caught = err;
  }
  // Final answer is LLMProviderUnavailable because chain exhausted; the
  // underlying error was an LLMOutputInvalid recorded in failure_reasons.
  assert.ok(caught instanceof LLMProviderUnavailable);
  const f = caught.provenance.failure_reasons[0];
  assert.equal(f.provider, "mock");
  assert.match(f.error, /JSON|valid/i);
});

test("chain: cursor provider is recognized (registered in the dispatcher)", async (t) => {
  clearEnv();
  t.after(clearEnv);
  // cursor-agent is not on PATH in CI; the chain should record the
  // ENOENT-style failure rather than throwing an "unknown provider" error.
  const cfg = chainConfig({ chain: ["cursor"] });
  let caught;
  try {
    await callLLMChain({ systemPrompt: "s", userPrompt: "u", configOverride: cfg });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof LLMProviderUnavailable);
  assert.equal(caught.provenance.provider_chain_tried[0], "cursor:(default)");
  assert.equal(caught.provenance.failure_reasons[0].provider, "cursor");
  // Either ENOENT-on-spawn or a deeper failure mode — the dispatcher must
  // NOT report "unknown provider in chain".
  assert.doesNotMatch(caught.provenance.failure_reasons[0].error, /unknown provider/i);
});

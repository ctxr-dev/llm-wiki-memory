import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalEndpoint, health } from "../scripts/lib/llm.mjs";

const LLM_ENV_KEYS = [
  "MEMORY_LLM_PROVIDER",
  "MEMORY_LLM_MODEL",
  "MEMORY_LLM_BASE_URL",
  "MEMORY_LLM_MOCK_RESPONSE",
  "MEMORY_LLM_MOCK_FILE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
];

function clearLlmEnv() {
  for (const key of LLM_ENV_KEYS) delete process.env[key];
}

test("isLocalEndpoint: localhost is local", () => {
  assert.equal(isLocalEndpoint("http://localhost:11434/v1"), true);
});

test("isLocalEndpoint: 127.0.0.1 is loopback", () => {
  assert.equal(isLocalEndpoint("http://127.0.0.1:8000"), true);
});

test("isLocalEndpoint: IPv6 loopback ::1 is local", () => {
  assert.equal(isLocalEndpoint("http://[::1]:11434"), true);
});

test("isLocalEndpoint: 10.x.x.x is RFC1918", () => {
  assert.equal(isLocalEndpoint("http://10.0.0.5/v1"), true);
});

test("isLocalEndpoint: 192.168.x.x is RFC1918", () => {
  assert.equal(isLocalEndpoint("http://192.168.1.5/v1"), true);
});

test("isLocalEndpoint: 172.16.x.x is RFC1918 boundary (low)", () => {
  assert.equal(isLocalEndpoint("http://172.16.0.1/v1"), true);
});

test("isLocalEndpoint: 172.31.x.x is RFC1918 boundary (high)", () => {
  assert.equal(isLocalEndpoint("http://172.31.255.255/v1"), true);
});

test("isLocalEndpoint: 172.15.x.x is outside RFC1918", () => {
  assert.equal(isLocalEndpoint("http://172.15.0.1/v1"), false);
});

test("isLocalEndpoint: 172.32.x.x is outside RFC1918", () => {
  assert.equal(isLocalEndpoint("http://172.32.0.1/v1"), false);
});

test("isLocalEndpoint: public OpenAI endpoint is not local", () => {
  assert.equal(isLocalEndpoint("https://api.openai.com/v1"), false);
});

test("isLocalEndpoint: arbitrary public host is not local", () => {
  assert.equal(isLocalEndpoint("https://example.com/v1"), false);
});

test("isLocalEndpoint: malformed URL returns false", () => {
  assert.equal(isLocalEndpoint("garbage"), false);
});

test("isLocalEndpoint: empty string returns false", () => {
  assert.equal(isLocalEndpoint(""), false);
});

test("health: mock provider with MOCK_RESPONSE is available", async (t) => {
  clearLlmEnv();
  t.after(clearLlmEnv);
  process.env.MEMORY_LLM_PROVIDER = "mock";
  process.env.MEMORY_LLM_MOCK_RESPONSE = '{"ok":true}';
  const h = await health();
  assert.equal(h.provider, "mock");
  assert.equal(h.available, true);
});

test("health: mock provider with no MOCK env is unavailable", async (t) => {
  clearLlmEnv();
  t.after(clearLlmEnv);
  process.env.MEMORY_LLM_PROVIDER = "mock";
  const h = await health();
  assert.equal(h.provider, "mock");
  assert.equal(h.available, false);
});

test("health: anthropic with ANTHROPIC_API_KEY is available, model includes claude-", async (t) => {
  clearLlmEnv();
  t.after(clearLlmEnv);
  process.env.MEMORY_LLM_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test";
  const h = await health();
  assert.equal(h.provider, "anthropic");
  assert.equal(h.available, true);
  assert.ok(typeof h.model === "string" && h.model.includes("claude-"), `expected model to include "claude-", got: ${h.model}`);
});

test("health: anthropic without key is unavailable, reason mentions ANTHROPIC_API_KEY", async (t) => {
  clearLlmEnv();
  t.after(clearLlmEnv);
  process.env.MEMORY_LLM_PROVIDER = "anthropic";
  const h = await health();
  assert.equal(h.provider, "anthropic");
  assert.equal(h.available, false);
  assert.ok(h.reason.includes("ANTHROPIC_API_KEY"), `expected reason to mention ANTHROPIC_API_KEY, got: ${h.reason}`);
});

test("health: openai with OPENAI_API_KEY uses public baseUrl and is available", async (t) => {
  clearLlmEnv();
  t.after(clearLlmEnv);
  process.env.MEMORY_LLM_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test";
  const h = await health();
  assert.equal(h.provider, "openai");
  assert.equal(h.available, true);
  assert.equal(h.baseUrl, "https://api.openai.com/v1");
});

test("health: openai without key is unavailable", async (t) => {
  clearLlmEnv();
  t.after(clearLlmEnv);
  process.env.MEMORY_LLM_PROVIDER = "openai";
  const h = await health();
  assert.equal(h.provider, "openai");
  assert.equal(h.available, false);
});

test("health: openai-compatible local endpoint without key is available", async (t) => {
  clearLlmEnv();
  t.after(clearLlmEnv);
  process.env.MEMORY_LLM_PROVIDER = "openai-compatible";
  process.env.MEMORY_LLM_BASE_URL = "http://localhost:11434/v1";
  const h = await health();
  assert.equal(h.provider, "openai-compatible");
  assert.equal(h.available, true);
  assert.ok(h.baseUrl.includes("localhost"), `expected baseUrl to include "localhost", got: ${h.baseUrl}`);
});

test("health: openai-compatible non-local endpoint without key is unavailable", async (t) => {
  clearLlmEnv();
  t.after(clearLlmEnv);
  process.env.MEMORY_LLM_PROVIDER = "openai-compatible";
  process.env.MEMORY_LLM_BASE_URL = "https://public.example.com";
  const h = await health();
  assert.equal(h.provider, "openai-compatible");
  assert.equal(h.available, false);
});

test("health: unknown provider is unavailable with reason mentioning unknown", async (t) => {
  clearLlmEnv();
  t.after(clearLlmEnv);
  process.env.MEMORY_LLM_PROVIDER = "garbage";
  const h = await health();
  assert.equal(h.available, false);
  assert.ok(/unknown/i.test(h.reason), `expected reason to mention "unknown", got: ${h.reason}`);
});

test("health: MEMORY_LLM_MODEL overrides anthropic model", async (t) => {
  clearLlmEnv();
  t.after(clearLlmEnv);
  process.env.MEMORY_LLM_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.MEMORY_LLM_MODEL = "claude-custom-override";
  const h = await health();
  assert.equal(h.model, "claude-custom-override");
});

test("health: MEMORY_LLM_MODEL overrides openai model", async (t) => {
  clearLlmEnv();
  t.after(clearLlmEnv);
  process.env.MEMORY_LLM_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test";
  process.env.MEMORY_LLM_MODEL = "gpt-custom-override";
  const h = await health();
  assert.equal(h.model, "gpt-custom-override");
});

test("health: claude provider reason mentions CLI (availability depends on host PATH)", async (t) => {
  clearLlmEnv();
  t.after(clearLlmEnv);
  process.env.MEMORY_LLM_PROVIDER = "claude";
  const h = await health();
  assert.equal(h.provider, "claude");
  assert.ok(/CLI/.test(h.reason), `expected reason to mention "CLI", got: ${h.reason}`);
});

test("health: codex provider reason mentions CLI (availability depends on host PATH)", async (t) => {
  clearLlmEnv();
  t.after(clearLlmEnv);
  process.env.MEMORY_LLM_PROVIDER = "codex";
  const h = await health();
  assert.equal(h.provider, "codex");
  assert.ok(/CLI/.test(h.reason), `expected reason to mention "CLI", got: ${h.reason}`);
});

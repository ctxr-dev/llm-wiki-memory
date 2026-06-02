// get_memory_config + reload_provider must surface an `llm` block describing
// the resolved provider, its availability, and (where applicable) baseUrl/model.
// We spawn the real MCP server once to confirm the tools are wired up end-to-end,
// then drive health() directly for the env-dependent provider scenarios — that
// keeps the per-provider assertions hermetic without restarting the server per
// case (the server's resolved provider is captured at handler-call time via
// envValue, but tests for mock/anthropic specifics are cleaner against the
// underlying function).

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setupWorkspace, cleanup, SRC } from "./harness.mjs";
import { health } from "../scripts/lib/llm.mjs";

const { dataDir } = setupWorkspace();

let client;
let transport;

before(async () => {
  client = new Client({ name: "lwm-llm-config-test", version: "0.0.0" }, { capabilities: {} });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    // The MCP server reads MEMORY_LLM_PROVIDER from the env of its own process;
    // a per-test setenv in THIS process does not reach it. So we boot the server
    // with the default provider (claude) and verify the SHAPE of the response;
    // env-sensitive provider permutations are covered by direct health() tests
    // below.
    env: { ...process.env },
    cwd: SRC,
  });
  await client.connect(transport);
});

after(async () => {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  cleanup(dataDir);
});

function parse(res) {
  return JSON.parse(res.content[0].text);
}

function clearLlmEnv() {
  for (const n of [
    "MEMORY_LLM_PROVIDER",
    "MEMORY_LLM_MOCK_RESPONSE",
    "MEMORY_LLM_MOCK_FILE",
    "MEMORY_LLM_MODEL",
    "MEMORY_LLM_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
  ]) {
    delete process.env[n];
  }
}

test("get_memory_config response includes an `llm` block with provider/available/reason", async () => {
  const cfg = parse(await client.callTool({ name: "get_memory_config", arguments: {} }));
  assert.ok(cfg.llm, "llm block is present on the config payload");
  assert.equal(typeof cfg.llm.provider, "string", "llm.provider is a string");
  assert.equal(typeof cfg.llm.available, "boolean", "llm.available is a boolean");
  assert.equal(typeof cfg.llm.reason, "string", "llm.reason is a string");
});

test("reload_provider returns { ok: true, llm: { provider, available, reason } }", async () => {
  const r = parse(await client.callTool({ name: "reload_provider", arguments: {} }));
  assert.equal(r.ok, true, "reload_provider returns ok:true");
  assert.ok(r.llm, "llm block is present on the reload payload");
  assert.equal(typeof r.llm.provider, "string");
  assert.equal(typeof r.llm.available, "boolean");
  assert.equal(typeof r.llm.reason, "string");
});

test("health(): mock provider with MEMORY_LLM_MOCK_RESPONSE reports available:true", async () => {
  clearLlmEnv();
  process.env.MEMORY_LLM_PROVIDER = "mock";
  process.env.MEMORY_LLM_MOCK_RESPONSE = '{"ok":true}';
  const r = await health();
  assert.equal(r.provider, "mock");
  assert.equal(r.available, true, `expected available:true, got ${JSON.stringify(r)}`);
});

test("health(): mock provider with no response/file set reports available:false", async () => {
  clearLlmEnv();
  process.env.MEMORY_LLM_PROVIDER = "mock";
  const r = await health();
  assert.equal(r.provider, "mock");
  assert.equal(r.available, false);
});

test("health(): anthropic provider with no ANTHROPIC_API_KEY reports available:false + reason names the env var", async () => {
  clearLlmEnv();
  process.env.MEMORY_LLM_PROVIDER = "anthropic";
  const r = await health();
  assert.equal(r.provider, "anthropic");
  assert.equal(r.available, false);
  assert.match(r.reason, /ANTHROPIC_API_KEY/, `reason should mention ANTHROPIC_API_KEY, got: ${r.reason}`);
  // model is reported for anthropic even when unavailable (default fallback).
  assert.equal(typeof r.model, "string");
});

test("health(): anthropic provider with ANTHROPIC_API_KEY set reports available:true", async () => {
  clearLlmEnv();
  process.env.MEMORY_LLM_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-key";
  const r = await health();
  assert.equal(r.provider, "anthropic");
  assert.equal(r.available, true);
  assert.match(r.reason, /ANTHROPIC_API_KEY/);
});

test("health(): openai provider includes baseUrl + model fields", async () => {
  clearLlmEnv();
  process.env.MEMORY_LLM_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  const r = await health();
  assert.equal(r.provider, "openai");
  assert.equal(typeof r.baseUrl, "string");
  assert.equal(typeof r.model, "string");
  assert.equal(r.available, true);
});

test("health(): openai-compatible at a local endpoint is available even without an API key", async () => {
  clearLlmEnv();
  process.env.MEMORY_LLM_PROVIDER = "openai-compatible";
  process.env.MEMORY_LLM_BASE_URL = "http://localhost:11434/v1";
  const r = await health();
  assert.equal(r.provider, "openai-compatible");
  assert.equal(r.available, true, `local endpoint should be available without a key, got ${JSON.stringify(r)}`);
  assert.equal(r.baseUrl, "http://localhost:11434/v1");
});

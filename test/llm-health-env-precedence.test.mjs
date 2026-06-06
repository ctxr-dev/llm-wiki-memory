// health() provider precedence: an explicit process.env override wins; a
// provider configured via the settings/.env FILE is NOT an override — it flows
// through settings.providers.chain (where a settings override can re-head it),
// so health() reports the chain head, matching what the dispatcher actually
// uses. Regression guard for the .env short-circuit bug (health read envValue,
// which falls back to the .env file, and reported the .env provider even when a
// settings override re-headed the chain).
//
// This test WRITES the .env into an isolated workspace, so it fails on the old
// code regardless of the developer's ambient install (the prior test only
// tripped when the real install happened to set MEMORY_LLM_PROVIDER in .env).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

// setupWorkspace BEFORE importing any env-reading module, so env.mjs freezes its
// MEMORY_DATA_DIR / ENV_PATH consts to THIS workspace, not the ambient install.
const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

// Configure a provider via the dotenv FILE only (no process.env override).
const envPath = path.join(dataDir, "settings", ".env");
fs.mkdirSync(path.dirname(envPath), { recursive: true });
fs.writeFileSync(envPath, "MEMORY_LLM_PROVIDER=claude\n");

const { health } = await import("../scripts/lib/llm.mjs");
const settings = await import("../scripts/lib/settings.mjs");

test("health(): a .env-configured provider does NOT short-circuit a settings chain re-head", async () => {
  delete process.env.MEMORY_LLM_PROVIDER;
  // The .env file says claude, but a settings override re-heads the chain to
  // anthropic. health() must report the chain head the dispatcher uses.
  settings.__setSettingsOverride({ providers: { chain: ["anthropic", "claude"], anthropic: { models: ["m1"] } } });
  try {
    const r = await health();
    assert.equal(
      r.provider,
      "anthropic",
      `health must report the resolved chain head, not the .env provider; got ${r.provider}`,
    );
  } finally {
    settings.__clearSettingsOverride();
  }
});

test("health(): an explicit process.env provider still overrides the chain head", async () => {
  process.env.MEMORY_LLM_PROVIDER = "codex";
  settings.__setSettingsOverride({ providers: { chain: ["anthropic"], anthropic: { models: ["m1"] } } });
  try {
    const r = await health();
    assert.equal(r.provider, "codex", "an explicit process.env provider wins over the chain head");
  } finally {
    settings.__clearSettingsOverride();
    delete process.env.MEMORY_LLM_PROVIDER;
  }
});

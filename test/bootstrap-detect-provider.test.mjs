import { test } from "node:test";
import assert from "node:assert/strict";
import { detectProvider, realHasCommand } from "../scripts/bootstrap/detect-provider.mjs";

const none = () => false;
const base = { env: {}, hasCommand: none, probeOllama: none };

test("explicit provider short-circuits the ladder (no probing)", () => {
  assert.deepEqual(detectProvider({ ...base, explicit: "mock", hasCommand: () => true }), {
    provider: "mock",
    baseUrlHint: "",
  });
});

test("claude CLI wins first", () => {
  assert.equal(detectProvider({ ...base, hasCommand: (c) => c === "claude" }).provider, "claude");
});

test("codex CLI wins when claude is absent", () => {
  assert.equal(detectProvider({ ...base, hasCommand: (c) => c === "codex" }).provider, "codex");
});

test("ANTHROPIC_API_KEY → anthropic (below the CLIs)", () => {
  assert.equal(detectProvider({ ...base, env: { ANTHROPIC_API_KEY: "x" } }).provider, "anthropic");
});

test("OPENAI_API_KEY → openai", () => {
  assert.equal(detectProvider({ ...base, env: { OPENAI_API_KEY: "x" } }).provider, "openai");
});

test("MEMORY_LLM_BASE_URL → openai-compatible (no hint pre-fill)", () => {
  const d = detectProvider({ ...base, env: { MEMORY_LLM_BASE_URL: "http://x" } });
  assert.equal(d.provider, "openai-compatible");
  assert.equal(d.baseUrlHint, "");
});

test("ollama probe → openai-compatible WITH the localhost base-url hint", () => {
  const d = detectProvider({ ...base, probeOllama: () => true });
  assert.equal(d.provider, "openai-compatible");
  assert.equal(d.baseUrlHint, "http://localhost:11434/v1");
});

test("nothing detected → mock fallback", () => {
  assert.deepEqual(detectProvider(base), { provider: "mock", baseUrlHint: "" });
});

test("priority order: a CLI beats an env key, an env key beats the ollama probe", () => {
  assert.equal(
    detectProvider({
      env: { ANTHROPIC_API_KEY: "x" },
      hasCommand: (c) => c === "claude",
      probeOllama: () => true,
    }).provider,
    "claude",
  );
  assert.equal(
    detectProvider({ env: { OPENAI_API_KEY: "x" }, hasCommand: none, probeOllama: () => true })
      .provider,
    "openai",
  );
});

test("win32 does NOT auto-select the claude/codex CLI (.cmd shims can't be spawned there) — steers to API/mock", () => {
  const cliPresent = () => true;
  // claude present but on win32 → skip the CLIs → fall through to API-key/mock.
  assert.equal(
    detectProvider({ hasCommand: cliPresent, probeOllama: none, platform: "win32" }).provider,
    "mock",
    "no API key + win32 + CLI present → mock, not claude",
  );
  assert.equal(
    detectProvider({
      env: { ANTHROPIC_API_KEY: "x" },
      hasCommand: cliPresent,
      probeOllama: none,
      platform: "win32",
    }).provider,
    "anthropic",
    "win32 prefers the fetch-based API key over the un-spawnable CLI",
  );
  // Same inputs on linux DO select the CLI (contrast).
  assert.equal(
    detectProvider({ hasCommand: cliPresent, probeOllama: none, platform: "linux" }).provider,
    "claude",
  );
});

test("realHasCommand finds a present binary and misses an absent one (real probe, per-platform)", () => {
  // Runs the platform-appropriate branch: `where` on the windows-latest CI leg
  // (would fail with the old sh-only probe), `sh -c command -v` on POSIX.
  assert.equal(realHasCommand("node"), true, "node is on PATH (we run under it)");
  assert.equal(realHasCommand("lwm-definitely-not-a-real-binary-xyz"), false, "bogus cmd absent");
});

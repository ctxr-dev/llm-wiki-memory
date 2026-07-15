#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Provider auto-detection ladder (first match wins). Pure: probes are injected
// so every branch is unit-testable; the CLI supplies the real env/command/ollama
// probes. The `mock` fallback lets a fresh clone run (tests pass, consolidate
// skips its LLM passes) instead of silently sitting on a missing "claude" CLI.

/** @typedef {{ provider: string, baseUrlHint: string }} Detection */

/**
 * @param {{ explicit?: string, env?: Record<string, string | undefined>, hasCommand: (c: string) => boolean, probeOllama: () => boolean }} args
 * @returns {Detection}
 */
export function detectProvider({ explicit, env = {}, hasCommand, probeOllama }) {
  if (explicit) return { provider: explicit, baseUrlHint: "" };
  if (hasCommand("claude")) return { provider: "claude", baseUrlHint: "" };
  if (hasCommand("codex")) return { provider: "codex", baseUrlHint: "" };
  if (env.ANTHROPIC_API_KEY) return { provider: "anthropic", baseUrlHint: "" };
  if (env.OPENAI_API_KEY) return { provider: "openai", baseUrlHint: "" };
  if (env.MEMORY_LLM_BASE_URL) return { provider: "openai-compatible", baseUrlHint: "" };
  // Probe-detected ollama on its default port: pre-fill MEMORY_LLM_BASE_URL.
  if (probeOllama())
    return { provider: "openai-compatible", baseUrlHint: "http://localhost:11434/v1" };
  return { provider: "mock", baseUrlHint: "" };
}

/** @param {string} cmd @returns {boolean} */
export function realHasCommand(cmd) {
  // Windows has no /bin/sh — use `where` (mirrors scripts/lib/llm-health.mjs, so
  // the install-time probe agrees with the runtime one). Else `sh -c command -v`.
  if (process.platform === "win32") {
    return spawnSync("where", [cmd], { stdio: "ignore" }).status === 0;
  }
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

/** @returns {boolean} */
function realProbeOllama() {
  if (!realHasCommand("curl")) return false;
  return (
    spawnSync("curl", ["-fsS", "--max-time", "1", "http://localhost:11434/api/version"], {
      stdio: "ignore",
    }).status === 0
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const explicit = process.argv[2] || "";
  const d = detectProvider({
    explicit,
    env: process.env,
    hasCommand: realHasCommand,
    probeOllama: realProbeOllama,
  });
  process.stdout.write(`${d.provider}\t${d.baseUrlHint}`);
}

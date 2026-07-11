import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// lwm- prefix so the harness's stale-workspace sweep covers a crashed run.
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-spawn-path-"));
process.env.MEMORY_DATA_DIR = TMP_DATA_DIR;
fs.mkdirSync(path.join(TMP_DATA_DIR, "settings"), { recursive: true });

const { callLLMChain, LLMProviderUnavailable } = await import("../scripts/lib/llm.mjs");
const { CURATED_CLI_DIRS } = await import("../scripts/lib/cron-path.mjs");

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-spawn-home-"));

after(() => {
  fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

function chainConfig(chain) {
  const known = ["mock", "anthropic", "openai", "openai-compatible", "claude", "codex", "cursor"];
  return Object.freeze({
    providers: Object.freeze({
      chain: Object.freeze(chain.slice()),
      ...Object.fromEntries(known.map((p) => [p, Object.freeze({ models: Object.freeze([]) })])),
    }),
  });
}

function writeStub(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stub = path.join(dir, "cursor-agent");
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '{"ok":"stub"}'\n`, { mode: 0o755 });
  return stub;
}

// launchd's default PATH — the exact environment of the 2026-06-04 incident.
const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function withMinimalEnv(t, home) {
  const prevPath = process.env.PATH;
  const prevHome = process.env.HOME;
  process.env.PATH = MINIMAL_PATH;
  process.env.HOME = home;
  t.after(() => {
    if (prevPath !== undefined) process.env.PATH = prevPath;
    else delete process.env.PATH;
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
  });
}

test("runtime healing: a CLI reachable only via ~/.local/bin spawns under a minimal launchd PATH", async (t) => {
  writeStub(path.join(TMP_HOME, ".local", "bin"));
  withMinimalEnv(t, TMP_HOME);
  const { result, provenance } = await callLLMChain({
    systemPrompt: "s",
    userPrompt: "u",
    configOverride: chainConfig(["cursor"]),
  });
  assert.deepEqual(result, { ok: "stub" });
  assert.equal(provenance.final_provider, "cursor:(default)");
});

test("negative control: a CLI outside every curated dir still ENOENTs under the minimal PATH", async (t) => {
  // Host assumption: no REAL cursor-agent in any absolute curated dir —
  // augmentSpawnEnv appends those unconditionally and would resolve it,
  // making this pass (or fail) for the wrong reason. Skip on such hosts.
  const absoluteCurated = CURATED_CLI_DIRS.filter((d) => d.startsWith("/"));
  if (absoluteCurated.some((d) => fs.existsSync(path.join(d, "cursor-agent")))) {
    t.skip("a real cursor-agent exists in a system-wide curated dir on this host");
    return;
  }
  const elsewhere = path.join(TMP_HOME, "elsewhere");
  writeStub(elsewhere);
  withMinimalEnv(t, path.join(TMP_HOME, "empty-home"));
  await assert.rejects(
    () =>
      callLLMChain({
        systemPrompt: "s",
        userPrompt: "u",
        configOverride: chainConfig(["cursor"]),
      }),
    LLMProviderUnavailable,
  );
});

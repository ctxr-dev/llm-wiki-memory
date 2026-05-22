import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Create an isolated temp data dir, point the env at it, and (optionally)
// materialise the hosted wiki. Must be called BEFORE importing any lib that
// reads env.mjs paths, since those are resolved at import time.
export function setupWorkspace({ init = true, projectModule = "testproj" } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-"));
  process.env.MEMORY_DATA_DIR = dataDir;
  process.env.MEMORY_EMBED_BACKEND = process.env.MEMORY_EMBED_BACKEND || "lexical";
  process.env.MEMORY_DEFAULT_PROJECT_MODULE = projectModule;
  process.env.LLM_WIKI_SKILL_CLI = path.join(
    SRC,
    "node_modules/@ctxr/skill-llm-wiki/scripts/cli.mjs",
  );
  // Deterministic git SHAs across runs.
  process.env.LLM_WIKI_FIXED_TIMESTAMP = process.env.LLM_WIKI_FIXED_TIMESTAMP || "1700000000";
  process.env.LLM_WIKI_NO_PROMPT = "1";

  const wiki = path.join(dataDir, "wiki");
  if (init) {
    const r = spawnSync(process.execPath, [path.join(SRC, "scripts/cli.mjs"), "init"], {
      env: process.env,
      encoding: "utf8",
    });
    if (r.status !== 0) {
      throw new Error(`wiki init failed: ${r.stderr || r.stdout}`);
    }
  }
  return { dataDir, wiki };
}

export function cleanup(dataDir) {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// Run a project script (compile.mjs / hooks/flush.mjs / etc.) as a child with
// the current env plus overrides. Returns {status, stdout, stderr}.
export function runScript(relPath, args = [], { stdin, env = {} } = {}) {
  return spawnSync(process.execPath, [path.join(SRC, relPath), ...args], {
    env: { ...process.env, ...env },
    input: stdin,
    encoding: "utf8",
  });
}

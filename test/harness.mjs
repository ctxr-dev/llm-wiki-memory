import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Sweep any lwm-* dirs older than this at every harness import. A test
// that crashes (SIGKILL, OOM, ENOSPC, or my own kill from a hung loop)
// can't run its `after()` cleanup and leaves a workspace behind. Without
// this sweep, those zombies pile up across runs and a runaway test can
// fill a 460 GB disk in minutes. One hour is a comfortable margin above
// any realistic test runtime while still cleaning up within a single
// developer day.
const STALE_WORKSPACE_AGE_MS = 60 * 60 * 1000;
sweepStaleWorkspaces();

function sweepStaleWorkspaces() {
  const root = os.tmpdir();
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_WORKSPACE_AGE_MS;
  for (const name of entries) {
    if (!name.startsWith("lwm-")) continue;
    const full = path.join(root, name);
    try {
      // lstat (NOT stat) so the sweep never follows a symlink — a stale
      // `lwm-*` symlink pointing somewhere on the filesystem (the user's
      // home dir, /, anywhere) must NEVER trigger a recursive delete on
      // the target. We only ever rm the directory itself.
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (!stat.isDirectory()) continue;
      if (stat.mtimeMs > cutoff) continue;
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      /* best effort — a permission error or race is not worth failing the test run */
    }
  }
}

// Track every dataDir the current process creates so a process-level
// signal handler can clean them all up even when individual `after()`
// hooks didn't fire (test killed, parent process killed, ENOSPC mid-test).
const TRACKED_DATA_DIRS = new Set();
let signalHandlersInstalled = false;
function installSignalCleanup() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const handler = () => {
    for (const dir of TRACKED_DATA_DIRS) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      handler();
      process.exit(130);
    });
  }
  process.on("exit", handler);
}

// Create an isolated temp data dir, point the env at it, and (optionally)
// materialise the hosted wiki. Must be called BEFORE importing any lib that
// reads env.mjs paths, since those are resolved at import time.
export function setupWorkspace({ init = true, projectModule = "testproj" } = {}) {
  installSignalCleanup();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-"));
  TRACKED_DATA_DIRS.add(dataDir);
  process.env.MEMORY_DATA_DIR = dataDir;
  process.env.MEMORY_DEFAULT_PROJECT_MODULE = projectModule;
  process.env.LLM_WIKI_SKILL_CLI = path.join(
    SRC,
    "node_modules/@ctxr/skill-llm-wiki/scripts/cli.mjs",
  );
  process.env.LLM_WIKI_FIXED_TIMESTAMP = process.env.LLM_WIKI_FIXED_TIMESTAMP || "1700000000";
  process.env.LLM_WIKI_NO_PROMPT = "1";

  // Tests use the LEXICAL embedding backend by default — avoids the 340 MB
  // bge model download on every fresh test workspace. `consolidate.enabled: true`
  // is set because the product default is opt-in/off; the consolidate + cron
  // suites need it on to exercise consolidation, and flag-specific tests
  // override it back to false. Each workspace gets its own settings.yaml.
  fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "settings", "settings.yaml"),
    "embed:\n  backend: lexical\nconsolidate:\n  enabled: true\n",
  );

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
    TRACKED_DATA_DIRS.delete(dataDir);
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

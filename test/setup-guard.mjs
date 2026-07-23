// Test-run safety preload. Wired via `node --test --import ./test/setup-guard.mjs`
// so it executes ONCE per test process BEFORE any test module — and therefore
// before env.mjs captures MEMORY_DATA_DIR into its load-time const.
//
// Guarantees no test can read or write the developer's REAL brain. It records the
// real brain's absolute path (computed exactly as env.mjs derives its default,
// from the clone location — HOME-independent, so a subprocess that fakes $HOME
// can't fool it) in LWM_REAL_BRAIN, arms LWM_FORBID_REAL_BRAIN, and — if
// MEMORY_DATA_DIR is unset or points at that real brain — redirects it to a
// throwaway temp dir. env.mjs then THROWS if any engine module (here OR in a child
// spawned with the inherited env) still resolves to exactly LWM_REAL_BRAIN, so the
// mistake is a loud crash rather than silent corruption. A /tmp fixture install
// (e.g. the bootstrap e2e) keeps working: its own `.llm-wiki-memory` is not the
// recorded real brain. A correct test overrides MEMORY_DATA_DIR again via
// setupWorkspace(); this only sets a safe floor for the interval before that runs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Mirror env.mjs's default-derivation from the clone location.
// setup-guard.mjs is <install>/src/test/setup-guard.mjs.
const MEMORY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inMemorySrc =
  path.basename(MEMORY_DIR) === "src" &&
  path.basename(path.dirname(MEMORY_DIR)) === ".llm-wiki-memory";
const WORKSPACE_DIR = path.resolve(MEMORY_DIR, inMemorySrc ? "../.." : "..");
const REAL_BRAIN = path.join(WORKSPACE_DIR, ".llm-wiki-memory");

const cur = process.env.MEMORY_DATA_DIR;
const resolvesToReal = !cur || cur === "" || path.resolve(cur) === path.resolve(REAL_BRAIN);
if (resolvesToReal) {
  process.env.MEMORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-guard-"));
}
process.env.LWM_REAL_BRAIN = REAL_BRAIN;
process.env.LWM_FORBID_REAL_BRAIN = "1";

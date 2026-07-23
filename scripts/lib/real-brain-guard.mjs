// The single source of truth for "is this the developer's REAL brain?" — used by
// env.mjs (the load-time refusal), test/setup-guard.mjs (the --import preload), and
// the canary test. Deriving it in one place keeps env.mjs and the preload from
// drifting apart. It reads no env at module scope and imports nothing from the
// engine, so the preload can load it before env.mjs captures MEMORY_DATA_DIR.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The real brain data dir, derived from THIS module's clone location exactly as
// env.mjs derives its default MEMORY_DATA_DIR (HOME-independent, so a subprocess
// that fakes $HOME cannot fool it). scripts/lib -> clone root is two levels up.
/** @returns {string} */
export function realBrainDir() {
  const memoryDir = path.resolve(HERE, "..", "..");
  const inMemorySrc =
    path.basename(memoryDir) === "src" &&
    path.basename(path.dirname(memoryDir)) === ".llm-wiki-memory";
  const workspaceDir = path.resolve(memoryDir, inMemorySrc ? "../.." : "..");
  return path.join(workspaceDir, ".llm-wiki-memory");
}

// Canonicalise for comparison: realpath (dereferences symlinks AND normalises case
// on case-insensitive filesystems) when the path exists, else a plain resolve. This
// closes the symlink / different-case aliasing bypass a lexical compare would miss.
/** @param {string} p @returns {string} */
function canonical(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** @param {string} dir @returns {boolean} */
export function isRealBrain(dir) {
  return Boolean(dir) && canonical(dir) === canonical(realBrainDir());
}

// TEST-SAFETY GUARD (production-inert). Called at env.mjs load. When a test context
// arms LWM_FORBID_REAL_BRAIN=1 (test/setup-guard.mjs, propagated to child procs),
// throw if MEMORY_DATA_DIR resolves to the real brain — turning a test that failed
// to isolate its data dir into a loud crash instead of silent corruption of the
// developer's memory (a past incident hard-deleted ~590 real leaves this way).
// FAIL-CLOSED: if the marker is armed but LWM_REAL_BRAIN was not propagated, fall
// back to the derived real brain rather than going inert. A /tmp fixture install
// (bootstrap e2e) keeps working — its own brain is not the real one.
/** @param {string} memoryDataDir */
export function assertTestBrainIsolation(memoryDataDir) {
  if (process.env.LWM_FORBID_REAL_BRAIN !== "1") return;
  const declared = process.env.LWM_REAL_BRAIN;
  const real = declared && declared !== "" ? declared : realBrainDir();
  if (canonical(memoryDataDir) === canonical(real)) {
    throw new Error(
      `LWM_FORBID_REAL_BRAIN: refusing to use the real workspace brain (${memoryDataDir}) in a ` +
        "test context. A test must point MEMORY_DATA_DIR at a temp dir — call setupWorkspace() (or " +
        "set MEMORY_DATA_DIR) BEFORE importing any engine module, since env.mjs captures it at load.",
    );
  }
}

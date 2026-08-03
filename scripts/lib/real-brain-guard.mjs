// The single source of truth for "is this the developer's REAL brain?" — used by
// env.mjs (the load-time refusal), test/setup-guard.mjs (the --import preload), and
// the canary test. Deriving it in one place keeps env.mjs and the preload from
// drifting apart. It reads no env at module scope and imports nothing from the
// engine, so the preload can load it before env.mjs captures MEMORY_DATA_DIR.

import fs from "node:fs";
import os from "node:os";
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

// Whether a path lives under the OS temp dir — i.e. is a throwaway fixture, never the
// developer's real brain.
/** @param {string} p @returns {boolean} */
function isUnderTmp(p) {
  const tmp = canonical(os.tmpdir());
  const target = canonical(p);
  return target === tmp || target.startsWith(tmp + path.sep);
}

/** @param {string} dir @returns {boolean} */
export function isRealBrain(dir) {
  return Boolean(dir) && canonical(dir) === canonical(realBrainDir());
}

// TEST-SAFETY GUARD (production-inert). Called at env.mjs load. Throws if
// MEMORY_DATA_DIR resolves to the real brain inside a test context — turning a test
// that failed to isolate its data dir into a loud crash instead of silent corruption
// of the developer's memory (a past incident hard-deleted ~590 real leaves this way).
// FAIL-CLOSED: if the marker is armed but LWM_REAL_BRAIN was not propagated, fall
// back to the derived real brain rather than going inert. A /tmp fixture install
// (bootstrap e2e) keeps working — its own brain is not the real one.
//
// TWO independent signals arm it, deliberately:
//   - LWM_FORBID_REAL_BRAIN=1, set by the test/setup-guard.mjs preload the npm scripts
//     wire in (and propagated to child processes); and
//   - NODE_TEST_CONTEXT, which the node:test runner sets on every spawned test child.
//     It is absent under --experimental-test-isolation=none and when a test file is run
//     as a plain script, so it narrows the hole rather than closing it completely — the
//     preload remains the primary signal and the npm scripts remain the supported door.
// The preload alone was not enough: it is attached by the npm scripts, so a bare
// `node --test test/<file>.test.mjs` skipped it entirely and ran unguarded — and a test
// that overrides the backend then wrote lexical vectors straight over the real brain's
// caches. Relying on an opt-in preload to protect irreplaceable data made the protection
// exactly as reliable as remembering to type it. The runner's own marker cannot be
// forgotten, which is the whole point.
/** @param {string} memoryDataDir */
export function assertTestBrainIsolation(memoryDataDir) {
  const inTestRun =
    process.env.LWM_FORBID_REAL_BRAIN === "1" || Boolean(process.env.NODE_TEST_CONTEXT);
  if (!inTestRun) return;
  const declared = process.env.LWM_REAL_BRAIN;
  const real = declared && declared !== "" ? declared : realBrainDir();
  // A FIXTURE install (the bootstrap e2e copies the clone under os.tmpdir()) derives its
  // OWN data dir as "the real brain" and would self-match — refusing the very dir the
  // fixture was told to use. The preload propagates LWM_REAL_BRAIN, so a declared value
  // is always trusted; only the DERIVED fallback needs this, and the developer's real
  // brain is never inside the temp dir.
  if (!declared && isUnderTmp(real)) return;
  if (canonical(memoryDataDir) === canonical(real)) {
    throw new Error(
      `refusing to use the real workspace brain (${memoryDataDir}) in a test context ` +
        `(armed by ${process.env.LWM_FORBID_REAL_BRAIN === "1" ? "LWM_FORBID_REAL_BRAIN" : "NODE_TEST_CONTEXT"}). ` +
        "A test must point MEMORY_DATA_DIR at a temp dir — call setupWorkspace() (or set " +
        "MEMORY_DATA_DIR) BEFORE importing any engine module, since env.mjs captures it at load.",
    );
  }
}

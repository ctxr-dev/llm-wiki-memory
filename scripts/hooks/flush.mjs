import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { MEMORY_DIR } from "../lib/env.mjs";
import { isReentrant, reentryEnv } from "../lib/reentry.mjs";
import { writeFileAtomic } from "../lib/atomic-write.mjs";
import { logBreadcrumb, shortId } from "./flush-state.mjs";
import { readStdin, buildSourceMaterial, SkipMemory } from "./flush-source.mjs";
import { preserveFailedContext } from "./flush-stash.mjs";
import { runWorker } from "./flush-worker.mjs";

// flush.mjs has two phases (the deterministic-capture mechanism):
//
//   Hook front (default): runs INSIDE the Claude Code hook. Does only fast
//   local I/O: read the transcript from stdin, extract + redact the context,
//   stage it to a temp file, spawn the worker DETACHED, and exit. No network,
//   so it never blocks on the distiller and never trips the hook timeout.
//
//   Worker (--worker <ctxFile> <sessionId> <mode>): runs in the background,
//   decoupled from the hook timeout. Distils the context with the configured
//   LLM (retrying a few times to get the best result) and ALWAYS records an
//   outcome to the daily slot (atoms, a nothing-durable marker, or the
//   truncated raw context as a fallback on failure), plus a persistent
//   breadcrumb in state/.flush.log. No silent exit.

const VALID_MODES = new Set(["pre-compact", "post-compact", "session-end"]);
const SELF_PATH = fileURLToPath(import.meta.url);

// Phase 1: hook front (fast, deterministic, no network)

/** @param {string} mode */
function runHookFront(mode) {
  const rawInput = readStdin();
  let source;
  try {
    source = buildSourceMaterial(rawInput, mode);
  } catch (err) {
    if (err instanceof SkipMemory) {
      // Genuinely nothing to capture (too few turns / empty transcript).
      // This is legitimate, but now it is logged rather than invisible.
      logBreadcrumb(`hook ${mode}: skip (${err.message})`);
      return;
    }
    logBreadcrumb(
      `hook ${mode}: error building context (${err instanceof Error ? err.message : String(err)})`,
    );
    return;
  }

  let ctxFile;
  try {
    // Unpredictable name (mitigates a TOCTOU pre-create on a shared /tmp) and
    // owner-only mode: the staged context is redacted but can still hold
    // sensitive project content, so it must not be world-readable.
    ctxFile = path.join(os.tmpdir(), `memory-flush-${randomUUID()}.json`);
    // Atomic: a torn staged-context file would make the worker's JSON.parse
    // throw and lose the only out-of-band copy of the capture.
    writeFileAtomic(ctxFile, JSON.stringify(source), { mode: 0o600 });
  } catch (err) {
    logBreadcrumb(
      `hook ${mode}: could not stage context (${err instanceof Error ? err.message : String(err)})`,
    );
    return;
  }

  // A spawn failure can surface three ways: a synchronous throw, an async
  // ChildProcess 'error' event (EACCES/ENOENT), or a missing pid. Handle all of
  // them the same way (preserve the staged context + log) via a one-shot guard,
  // and always attach an 'error' listener so an async failure is never an
  // uncaught exception that crashes the hook.
  let handledSpawnFailure = false;
  /** @param {unknown} spawnErr */
  const onSpawnFailure = (spawnErr) => {
    if (handledSpawnFailure) return;
    handledSpawnFailure = true;
    const preserved = preserveFailedContext(ctxFile, source.sessionId);
    logBreadcrumb(
      `hook ${mode}: worker spawn failed (${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)})` +
        (preserved ? `; context preserved at ${preserved}` : "; context removed"),
    );
  };

  let child;
  try {
    child = spawn(process.execPath, [SELF_PATH, "--worker", ctxFile, source.sessionId, mode], {
      detached: true,
      stdio: "ignore",
      env: reentryEnv("memory-flush"),
      cwd: MEMORY_DIR,
    });
  } catch (err) {
    onSpawnFailure(err);
    return;
  }
  child.on("error", onSpawnFailure);
  if (!child.pid) {
    onSpawnFailure(new Error("spawn returned no pid"));
    return;
  }
  child.unref();
  logBreadcrumb(
    `hook ${mode}: spawned worker (pid ${child.pid}, session ${shortId(source.sessionId)}, ${source.turnCount} turns)`,
  );
}

/** @param {string[]} argv */
function parseModeFromArgv(argv) {
  const wi = argv.indexOf("--worker");
  // hook front: `flush.mjs <mode>`; worker: `flush.mjs --worker <ctx> <session> <mode>`.
  const raw = wi === -1 ? argv[2] : argv[wi + 3];
  return raw || "session-end";
}

// Only run when invoked directly (node flush.mjs ...). Importing the module
// (the unit tests do) must not execute the hook.
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  const mode = parseModeFromArgv(process.argv);
  if (!VALID_MODES.has(mode)) {
    console.error(`flush.mjs: unknown mode '${mode}'`);
    process.exit(1);
  }

  const workerIdx = process.argv.indexOf("--worker");
  try {
    if (workerIdx !== -1) {
      // The worker is spawned deliberately by the hook front (and carries the
      // re-entry guard env so its own distiller subtree is marked), so it must
      // ALWAYS run. It is never gated on isReentrant.
      const ctxFile = process.argv[workerIdx + 1];
      const sessionId = process.argv[workerIdx + 2] || "manual";
      await runWorker(ctxFile, sessionId, mode);
    } else {
      // Hook front: skip if we are running inside a memory-spawned agent (a
      // distiller or compile), otherwise that agent's own session would
      // re-fire these hooks and recurse.
      if (isReentrant()) process.exit(0);
      runHookFront(mode);
    }
  } catch (err) {
    // Never hard-fail: a flush problem must not break the user's session or
    // make the hook look like a failure. Log loudly and exit 0.
    logBreadcrumb(`top-level ${mode}: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
}

export { buildSourceMaterial } from "./flush-source.mjs";
export { validateAtoms } from "./flush-validate.mjs";
export {
  renderDailyDocument,
  renderNothingMarker,
  renderRawFallback,
  renderErrorMarker,
} from "./flush-render.mjs";
export {
  writeFailedDistillStash,
  listFailedDistillStashes,
  findStashForSession,
} from "./flush-stash.mjs";
export { __loadPromptForTest } from "./flush-distill.mjs";
export {
  redistillFromStash,
  extractSourceFromLeaf,
  redistillFromLeaf,
} from "./flush-redistill.mjs";
export {
  // Exported for unit tests: the reduce-step model-promotion decision. Lets a
  // test assert true/false/tail behaviour directly, since the mock provider
  // carries no model and can't distinguish promotion end-to-end.
  pickReduceOverride,
  // Exported for unit tests: the recursive reduce-merge and its depth cap, so
  // a test can drive the cap directly (calling it via the full distill path
  // hits the shrink-check early-return before depth ever reaches the cap).
  reduceMerge,
  REDUCE_MAX_DEPTH,
  deterministicDedup,
} from "./flush-reduce.mjs";

// Process-level diagnostics for the LONG-LIVED entrypoints: the MCP server, the webapp
// daemon, and the embed worker thread.
//
// Node's default for an escaped async rejection is to terminate. In a stdio MCP server that
// means the user's memory tools disappear mid-session with a bare stack on a stream nobody is
// reading; in the embed worker it kills the thread, which fires the parent's exit handler and
// rejects every in-flight embed, opening the 30s lexical window. Neither failure left any
// durable record, so there was nothing to diagnose afterwards.
//
// So: a rejection is REPORTED and the process keeps serving, because a stray rejection is
// almost never a reason to destroy a working session. An uncaught exception still exits —
// there the stack is already unwound and the state may genuinely be inconsistent.
//
// Deliberately NOT installed in hooks or the one-shot CLI. Eight hook wrappers run under
// `set -euo pipefail` with a bare `node` as the last command, so node's exit code IS the
// hook's, and the contract is that a capture hook always exits 0 and never blocks a session.
// Those entrypoints already own their failure policy — two of the PreToolUse hooks
// deliberately fail in OPPOSITE directions (one closed, one open), which a uniform handler
// would flatten.

import { inspect } from "node:util";
import { normalizeErrorSignature } from "./error-signature.mjs";
// Static, because the uncaughtException path calls process.exit immediately and a dynamic
// import there was abandoned before it could write. The cost is ~3.5ms of module load on a
// worker spawn, well under 1% of the ONNX load that follows. It does mean monitoring.mjs's own
// dynamic edges (notably cron-job.mjs) MUST stay dynamic: making one static would take this
// worker's module graph from 3 to 59 modules on every spawn.
import { writeMonitoringCapture } from "./monitoring.mjs";

// EX_SOFTWARE. Verified free: 1/2/3/64/65/66/69 all carry established meanings here, and 1
// is both the most overloaded product code and what an unhandled rejection produced before
// this, so it cannot distinguish a clean refusal from an engine crash.
const EX_SOFTWARE = 70;

/** @type {Set<string>} */
const reported = new Set();
let installed = false;

/**
 * @param {unknown} err
 * @returns {string}
 */
function describe(err) {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  // NOT JSON.stringify: it throws on a circular object, a BigInt, or a throwing toJSON — and
  // this runs as the first statement of the handler, so the throw escaped and inverted BOTH
  // policies. A non-serializable rejection killed the process the guard exists to keep alive,
  // and a non-serializable exception became Node-fatal at exit 7, which SKIPS the
  // `process.once("exit")` hooks that flush a wiki batch and release a lock — the one outcome
  // those hooks exist to prevent, and worse than the pre-change default.
  try {
    return inspect(err, { depth: 2 });
  } catch {
    return String(err);
  }
}

// One capture per distinct signature per process: a rejection that repeats every tick would
// otherwise fill the monitoring store with the same observation. The signature is the bug's
// identity, so a genuinely different failure still gets its own record.
/**
 * @param {string} label @param {"unhandledRejection" | "uncaughtException"} kind
 * @param {unknown} err
 * @returns {void}
 */
function record(label, kind, err) {
  const detail = describe(err);
  // stderr ONLY — stdout is JSON-RPC on the server and a typed envelope in every hook.
  process.stderr.write(`${label}: ${kind} — ${detail}\n`);
  let signature = "";
  try {
    signature = normalizeErrorSignature(err, { kind });
  } catch {
    signature = "unknown-error";
  }
  if (reported.has(signature)) return;
  reported.add(signature);
  try {
    // SYNCHRONOUS, and statically imported: the exception path calls process.exit immediately
    // after this, which abandoned a pending dynamic import — so the one path the module header
    // says left "nothing to diagnose" still wrote no capture at all.
    writeMonitoringCapture({
      // The stored capture's identity is derived from its TITLE, so a constant title made two
      // genuinely different bugs indistinguishable in `monitoring-health` without opening the
      // files. The first line of the failure is what tells them apart.
      title: `${label}: ${kind} — ${detail.split("\n")[0].slice(0, 120)}`,
      severity: "confirmed-bug",
      surface: label,
      observed: `An ${kind} escaped in ${label}. ${kind === "uncaughtException" ? "The process exited." : "The process kept serving."}`,
      evidence: detail,
    });
  } catch {
    // A capture is best-effort: the stderr line above is the guaranteed channel.
  }
}

/**
 * Installs the process-level handlers. Idempotent — a second call is a no-op, so a module
 * imported by two entrypoints in one process cannot double-report.
 * @param {string} label identifies the process in the diagnostic (e.g. "mcp-server")
 * @param {{ catchExceptions?: boolean }} [opts] set false in a WORKER THREAD: handling an
 *   exception there consumes it, so the parent's `worker.on("error")` never fires and the real
 *   cause is replaced by a synthetic "worker exited (code N)". Letting it propagate kills the
 *   thread either way, but the parent then gets the diagnosis.
 * @returns {void}
 */
export function installFatalGuard(label, { catchExceptions = true } = {}) {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (err) => {
    record(label, "unhandledRejection", err);
  });
  if (!catchExceptions) return;
  process.on("uncaughtException", (err) => {
    record(label, "uncaughtException", err);
    // Node's default termination already ran the `process.once("exit")` hooks that
    // wiki-commit.mjs and lock.mjs install, so exiting here is not a new commit path — only
    // the code changes (1 -> 70). The genuine deltas are on the REJECTION path above, where
    // the process now SURVIVES, and both are accepted trades for not destroying a live
    // session: an open wiki commit batch never flushes (the leaf file is already written —
    // only its git staging waits for a later batch), and an abandoned lock stays held until
    // `staleMs` elapses instead of being reclaimed the moment the process died, so a warm or
    // compile can be skipped for up to that long. Both self-heal; neither loses a leaf.
    process.exit(EX_SOFTWARE);
  });
}

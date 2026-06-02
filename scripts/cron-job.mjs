// Cron-driven daily compile + consolidate runner.
//
// The cron entry (installed by bootstrap.sh --schedule daily) invokes this
// HOURLY, but the actual work is bounded by:
//   - compile.mjs's own per-UTC-day state file
//     (state/.compile-state.json — already in place)
//   - consolidate.mjs's `--if-due` throttle keyed off
//     MEMORY_CONSOLIDATE_INTERVAL_DAYS (default 1, so once per day)
// So an hourly cron + per-step throttling means: the system attempts up to
// 24× per day, but does the heavy lifting at most once. Each attempt
// appends an entry to state/.consolidate-attempts.log; cron-health reads
// the log to surface unresolved errors to the user at session start.
//
// Self-healing principle: a failed attempt does NOT silently disappear.
// The log retains the latest error; the next hourly attempt retries from
// scratch. SessionStart surfaces the unresolved error if no subsequent
// success cleared it. The system either heals itself by the next cron
// tick, or the user sees the failure and can investigate.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MEMORY_DATA_DIR, MEMORY_DIR } from "./lib/env.mjs";

export const ATTEMPTS_LOG_PATH = path.join(
  MEMORY_DATA_DIR,
  "state",
  ".consolidate-attempts.log",
);

// Keep at most N recent log entries to bound disk usage. 200 attempts ≈ 8
// days of hourly cron; plenty to see a few cycles back without growing
// unbounded.
const MAX_LOG_LINES = 200;

// Cap any stderr capture per attempt so a runaway crash doesn't pollute
// the log with megabytes of output.
const STDERR_CAP_BYTES = 2000;

// ─── log read / write ─────────────────────────────────────────────────────

function appendAttempt(entry) {
  try {
    fs.mkdirSync(path.dirname(ATTEMPTS_LOG_PATH), { recursive: true });
    fs.appendFileSync(ATTEMPTS_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Logging itself must not fail the cron job; emit to stderr and move on.
    process.stderr.write(
      `[cron-job] failed to append attempt log: ${err?.message || err}\n`,
    );
    return;
  }
  // Truncate from the front if file exceeds MAX_LOG_LINES (best-effort).
  try {
    const lines = fs
      .readFileSync(ATTEMPTS_LOG_PATH, "utf8")
      .split("\n")
      .filter(Boolean);
    if (lines.length > MAX_LOG_LINES) {
      const keep = lines.slice(-MAX_LOG_LINES);
      fs.writeFileSync(ATTEMPTS_LOG_PATH, keep.join("\n") + "\n");
    }
  } catch {
    /* best-effort */
  }
}

export function readAttempts({ limit = 50 } = {}) {
  let raw = "";
  try {
    raw = fs.readFileSync(ATTEMPTS_LOG_PATH, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return out.slice(-limit);
}

// ─── runner ───────────────────────────────────────────────────────────────

function runStep(cli, args) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    stdio: "pipe",
    encoding: "utf8",
    env: process.env,
  });
  return {
    ok: r.status === 0,
    exit: typeof r.status === "number" ? r.status : -1,
    stderr: String(r.stderr || "").slice(0, STDERR_CAP_BYTES),
    stdout: String(r.stdout || ""),
  };
}

// Run compile + consolidate sequentially. Returns the log entry that was
// appended. Caller decides exit code (process.exit(entry.ok ? 0 : 1) is the
// usual choice). Throws nothing — every failure is captured into the entry.
export async function runCronJob() {
  const start = Date.now();
  const ts = new Date(start).toISOString();
  const cli = path.join(MEMORY_DIR, "scripts", "cli.mjs");

  const entry = {
    ts,
    kind: "cron-job",
    ok: false,
    durationMs: 0,
    compile: null,
    consolidate: null,
    error: null,
  };

  // 1. compile. Compile has its own per-UTC-day state file so successive
  //    hourly attempts on the same day are cheap no-ops internally.
  try {
    const r = runStep(cli, ["compile"]);
    entry.compile = { ok: r.ok, exit: r.exit, stderr: r.stderr };
    if (!r.ok) {
      entry.error = `compile exit ${r.exit}: ${r.stderr.slice(0, 500)}`;
      entry.durationMs = Date.now() - start;
      appendAttempt(entry);
      return entry;
    }
  } catch (err) {
    entry.error = `compile dispatch threw: ${err?.message || err}`;
    entry.durationMs = Date.now() - start;
    appendAttempt(entry);
    return entry;
  }

  // 2. consolidate --if-due --json. The orchestrator self-throttles by
  //    MEMORY_CONSOLIDATE_INTERVAL_DAYS (default 1 day), so successive
  //    hourly attempts within the cadence return { skipped: "not-due" }
  //    quickly.
  try {
    const r = runStep(cli, ["consolidate", "--if-due", "--json"]);
    entry.consolidate = { ok: r.ok, exit: r.exit, stderr: r.stderr };
    if (r.ok) {
      try {
        const body = JSON.parse(r.stdout);
        // Keep a tiny summary, not the full report.
        entry.consolidate.summary = {
          ok: body.ok,
          skipped: body.skipped || null,
          dryRun: body.dryRun || false,
          totals: body.totals || null,
          workingSetSize: body.workingSetSize ?? null,
        };
      } catch {
        /* unparseable stdout — still consider step OK if exit was 0 */
      }
    } else {
      entry.error = `consolidate exit ${r.exit}: ${r.stderr.slice(0, 500)}`;
      entry.durationMs = Date.now() - start;
      appendAttempt(entry);
      return entry;
    }
  } catch (err) {
    entry.error = `consolidate dispatch threw: ${err?.message || err}`;
    entry.durationMs = Date.now() - start;
    appendAttempt(entry);
    return entry;
  }

  entry.ok = true;
  entry.durationMs = Date.now() - start;
  appendAttempt(entry);
  return entry;
}

// ─── health ───────────────────────────────────────────────────────────────

// Inspect the attempt log to decide whether the cron pipeline is healthy.
// "Unhealthy" = the most-recent attempt errored AND no later attempt
// succeeded. This is exactly the case the SessionStart hook surfaces to
// the user (and hook-less agents check by calling `cron-health` themselves).
//
// Returns:
//   { ok: true, healthy: true,  lastAttempt, lastSuccessAt, recent? }
//   { ok: true, healthy: false, lastAttempt, message }
//   { ok: true, healthy: true,  lastAttempt: null, message }   // never run
export function cronHealth({ limit = 20 } = {}) {
  const all = readAttempts({ limit: MAX_LOG_LINES });
  if (all.length === 0) {
    return {
      ok: true,
      healthy: true,
      lastAttempt: null,
      message: "no cron-job attempts logged yet (system fresh or cron not yet scheduled)",
    };
  }
  const lastAttempt = all[all.length - 1];
  if (lastAttempt.ok === false) {
    return {
      ok: true,
      healthy: false,
      lastAttempt,
      message:
        `The last cron-job attempt at ${lastAttempt.ts} FAILED: ${lastAttempt.error || "<no detail>"}. ` +
        "The system has not self-healed yet — the next hourly cron tick will retry. " +
        "Would you like to investigate (read the attempt log, run cron-job manually, check the wiki state)?",
    };
  }
  // Find the most recent failure WITHIN the visible window (if any), to
  // give context about recent flakiness even when currently healthy.
  let lastFailureAt = null;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].ok === false) {
      lastFailureAt = all[i].ts;
      break;
    }
  }
  return {
    ok: true,
    healthy: true,
    lastAttempt,
    lastSuccessAt: lastAttempt.ts,
    ...(lastFailureAt ? { lastFailureAt } : {}),
    recent: all.slice(-limit),
  };
}

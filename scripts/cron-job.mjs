// Cron-driven daily compile + consolidate runner.
//
// The cron entry (installed by bootstrap.sh --schedule daily) invokes this
// HOURLY, but the actual work is bounded by:
//   - compile.mjs's own per-UTC-day state file
//     (state/.compile-state.json — already in place)
//   - consolidate.mjs's `--if-due` throttle keyed off
//     `consolidate.intervalDays` in settings.yaml (default 1, once per day)
// So an hourly cron + per-step throttling means: the system attempts up to
// 24× per day, but does the heavy lifting at most once.
//
// Logging is two-tier:
//   - state/.consolidate-attempts.log keeps the last `consolidate.attemptsKeep`
//     SLIM entries (one JSON line per run: ok/exit/totals + a logPath pointer;
//     no embedded stderr).
//   - state/logs/<yyyy>/<mm>/cron-<epochMs>.json holds the FULL record of every
//     run (redacted stdout/stderr + the complete consolidate report including
//     per-entity entities[]/failures[]), pruned after
//     `consolidate.fullLogRetentionDays`.
//
// Self-healing is judged per ENTITY, not per run: state/.consolidate-entities.json
// tracks consecutive per-entity failures across runs. An entity still failing
// after `consolidate.escalateAfterAttempts` consecutive attempts — or one error
// signature recurring across BUG_FANOUT distinct entities — escalates into a
// skeleton issue report at issues/<yyyy>/<mm>/<dd>/<signature>.<version>.md
// (whole document redacted; episodes version on recurrence after resolution).
// A transient failure that later succeeds resolves silently: its report flips
// to status: resolved and the entity history is dropped.

import path from "node:path";
import { spawnSync } from "node:child_process";
import { MEMORY_DIR } from "./lib/env.mjs";
import { redact } from "./lib/redact.mjs";
import { maybeGcWikiRepo } from "./lib/wiki-commit.mjs";
import { consolidateEnabled } from "./lib/settings.mjs";
import { collapse, relToDataDir, escalateAfterSafe } from "./cron-shared.mjs";
import { appendAttempt, writeFullLog, fullLogPathFor, pruneFullLogs } from "./cron-attempts.mjs";
import {
  EX_UNAVAILABLE,
  synthesizeProviderEntities,
  readEntityState,
  updateEntityState,
  evaluateEscalations,
  writeEntityState,
} from "./cron-entity-state.mjs";
import { writeIssueReports } from "./cron-issues-index.mjs";

export {
  ATTEMPTS_LOG_PATH,
  readAttempts,
  fullLogPathFor,
  pruneFullLogs,
} from "./cron-attempts.mjs";
export {
  readEntityState,
  writeEntityState,
  updateEntityState,
  evaluateEscalations,
  synthesizeProviderEntities,
} from "./cron-entity-state.mjs";
export { readIssuesIndex, writeIssueReports } from "./cron-issues-index.mjs";
export { cronHealth } from "./cron-health.mjs";

/** @typedef {import("./cron-attempts.mjs").SlimAttemptEntry} SlimAttemptEntry */
/** @typedef {import("./cron-attempts.mjs").FullRunEntry} FullRunEntry */
/** @typedef {import("./cron-entity-state.mjs").ConsolidateReport} ConsolidateReport */

/**
 * @typedef {Object} StepResult
 * @property {boolean} ok
 * @property {number} exit
 * @property {string} stderr
 * @property {string} stdout
 */

// Full compile stdout is preserved in the full log, but bounded.
const STDOUT_CAP_BYTES = 64 * 1024;

// ─── runner ───────────────────────────────────────────────────────────────

/**
 * @param {string} cli
 * @param {string[]} args
 * @returns {StepResult}
 */
function runStep(cli, args) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    stdio: "pipe",
    encoding: "utf8",
    env: process.env,
  });
  return {
    ok: r.status === 0,
    exit: typeof r.status === "number" ? r.status : -1,
    stderr: String(r.stderr || ""),
    stdout: String(r.stdout || ""),
  };
}

// Run compile + consolidate sequentially. Returns the SLIM log entry that was
// appended; the full record (redacted stdout/stderr + complete consolidate
// report) lands in the sharded full log either way. Throws nothing.
/** @returns {Promise<SlimAttemptEntry>} */
export async function runCronJob() {
  const start = new Date();
  const ts = start.toISOString();
  // Master switch (settings.consolidate.enabled, default false). When off the
  // hourly maintenance cron (compile + consolidate) is a no-op — no steps run,
  // no logs written, no self-healing state mutates. Opt in via settings.
  if (!consolidateEnabled()) {
    return {
      ts,
      kind: "cron-job",
      ok: true,
      skipped: "disabled",
      durationMs: 0,
      compile: null,
      consolidate: null,
      error: null,
      logPath: null,
      escalations: 0,
    };
  }
  const cli = path.join(MEMORY_DIR, "scripts", "cli.mjs");
  const fullLogAbs = fullLogPathFor(start);
  const logPathRel = relToDataDir(fullLogAbs);

  /** @type {SlimAttemptEntry} */
  const entry = {
    ts,
    kind: "cron-job",
    ok: false,
    durationMs: 0,
    compile: null,
    consolidate: null,
    error: null,
    logPath: logPathRel,
    escalations: 0,
  };
  /** @type {FullRunEntry} */
  const full = {
    ts,
    kind: "cron-job",
    ok: false,
    durationMs: 0,
    compile: null,
    consolidate: null,
    escalations: [],
    error: null,
  };

  let compileProvidersUnavailable = false;
  let compileErrorFull = "";
  /** @type {ConsolidateReport | null} */
  let report = null;

  // Entity-level self-healing, recorded on EVERY finished tick (also the
  // early-return paths: a consolidate hard-failure on a provider-unavailable
  // tick must not lose the compile failure streak). Consolidate's per-entity
  // results only count on a REAL run (a not-due or dry run must not mutate
  // their streaks), but the synthetic provider entities are judged whenever
  // compile produced a result — compile runs hourly, so its availability
  // signal (failure streaks AND the success that resolves an episode) must
  // not wait for consolidate's daily cadence.
  const recordSelfHealing = () => {
    try {
      const realConsolidate = Boolean(report && !report.skipped && !report.dryRun);
      const synthetic = synthesizeProviderEntities({
        compileExit: entry.compile?.exit,
        compileOk: entry.compile?.ok,
        compileError: compileErrorFull,
        report,
      });
      const passes = { ...(realConsolidate ? report?.passes || {} : {}), ...synthetic };
      if (Object.keys(passes).length === 0) return;
      const escalateAfter = escalateAfterSafe();
      const state = readEntityState();
      updateEntityState(state, { passes }, { ts, logPath: logPathRel, escalateAfter });
      let escalations = evaluateEscalations(state, { escalateAfter });
      if (!realConsolidate) {
        // Off-cycle tick: only the synthetic entities were attempted. Limit
        // occurrence appends to THEIR signatures so a pending consolidate
        // episode doesn't accrue an hourly "still pending" occurrence for
        // runs that never attempted it (24x noise would churn the capped
        // occurrence window). Resolution below still sees the full state.
        const syntheticPasses = new Set(Object.keys(synthetic));
        const touchedSigs = new Set(
          Object.values(state.entities || {})
            .filter((e) => syntheticPasses.has(/** @type {string} */ (e.pass)))
            .map((e) => e.lastSignature)
            .filter(Boolean),
        );
        escalations = escalations.filter((e) => touchedSigs.has(e.signature));
      }
      const issues = writeIssueReports(escalations, state, start);
      writeEntityState(state);
      entry.escalations = issues.openCount;
      full.escalations = escalations;
    } catch (err) {
      // Healing bookkeeping must never fail the cron run itself.
      process.stderr.write(
        `[cron-job] self-healing bookkeeping failed: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  };

  const finish = () => {
    recordSelfHealing();
    entry.durationMs = Date.now() - start.getTime();
    full.ok = entry.ok;
    full.error = entry.error;
    full.durationMs = entry.durationMs;
    writeFullLog(fullLogAbs, full);
    appendAttempt(entry);
    pruneFullLogs(start);
    // Compact the wiki repo's object store (auto-commit churn); git's own
    // --auto threshold makes this a cheap no-op on most ticks.
    maybeGcWikiRepo();
    return entry;
  };

  // 1. compile. Per-UTC-day state makes repeat attempts cheap no-ops.
  // Exit 69 (EX_UNAVAILABLE) = daily docs pending but no provider reachable:
  // the tick is a FAILED attempt (entry.ok stays false, cron-health flips
  // unhealthy until the next good tick), but consolidate still runs — its
  // deterministic passes don't need a provider.
  try {
    const r = runStep(cli, ["compile"]);
    entry.compile = { ok: r.ok, exit: r.exit };
    full.compile = {
      ok: r.ok,
      exit: r.exit,
      stderr: redact(r.stderr),
      stdout: redact(r.stdout).slice(0, STDOUT_CAP_BYTES),
    };
    if (!r.ok) {
      compileProvidersUnavailable = r.exit === EX_UNAVAILABLE;
      // Uncapped (collapsed + redacted) for the synthetic-entity excerpt:
      // the 200-char slim-log cap can cut off the "last: ..." tail that
      // differentiates abort signatures.
      compileErrorFull = collapse(redact(r.stderr));
      entry.error = compileErrorFull.slice(0, 200) || `compile exit ${r.exit}`;
      if (!compileProvidersUnavailable) return finish();
    }
  } catch (err) {
    entry.error = `compile dispatch threw: ${collapse(redact(err instanceof Error ? err.message : String(err))).slice(0, 200)}`;
    return finish();
  }

  // 2. consolidate --if-due --json (self-throttled by consolidate.intervalDays).
  try {
    const r = runStep(cli, ["consolidate", "--if-due", "--json"]);
    entry.consolidate = { ok: r.ok, exit: r.exit };
    full.consolidate = { ok: r.ok, exit: r.exit, stderr: redact(r.stderr), report: null };
    if (!r.ok) {
      entry.error = collapse(redact(r.stderr)).slice(0, 200) || `consolidate exit ${r.exit}`;
      return finish();
    }
    try {
      report = JSON.parse(r.stdout);
    } catch {
      /* unparseable stdout — step still OK if exit was 0 */
    }
    if (report) {
      full.consolidate.report = report;
      entry.consolidate.totals = report.totals || null;
      entry.consolidate.workingSetSize = report.workingSetSize ?? null;
      entry.consolidate.skipped = report.skipped || null;
      entry.consolidate.dryRun = Boolean(report.dryRun);
      entry.consolidate.llm = report.llm ?? null;
      entry.consolidate.llmRequested = report.llmRequested ?? null;
    }
  } catch (err) {
    entry.error = `consolidate dispatch threw: ${collapse(redact(err instanceof Error ? err.message : String(err))).slice(0, 200)}`;
    return finish();
  }

  // 3. Self-healing bookkeeping runs inside finish() so it covers the
  //    early-return paths too.
  entry.ok = !compileProvidersUnavailable;
  return finish();
}

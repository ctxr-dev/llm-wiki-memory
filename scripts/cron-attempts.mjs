import fs from "node:fs";
import path from "node:path";
import { MEMORY_DATA_DIR, CRON_LOGS_DIR } from "./lib/env.mjs";
import { writeFileAtomic } from "./lib/atomic-write.mjs";
import { dailyDatePath } from "./lib/slug.mjs";
import { attemptsKeepSafe, retentionDaysSafe, relToDataDir } from "./cron-shared.mjs";

/** @typedef {import("./cron-entity-state.mjs").Escalation} Escalation */
/** @typedef {import("./cron-entity-state.mjs").ConsolidateReport} ConsolidateReport */

/**
 * One compile/consolidate step result recorded in the slim attempt log.
 * @typedef {Object} StepEntry
 * @property {boolean} ok
 * @property {number} exit
 */

/**
 * The consolidate step's slim entry (base step + report-derived fields).
 * @typedef {Object} ConsolidateEntry
 * @property {boolean} ok
 * @property {number} exit
 * @property {Record<string, unknown> | null} [totals]
 * @property {number | null} [workingSetSize]
 * @property {string | boolean | null} [skipped]
 * @property {boolean} [dryRun]
 * @property {boolean | null} [llm]
 * @property {boolean | null} [llmRequested]
 */

/**
 * One SLIM attempt-log entry (one JSON line per cron run).
 * @typedef {Object} SlimAttemptEntry
 * @property {string} ts
 * @property {string} kind
 * @property {boolean} ok
 * @property {string} [skipped]
 * @property {number} durationMs
 * @property {StepEntry | null} compile
 * @property {ConsolidateEntry | null} consolidate
 * @property {string | null} error
 * @property {string | null} logPath
 * @property {number} escalations
 */

/**
 * The compile step's full-log record (redacted stdout/stderr).
 * @typedef {Object} FullStepCompile
 * @property {boolean} ok
 * @property {number} exit
 * @property {string} stderr
 * @property {string} stdout
 */

/**
 * The consolidate step's full-log record (redacted stderr + full report).
 * @typedef {Object} FullStepConsolidate
 * @property {boolean} ok
 * @property {number} exit
 * @property {string} stderr
 * @property {ConsolidateReport | null} report
 */

/**
 * The FULL cron-run record written to the sharded full log.
 * @typedef {Object} FullRunEntry
 * @property {string} ts
 * @property {string} kind
 * @property {boolean} ok
 * @property {number} durationMs
 * @property {FullStepCompile | null} compile
 * @property {FullStepConsolidate | null} consolidate
 * @property {Escalation[]} escalations
 * @property {string | null} error
 */

export const ATTEMPTS_LOG_PATH = path.join(MEMORY_DATA_DIR, "state", ".consolidate-attempts.log");

const CRON_LOG_RE = /^cron-(\d+)\.json$/;

// ─── slim attempt log ──────────────────────────────────────────────────────

/** @param {SlimAttemptEntry} entry */
export function appendAttempt(entry) {
  try {
    fs.mkdirSync(path.dirname(ATTEMPTS_LOG_PATH), { recursive: true });
    fs.appendFileSync(ATTEMPTS_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Logging itself must not fail the cron job; emit to stderr and move on.
    process.stderr.write(
      `[cron-job] failed to append attempt log: ${err instanceof Error ? err.message : err}\n`,
    );
    return;
  }
  // Front-truncate to the configured number of runs (best-effort).
  try {
    const keepN = attemptsKeepSafe();
    const lines = fs.readFileSync(ATTEMPTS_LOG_PATH, "utf8").split("\n").filter(Boolean);
    if (lines.length > keepN) {
      const keep = lines.slice(-keepN);
      writeFileAtomic(ATTEMPTS_LOG_PATH, keep.join("\n") + "\n");
    }
  } catch {
    /* best-effort */
  }
}

// Tolerant of both the slim format and pre-redesign "fat" entries (which
// embedded stderr + a consolidate.summary object): only ok/ts/error are read
// by health logic, and those exist in every format.
/**
 * @param {{ limit?: number }} [opts]
 * @returns {SlimAttemptEntry[]}
 */
export function readAttempts({ limit = 50 } = {}) {
  let raw = "";
  try {
    raw = fs.readFileSync(ATTEMPTS_LOG_PATH, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean);
  /** @type {SlimAttemptEntry[]} */
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

// ─── sharded full run logs ─────────────────────────────────────────────────

export function fullLogPathFor(date = new Date()) {
  const shard = dailyDatePath(date).split("/").slice(0, 2).join(path.sep); // yyyy/mm
  return path.join(CRON_LOGS_DIR, shard, `cron-${date.getTime()}.json`);
}

/**
 * @param {string} absPath
 * @param {FullRunEntry} fullEntry
 * @returns {string | null}
 */
export function writeFullLog(absPath, fullEntry) {
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileAtomic(absPath, JSON.stringify(fullEntry, null, 2) + "\n");
    return relToDataDir(absPath);
  } catch (err) {
    process.stderr.write(
      `[cron-job] failed to write full run log: ${err instanceof Error ? err.message : err}\n`,
    );
    return null;
  }
}

// Delete full logs older than the retention window. Age is parsed from the
// FILENAME epoch (never mtime — clock skew / touch must not resurrect or
// expire a log). Best-effort throughout: pruning can never fail the run.
export function pruneFullLogs(now = new Date(), retentionDays = retentionDaysSafe()) {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let removed = 0;
  let years;
  try {
    years = fs.readdirSync(CRON_LOGS_DIR);
  } catch {
    return { removed };
  }
  for (const yyyy of years) {
    const yearDir = path.join(CRON_LOGS_DIR, yyyy);
    let months;
    try {
      months = fs.readdirSync(yearDir);
    } catch {
      continue;
    }
    for (const mm of months) {
      const monthDir = path.join(yearDir, mm);
      let files;
      try {
        files = fs.readdirSync(monthDir);
      } catch {
        continue;
      }
      for (const f of files) {
        const m = CRON_LOG_RE.exec(f);
        if (!m) continue;
        if (Number(m[1]) >= cutoff) continue;
        try {
          fs.rmSync(path.join(monthDir, f), { force: true });
          removed++;
        } catch {
          /* race / permissions — skip */
        }
      }
      try {
        if (fs.readdirSync(monthDir).length === 0) fs.rmdirSync(monthDir);
      } catch {
        /* best effort */
      }
    }
    try {
      if (fs.readdirSync(yearDir).length === 0) fs.rmdirSync(yearDir);
    } catch {
      /* best effort */
    }
  }
  return { removed };
}

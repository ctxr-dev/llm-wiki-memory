import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  MEMORY_DIR,
  MEMORY_DATA_DIR,
  COMPILE_STATE_PATH,
  envValue,
  wikiRoot,
} from "../lib/env.mjs";
import { buildSessionStartContext } from "../lib/discipline.mjs";
import { isReentrant, reentryEnv } from "../lib/reentry.mjs";
import { buildWorkContextSection, buildRecentActivitySection } from "../lib/work-context.mjs";
import { withBrainContextSafe } from "../lib/wiki-context.mjs";
import { migrate as migrateSettings } from "../migrate-settings.mjs";

// Self-heal a "live upgrade": an operator who git-pulls a new src/ and just
// restarts their client (never re-running bootstrap.sh) would otherwise run on
// an un-migrated install — old .env with now-ignored MEMORY_* vars and NO
// settings.yaml, so the loader silently serves template defaults and the
// operator's tuning (and a disabled write-gate!) is lost. The migrator is
// idempotent and read-only on an already-migrated / fresh install (it early-
// outs without writing), so calling it here is cheap and safe. Best-effort:
// a failure must never block session start. Skipped inside memory-spawned
// subprocesses (the re-entry guard).
function maybeMigrateSettings() {
  if (isReentrant()) return;
  try {
    // Buffer the migrator's log lines; only surface them if a migration
    // actually ran. The common already-migrated / fresh-install paths must
    // stay silent so they don't print on every single session start.
    /** @type {string[]} */
    const buffered = [];
    const result = migrateSettings(MEMORY_DATA_DIR, { log: (m) => buffered.push(m) });
    if (result && result.migrated) {
      for (const line of buffered) process.stderr.write(line + "\n");
    }
  } catch (err) {
    console.error(
      `session-start.mjs: settings self-heal skipped: ${err instanceof Error ? err.message : err}`,
    );
  }
}

const RECURSION_GUARD = "memory_compile";

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function readState() {
  if (!fs.existsSync(COMPILE_STATE_PATH)) return { last_attempted_date: "" };
  try {
    return JSON.parse(fs.readFileSync(COMPILE_STATE_PATH, "utf8"));
  } catch {
    return { last_attempted_date: "" };
  }
}

function spawnCompileDetached() {
  const compileScript = path.join(MEMORY_DIR, "scripts", "compile.mjs");
  if (!fs.existsSync(compileScript)) return false;

  const env = reentryEnv(RECURSION_GUARD);
  const child = spawn("node", [compileScript], {
    detached: true,
    stdio: "ignore",
    env,
    cwd: MEMORY_DIR,
  });
  child.unref();
  return true;
}

function maybeTriggerCompile() {
  if (isReentrant()) return false;
  const state = readState();
  if (state.last_attempted_date === todayUtcDate()) return false;
  return spawnCompileDetached();
}

const memoryServerName = envValue("MEMORY_MCP_SERVER_NAME") || "llm-wiki-memory";

// Self-heal a live (no-bootstrap) upgrade BEFORE anything reads settings().
maybeMigrateSettings();

const compileTriggered = (() => {
  try {
    return maybeTriggerCompile();
  } catch (err) {
    console.error(
      `session-start.mjs: compile trigger skipped: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
})();

const disciplineContext = buildSessionStartContext({
  serverName: memoryServerName,
  compileTriggered,
});

// Append the work-context section (active branch → semantic wiki search →
// top hits + plan progress). Best-effort — any failure produces an empty
// string and we ship the discipline context alone.
let workContext = "";
try {
  // The hook's own wiki reads run brain-scoped (brain-only context). Resolving
  // wikiRoot() INSIDE the frame so the search targets the brain wiki.
  // Behavior-neutral in the single-tree case; a resolve failure falls through.
  workContext = await withBrainContextSafe(async () => {
    const { searchMemory } = await import("../lib/recall.mjs");
    return buildWorkContextSection({
      cwd: process.cwd(),
      searchMemory,
      wikiRoot: wikiRoot(),
    });
  });
} catch (err) {
  console.error(
    `session-start.mjs: work-context skipped: ${err instanceof Error ? err.message : err}`,
  );
}

// Append the "🧠 Recently" reminder (last N days of daily notes as brief + link).
// Gated by recall.recentActivityDays (default 3, 0 disables); best-effort so any
// failure produces an empty string and the pipeline ships without it.
let recentActivitySection = "";
try {
  recentActivitySection = withBrainContextSafe(() =>
    buildRecentActivitySection({ wikiRoot: wikiRoot() }),
  );
} catch (err) {
  console.error(
    `session-start.mjs: recent-activity skipped: ${err instanceof Error ? err.message : err}`,
  );
}

// Self-healing surface — DETERMINISTIC, MINIMAL.
//
// When the most recent cron attempt failed AND the next tick hasn't
// cleared it, emit ONE short line into additionalContext: the cron-health
// summary (under ~200 chars). NO JSON dump, NO stderr capture, NO full
// log — those would pollute the agent's context with multi-KB payloads
// every session. The agent reads the summary, asks the user whether to
// investigate, and only THEN pulls the full log via the CLI on demand.
//
// When healthy, this section is the empty string (omitted entirely).
let cronHealthSection = "";
try {
  const { cronHealth } = await import("../cron-job.mjs");
  // Pass limit:0 so the `recent` array is NOT populated either — the only
  // field consulted from the result is `summary`.
  const h = cronHealth({ limit: 0 });
  if (!h.healthy) {
    const open = Array.isArray(h.escalations) ? h.escalations.length : 0;
    // Entity-level escalations point at a skeleton issue report the agent may
    // deepen ONLY on explicit user yes; run-level failures keep the original
    // wording. Either way: one short summary line, never the logs themselves.
    const detail =
      open > 0
        ? `\n\n${open} consolidation escalation(s) are open (the same entities kept failing across cron runs); the newest skeleton report is at the path in the summary above, with links to the full sharded run logs. ` +
          "Tell the user and ASK before investigating — don't open the report or the full logs on your own. "
        : "\n\nThe hourly cron's last attempt errored and the next tick hasn't cleared it yet. " +
          "Tell the user and ASK before investigating — don't pull the full log on your own. ";
    cronHealthSection =
      "\n\n## Memory cron health: UNRESOLVED FAILURE\n\n" +
      h.summary +
      detail +
      "If they want details, run `node .llm-wiki-memory/src/scripts/cli.mjs cron-health` for the full attempt; " +
      "or `node .llm-wiki-memory/src/scripts/cli.mjs cron-job` to retry now.\n";
  }
} catch (err) {
  console.error(
    `session-start.mjs: cron-health skipped: ${err instanceof Error ? err.message : err}`,
  );
}

// Self-observability surface — DETERMINISTIC, MINIMAL (opt-in feature).
// When unreviewed monitoring captures exist (status:open), emit ONE short line so
// the user can decide whether to triage. Empty (omitted) otherwise — which is the
// case on every install that did not opt into self-observability (the monitoring
// dir is absent, so monitoringHealth returns healthy with no scan cost).
let monitoringSection = "";
try {
  const { monitoringHealth } = await import("../lib/monitoring.mjs");
  const m = monitoringHealth({ limit: 0 });
  if (!m.healthy && m.open > 0) {
    monitoringSection =
      "\n\n## Memory self-observability: unreviewed anomalies\n\n" +
      m.summary +
      "\n\nCaptured by an earlier session under `.llm-wiki-memory/monitoring/`. ASK the user " +
      "before triaging; details via `node .llm-wiki-memory/src/scripts/cli.mjs monitoring-health`.\n";
  }
} catch (err) {
  console.error(
    `session-start.mjs: monitoring-health skipped: ${err instanceof Error ? err.message : err}`,
  );
}

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        disciplineContext +
        workContext +
        recentActivitySection +
        cronHealthSection +
        monitoringSection,
    },
  }),
);

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { MEMORY_DIR, COMPILE_STATE_PATH, envValue, wikiRoot } from "../lib/env.mjs";
import { buildSessionStartContext } from "../lib/discipline.mjs";
import { isReentrant, reentryEnv } from "../lib/reentry.mjs";
import { buildWorkContextSection } from "../lib/work-context.mjs";

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

const compileTriggered = (() => {
  try {
    return maybeTriggerCompile();
  } catch (err) {
    console.error(`session-start.mjs: compile trigger skipped: ${err instanceof Error ? err.message : err}`);
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
  const { searchMemory } = await import("../lib/recall.mjs");
  workContext = await buildWorkContextSection({
    cwd: process.cwd(),
    searchMemory,
    wikiRoot: wikiRoot(),
  });
} catch (err) {
  console.error(
    `session-start.mjs: work-context skipped: ${err instanceof Error ? err.message : err}`,
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
    cronHealthSection =
      "\n\n## Memory cron health: UNRESOLVED FAILURE\n\n" +
      h.summary +
      "\n\nThe hourly cron's last attempt errored and the next tick hasn't cleared it yet. " +
      "Tell the user and ASK before investigating — don't pull the full log on your own. " +
      "If they want details, run `node .llm-wiki-memory/src/scripts/cli.mjs cron-health` for the full attempt; " +
      "or `node .llm-wiki-memory/src/scripts/cli.mjs cron-job` to retry now.\n";
  }
} catch (err) {
  console.error(
    `session-start.mjs: cron-health skipped: ${err instanceof Error ? err.message : err}`,
  );
}

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: disciplineContext + workContext + cronHealthSection,
    },
  }),
);

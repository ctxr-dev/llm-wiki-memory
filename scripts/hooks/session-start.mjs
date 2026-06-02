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

// Self-healing surface: if the most recent cron-job attempt failed AND no
// later attempt cleared it, surface the error to the user. They can then
// ask the agent to investigate (read the attempt log, run cron-job
// manually, fix env/config, etc.). When healthy, the section is empty.
let cronHealthSection = "";
try {
  const { cronHealth } = await import("../cron-job.mjs");
  const h = cronHealth({ limit: 5 });
  if (!h.healthy) {
    cronHealthSection =
      "\n\n## Memory cron health (UNRESOLVED FAILURE)\n\n" +
      h.message +
      "\n\nLast attempt details:\n" +
      "```json\n" +
      JSON.stringify(h.lastAttempt, null, 2) +
      "\n```\n\n" +
      "If you want to investigate, ask the agent to: (a) print the full attempt log via `node .llm-wiki-memory/src/scripts/cli.mjs cron-health`, " +
      "(b) re-run the cron-job manually via `node .llm-wiki-memory/src/scripts/cli.mjs cron-job`, " +
      "or (c) inspect the underlying steps (compile + consolidate) directly.\n";
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

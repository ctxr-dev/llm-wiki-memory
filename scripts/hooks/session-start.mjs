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

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: disciplineContext + workContext,
    },
  }),
);

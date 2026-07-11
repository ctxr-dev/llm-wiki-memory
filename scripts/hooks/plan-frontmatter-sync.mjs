// plan-frontmatter-sync — Claude Code hook entry script.
//
// Two invocation modes:
//   PostToolUse Write/Edit on *.plan.md  -> sync the one file from
//       tool_input.file_path. Immediate consistency: frontmatter follows
//       checkbox state, file moves to the right lifecycle folder.
//   SessionEnd                           -> sweep every .plan.md under
//       the wiki (safety net for external edits the PostToolUse path
//       didn't see).
//
// Stdin is the Claude Code hook envelope. The hook is best-effort:
// any error is logged to .work/plan-sync.log and the script exits 0 so
// it never blocks the session.

import fs from "node:fs";
import path from "node:path";
import { wikiRoot } from "../lib/env.mjs";
import { syncPlanFile, syncAllPlans } from "../lib/plan-sync.mjs";

/** @typedef {import("../lib/plan-sync.mjs").PlanSyncResult} PlanSyncResult */

/**
 * @typedef {Object} PlanSyncHookInput
 * @property {{ file_path?: string }} [tool_input]
 */

const MODE = process.argv[2] || "post-tool-use"; // "post-tool-use" | "session-end"

/** @returns {unknown} */
function readStdin() {
  try {
    const data = fs.readFileSync(0, "utf8");
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

/** @param {string} line */
function logEntry(line) {
  const root = wikiRoot();
  const logDir = path.join(root, ".work");
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "plan-sync.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best-effort
  }
}

/** @param {PlanSyncHookInput} input */
async function runPostToolUse(input) {
  const filePath = input?.tool_input?.file_path;
  if (!filePath || typeof filePath !== "string") {
    logEntry(`post-tool-use: no file_path in tool_input — skipping`);
    return [];
  }
  // Only care about .plan.md files
  if (!filePath.endsWith(".plan.md")) return [];
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  // Only act if the file lives under our wiki
  if (!abs.startsWith(wikiRoot())) return [];
  const r = await syncPlanFile(abs, { wikiRoot: wikiRoot() });
  logEntry(`post-tool-use: ${JSON.stringify(r)}`);
  return [r];
}

async function runSessionEnd() {
  const results = await syncAllPlans(wikiRoot());
  const moved = results.filter((/** @type {PlanSyncResult} */ r) => r.moved).length;
  const changed = results.filter((/** @type {PlanSyncResult} */ r) => r.frontmatter_changed).length;
  logEntry(`session-end: scanned=${results.length} frontmatter_changed=${changed} moved=${moved}`);
  return results;
}

const input = /** @type {PlanSyncHookInput} */ (readStdin());
try {
  if (MODE === "session-end") {
    await runSessionEnd();
  } else {
    await runPostToolUse(input);
  }
} catch (err) {
  logEntry(`fatal: ${err instanceof Error && err.message ? err.message : String(err)}`);
}
// Claude Code expects a JSON envelope on stdout for tool-use hooks; an
// empty object is "do nothing, don't interrupt the model".
process.stdout.write("{}\n");

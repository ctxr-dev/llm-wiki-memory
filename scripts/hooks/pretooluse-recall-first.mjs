// L2 for the RECALL discipline: consult the wiki before scanning the filesystem.
//
// Discipline rule 1 already says to call recall_lessons before any non-trivial task. It did not
// bind: in a long session spent entirely on this project's own memory system, an agent called
// recall_lessons and search_memory ZERO times and answered every "what do we know / why is it this
// way / has this been decided" question by grepping. The instruction was loaded throughout. So this
// is the deterministic layer, and the rule text (templates/rules/recall-first.md) is the L1 one.
//
// WHAT IT DOES NOT DO, because over-firing would be worse than the problem it fixes:
//   - it never blocks reading code. The decision is "ask" (a one-click prompt), never "deny", and
//     the wiki holds lessons/decisions/plans — not source. Grep remains how any change gets made.
//   - it asks at most ONCE per session, at the first search-or-edit, not once per grep. Both the
//     "already recalled" and the "already asked" facts come from the transcript, so no state file.
//   - it FAILS OPEN on any trouble (exit 0, no decision). This is the deliberate opposite of
//     pretooluse-gate-memory-writes.mjs, which fails closed to "ask": that hook guards a write
//     whose loss is unrecoverable, while a missed nudge here costs nothing and a spurious prompt on
//     every grep would cost a great deal.
//
// Hook decision contract:
//   stdout JSON: {"hookSpecificOutput": {
//     "hookEventName": "PreToolUse",
//     "permissionDecision": "ask",
//     "permissionDecisionReason": string }}
//   exit 0 with no output -> Claude Code uses its normal permission flow.

import fs from "node:fs";
import { completedToolNames, readTranscriptRecords } from "./pretooluse-gate-transcript.mjs";

// A memory READ. Writes deliberately do not count: saving a lesson is not consulting one, and
// accepting a write here would let a session that only ever writes skip the discipline entirely.
const MEMORY_READ_TOOLS = [
  "mcp__llm-wiki-memory__recall_lessons",
  "mcp__llm-wiki-memory__search_memory",
];

// The tools whose FIRST use is the moment to ask. Searching the tree and mutating it are both
// "starting real work"; reading one known file is not, so Read is absent on purpose.
const TRIGGER_TOOLS = new Set(["Grep", "Glob", "Write", "Edit", "NotebookEdit"]);

const REASON =
  "Project memory has not been consulted yet this session. Call " +
  "mcp__llm-wiki-memory__recall_lessons (or search_memory) first — the wiki holds prior lessons, " +
  "decisions and in-flight plans that a file search cannot surface. Reading code is unaffected; " +
  "this asks once per session.";

/** @returns {Promise<string>} */
async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// Fail-closed on a failure to LOAD settings means: keep the hook ENABLED, matching
// writeGateClaudeHookEnabled. An unreadable settings file must not silently disable a discipline.
/** @returns {Promise<boolean>} */
async function enabled() {
  try {
    const { recallFirstHookEnabled } = await import("../lib/settings.mjs");
    return recallFirstHookEnabled();
  } catch {
    return true;
  }
}

/** @param {string} reason @returns {void} */
function ask(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // fail open
  }
  if (!TRIGGER_TOOLS.has(payload?.tool_name)) return;
  if (!(await enabled())) return;

  const transcriptPath = payload?.transcript_path;
  /** @type {Set<string>} */
  let done;
  try {
    // An unreadable or empty transcript is not evidence that memory was skipped — it is no
    // evidence at all. Asking on it would nudge on every tool call of a session the hook cannot
    // see, which is precisely the failure that gets a hook switched off.
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return;
    if (readTranscriptRecords(transcriptPath).length === 0) return;
    done = completedToolNames(transcriptPath);
  } catch {
    return; // fail open
  }
  // Already consulted the wiki: silent for the rest of the session.
  if (MEMORY_READ_TOOLS.some((name) => done.has(name))) return;
  // Not the session's first search-or-edit: the prompt has already been shown once, and repeating
  // it on every grep is the failure mode that would get this hook disabled.
  for (const name of done) if (TRIGGER_TOOLS.has(name)) return;

  ask(REASON);
}

main().catch(() => {
  // Fail open: a nudge must never break a tool call.
});

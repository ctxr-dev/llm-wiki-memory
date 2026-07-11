// L2 of the memory-write hardening stack (Claude Code only).
//
// Claude Code fires PreToolUse before any tool call. We intercept calls to
// the self_improvement write tools and force the propose-then-confirm flow:
//
//   - If the latest user turn in the transcript contains an explicit save
//     phrase, return `permissionDecision: "allow"` and let the tool run.
//   - Otherwise return `permissionDecision: "ask"` so Claude Code prompts
//     the user for a one-click yes/no. Nothing auto-commits.
//
// We never inject the `userRequested:true` argument ourselves: the model
// still has to set it on the call. The L3 server-side guard checks the
// argument and the system-maintenance tag, so it refuses the write even if
// the model bypasses this hook (e.g. running under Cursor / Codex). This
// hook is therefore one defence layer; the server is the airtight one.
//
// Hook decision contract:
//   stdout JSON: {"hookSpecificOutput": {
//     "hookEventName": "PreToolUse",
//     "permissionDecision": "allow" | "ask",
//     "permissionDecisionReason": string }}
//   exit 0 (untouched, no JSON) -> Claude Code uses its default permission.
//
// Fail-closed: every parsing / read failure on a gated tool falls back to
// "ask" so the user still controls the outcome.
//
// Operator off-switch: settings.yaml `gate.claudeHookEnabled: false` turns
// this hook into a uniform no-op (exit 0, no decision, normal permission
// flow), as if it were not installed. L1 instructions and the L3 server-side
// gate still apply. A failure to LOAD settings keeps the hook ENABLED.

import { writeGateClaudeHookEnabled, writeGatePerLessonConsent } from "../lib/settings.mjs";
import { recordGatedWrite } from "../lib/save-gate-audit.mjs";
import {
  GATED_TOOLS,
  isGatedSelfImprovementCall,
  analyzeTranscript,
} from "./pretooluse-gate-transcript.mjs";

// GATED_TOOLS / isGatedSelfImprovementCall / analyzeTranscript (the JSONL
// transcript-parsing concern) live in ./pretooluse-gate-transcript.mjs.

function perLessonConsentEnabled() {
  // Fail-closed like hookEnabled(): an unreadable settings file keeps the
  // stricter per-lesson behaviour ON.
  try {
    return writeGatePerLessonConsent();
  } catch {
    return true;
  }
}

// Word-boundary phrase match. We keep this list tight: false positives
// (auto-allow when the user did not actually ask) are worse than false
// negatives (one-click "ask" prompt). The L3 server-side gate still demands
// `userRequested:true` regardless of this decision.
const SAVE_PHRASE_RE = /\b(save|memori[sz]e|remember|store|persist|record)\b/i;

/**
 * @param {string} decision
 * @param {string} reason
 */
function emit(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.stdout.write("\n");
}

function untouched() {
  // Exit 0 with empty stdout: Claude Code falls through to its default
  // permission handling. Use this for tools we don't gate at all.
  process.exit(0);
}

function hookEnabled() {
  // A broken settings load must not disable the gate: default to enabled.
  try {
    return writeGateClaudeHookEnabled();
  } catch {
    return true;
  }
}

// Best-effort L2 audit line: records the hook's own decision and (on allow) the
// redacted user phrase that authorised it. Never throws; the hook must not fail
// because of audit logging.
/**
 * @param {string} name
 * @param {string} decision
 * @param {string} trigger
 */
function auditL2(name, decision, trigger) {
  try {
    recordGatedWrite({
      layer: "L2",
      tool: name.replace(/^mcp__llm-wiki-memory__/, ""),
      status: decision,
      // Pass the FULL phrase; recordGatedWrite redacts THEN caps length, so a
      // secret near the cap can never leave a non-redacted fragment on disk.
      trigger: decision === "allow" ? String(trigger || "") : "",
    });
  } catch {
    /* best-effort */
  }
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  // Operator off-switch: checked after draining stdin and before any parsing
  // so a disabled hook is a uniform no-op even on malformed input.
  if (!hookEnabled()) {
    untouched();
    return;
  }

  let payload;
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    emit("ask", "memory-write-gate: malformed hook input");
    return;
  }

  // Claude Code's hook payload uses `tool_name` + `tool_input`; we also
  // accept the legacy `tool` + `args` shape for older versions.
  const tool = payload?.tool_name || payload?.tool;
  const toolInput = payload?.tool_input || payload?.args || {};

  if (!GATED_TOOLS.has(tool)) {
    untouched();
    return;
  }

  // save_to_dataset / write_memory are only gated when they actually land in
  // self_improvement. Other categories (knowledge, plans, investigations,
  // daily, issues), and non-self_improvement paths, flow through untouched,
  // exactly as the L3 server treats them. save_lesson is always gated.
  if (
    (tool === "mcp__llm-wiki-memory__save_to_dataset" ||
      tool === "mcp__llm-wiki-memory__write_memory") &&
    !isGatedSelfImprovementCall(tool, toolInput)
  ) {
    untouched();
    return;
  }

  const transcriptPath = payload?.transcript_path;
  const { lastUserText, gatedSince } = analyzeTranscript(transcriptPath);
  const hasPhrase = Boolean(lastUserText && SAVE_PHRASE_RE.test(lastUserText));

  let decision;
  let reason;
  if (perLessonConsentEnabled() && gatedSince > 0) {
    // A prior self_improvement write already consumed this turn's approval.
    // Force an explicit per-lesson confirm so a batch flush can't ride one yes.
    decision = "ask";
    reason =
      "memory-write-gate: per-lesson consent: a prior self_improvement write already used this turn's approval; confirm this lesson explicitly";
  } else if (hasPhrase) {
    decision = "allow";
    reason = "memory-write-gate: explicit save phrase detected in latest user turn";
  } else {
    decision = "ask";
    reason =
      "memory-write-gate: self_improvement write without an explicit save phrase in the latest user turn (propose-then-confirm)";
  }

  auditL2(tool, decision, lastUserText);
  emit(decision, reason);
}

main().catch((err) => {
  process.stderr.write(`memory-write-gate hook error: ${err?.message || String(err)}\n`);
  // Fail-closed: surface to the user via "ask" rather than silently allowing.
  emit("ask", "memory-write-gate: internal error; falling back to ask");
});

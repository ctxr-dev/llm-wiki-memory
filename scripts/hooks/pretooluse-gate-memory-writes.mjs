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

import fs from "node:fs";
import { writeGateClaudeHookEnabled, writeGatePerLessonConsent } from "../lib/settings.mjs";
import { recordGatedWrite } from "../lib/save-gate-audit.mjs";
import { placementTargetsCategory } from "../lib/gate-target.mjs";

const GATED_TOOLS = new Set([
  "mcp__llm-wiki-memory__save_lesson",
  "mcp__llm-wiki-memory__save_to_dataset",
  "mcp__llm-wiki-memory__write_memory",
]);

// True iff a gated tool call actually lands in the self_improvement category
// (the only gated one). Uses the SAME shared path predicate as the L3 server's
// targetsGatedCategory so the hook gates AND counts exactly the writes the server
// gates, including the dataset:"knowledge" + path:"self_improvement/..." bypass.
function isGatedSelfImprovementCall(name, input = {}) {
  if (name === "mcp__llm-wiki-memory__save_lesson") return true;
  if (name === "mcp__llm-wiki-memory__save_to_dataset") {
    return input?.dataset === "self_improvement" || placementTargetsCategory(input?.path, "self_improvement");
  }
  if (name === "mcp__llm-wiki-memory__write_memory") {
    return input?.datasetId === "self_improvement" || placementTargetsCategory(input?.path, "self_improvement");
  }
  return false;
}

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

// One pass over the JSONL transcript. Returns BOTH the latest typed-by-the-user
// prose AND the number of gated self_improvement tool calls the assistant has
// already made SINCE that user turn. The count powers per-lesson consent: a save
// phrase authorises only the FIRST gated write of a turn; a 2nd+ write in the
// same turn must be confirmed, so a session-end flush can no longer ride one
// approval. Shapes vary across Claude Code versions, so several common paths are
// tried and the first that parses wins. Any failure yields the empty/zero result
// (the caller then falls back to "ask").
function analyzeTranscript(transcriptPath) {
  const out = { lastUserText: "", gatedSince: 0 };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return out;
  let recs;
  try {
    recs = fs
      .readFileSync(transcriptPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return out;
  }
  // Most recent user PROSE record (skip synthetic tool_result user records,
  // which carry only a content array of tool_result blocks).
  let lastUserIdx = -1;
  for (let i = recs.length - 1; i >= 0; i--) {
    const rec = recs[i];
    const role = rec?.role || rec?.type || rec?.message?.role;
    if (role !== "user") continue;
    const c = rec?.content ?? rec?.message?.content;
    let text = "";
    if (typeof c === "string") text = c.trim();
    else if (Array.isArray(c)) {
      text = c
        .map((p) => (typeof p === "string" ? p : p?.type === "text" && typeof p.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join(" ")
        .trim();
    }
    if (text) {
      out.lastUserText = text;
      lastUserIdx = i;
      break;
    }
  }
  // Count gated self_improvement writes that have already COMPLETED since that
  // user turn: a tool_use with a matching tool_result. The current pending call
  // has no tool_result yet, so it is never counted. Keying on completion (not on
  // mere presence of the tool_use) makes this robust to whether Claude Code has
  // already appended the current call's tool_use block to the transcript at
  // PreToolUse time. gatedSince > 0 means "a prior lesson this turn already used
  // the approval".
  //
  // KNOWN LIMITATION (accepted): if the model emits N gated writes in ONE
  // assistant message (parallel tool use), none have a tool_result yet, so all N
  // ride the single save phrase. Per-lesson consent therefore assumes the common
  // case where MCP writes serialise (each completes before the next fires). It is
  // a UX layer: the airtight L3 server still requires userRequested:true on EVERY
  // call regardless of parallelism, and the audit ledger records each one, so a
  // parallel batch is never silently un-gated, only un-prompted. Counting
  // unresolved tool_use to close this would reintroduce the transcript-timing
  // fragility the completion-keying was chosen to avoid (the current call's own
  // already-appended tool_use would be miscounted), so it is deliberately not done.
  const gatedUseIds = new Set(); // ids of gated self_improvement tool_use blocks
  const resolvedIds = new Set(); // tool_use_ids that have a tool_result
  for (let i = lastUserIdx + 1; i < recs.length; i++) {
    const rec = recs[i];
    const c = rec?.content ?? rec?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const block of c) {
      if (
        block?.type === "tool_use" &&
        block?.id &&
        isGatedSelfImprovementCall(block?.name, block?.input)
      ) {
        gatedUseIds.add(block.id);
      } else if (block?.type === "tool_result" && block?.tool_use_id) {
        resolvedIds.add(block.tool_use_id);
      }
    }
  }
  for (const id of gatedUseIds) {
    if (resolvedIds.has(id)) out.gatedSince += 1;
  }
  return out;
}

// Best-effort L2 audit line: records the hook's own decision and (on allow) the
// redacted user phrase that authorised it. Never throws; the hook must not fail
// because of audit logging.
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
  process.stderr.write(
    `memory-write-gate hook error: ${err?.message || String(err)}\n`,
  );
  // Fail-closed: surface to the user via "ask" rather than silently allowing.
  emit("ask", "memory-write-gate: internal error; falling back to ask");
});

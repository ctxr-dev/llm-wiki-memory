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

import fs from "node:fs";

const GATED_TOOLS = new Set([
  "mcp__llm-wiki-memory__save_lesson",
  "mcp__llm-wiki-memory__save_to_dataset",
  "mcp__llm-wiki-memory__write_memory",
]);

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

function readTranscriptLastUserText(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return "";
  try {
    const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/);
    // Walk backwards to find the most recent user message. Transcript records
    // are JSONL; shapes vary across Claude Code versions, so try a few common
    // paths and accept the first one that parses.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const role = rec?.role || rec?.type || rec?.message?.role;
      if (role !== "user") continue;
      // Skip synthetic tool-result records (which Claude Code stores under
      // role:"user" with a content array of tool_result blocks). We only
      // want actual typed-by-the-user prose.
      const c = rec?.content ?? rec?.message?.content;
      if (typeof c === "string" && c.trim() !== "") return c;
      if (Array.isArray(c)) {
        const text = c
          .map((p) => {
            if (typeof p === "string") return p;
            if (p?.type === "text" && typeof p.text === "string") return p.text;
            return "";
          })
          .filter(Boolean)
          .join(" ")
          .trim();
        if (text) return text;
      }
    }
  } catch {
    /* fall through */
  }
  return "";
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

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

  // save_to_dataset is only gated when the target dataset is self_improvement.
  // Other categories (knowledge, plans, investigations, daily, issues) flow
  // through without any gate.
  if (tool === "mcp__llm-wiki-memory__save_to_dataset") {
    const dataset = toolInput?.dataset;
    if (dataset !== "self_improvement") {
      untouched();
      return;
    }
  }

  const transcriptPath = payload?.transcript_path;
  const lastUserText = readTranscriptLastUserText(transcriptPath);

  if (lastUserText && SAVE_PHRASE_RE.test(lastUserText)) {
    emit(
      "allow",
      "memory-write-gate: explicit save phrase detected in latest user turn",
    );
    return;
  }

  emit(
    "ask",
    "memory-write-gate: self_improvement write without an explicit save phrase in the latest user turn (propose-then-confirm)",
  );
}

main().catch((err) => {
  process.stderr.write(
    `memory-write-gate hook error: ${err?.message || String(err)}\n`,
  );
  // Fail-closed: surface to the user via "ask" rather than silently allowing.
  emit("ask", "memory-write-gate: internal error; falling back to ask");
});

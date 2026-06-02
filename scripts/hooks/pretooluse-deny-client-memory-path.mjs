// L4 of the memory-write hardening stack, folded into L2 (Claude Code only).
//
// Deny direct file writes that target Claude Code's client-local memory
// directory (~/.claude/projects/<workspace-slug>/memory/...). That dir is
// per-client and per-session, invisible to other agents, and creates a
// dual source of truth with the local LLM wiki. The discipline routes
// every "save to memory" through the wiki MCP tools; this hook is the
// deterministic enforcement.
//
// Decision contract: stdout JSON
//   {"hookSpecificOutput": {
//     "hookEventName":"PreToolUse",
//     "permissionDecision":"deny",
//     "permissionDecisionReason": <string>}}
//
// Unrelated tools and unrelated paths fall through silently (exit 0, no
// JSON) so Claude Code applies its default permission handling.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WATCHED_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.stdout.write("\n");
}

function untouched() {
  process.exit(0);
}

function expandHome(p) {
  if (typeof p !== "string" || !p) return "";
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    // Fail-open on parse failure — this hook only ever DENIES, so silently
    // letting an unrelated edit through is safer than blocking blindly.
    untouched();
    return;
  }

  const tool = payload?.tool_name || payload?.tool;
  if (!WATCHED_TOOLS.has(tool)) {
    untouched();
    return;
  }
  const input = payload?.tool_input || payload?.args || {};
  // Write/Edit pass file_path; NotebookEdit passes notebook_path.
  const targetRaw = input?.file_path || input?.notebook_path || input?.path;
  if (typeof targetRaw !== "string" || !targetRaw) {
    untouched();
    return;
  }
  const resolved = path.resolve(expandHome(targetRaw));

  // Check both real and symlinked home in case the project lives behind a
  // symlinked $HOME (unusual but documented).
  const homeReal = (() => {
    try {
      return fs.realpathSync(os.homedir());
    } catch {
      return os.homedir();
    }
  })();
  const projectsCandidates = [
    path.join(os.homedir(), ".claude", "projects"),
    path.join(homeReal, ".claude", "projects"),
  ];

  for (const projectsRoot of projectsCandidates) {
    const rel = path.relative(projectsRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue; // not under this candidate
    const parts = rel.split(path.sep);
    // Layout: <workspace-slug>/memory/<rest...>
    if (parts.length >= 2 && parts[1] === "memory") {
      deny(
        `memory-path-deny: writing to Claude Code's client-local memory (${targetRaw}) is blocked. Use the wiki MCP tools instead: save_to_dataset(dataset="knowledge", ...) for project facts, save_lesson with userRequested:true for self-improvement lessons (after the user explicitly asks). The wiki is the durable shared store; the client-local memory dir is per-session and per-client.`,
      );
      return;
    }
  }
  untouched();
}

main().catch((err) => {
  process.stderr.write(
    `deny-client-memory-path hook error: ${err?.message || String(err)}\n`,
  );
  process.exit(0); // fail-open on internal errors; never block unrelated edits
});

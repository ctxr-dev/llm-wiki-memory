// The memory-discipline text has ONE source: templates/agents-memory-instructions.md.
// This module READS that canonical .md (it does not restate the rules) and exposes it
// as INSTRUCTIONS for two consumers:
//   - the MCP server passes INSTRUCTIONS via the `instructions` field, returned on
//     `initialize` so EVERY connecting client (Claude Code, Cursor, Codex, Claude
//     Desktop, generic) receives the discipline, hooks or not.
//   - the Claude Code SessionStart hook prints the longer context block.
// The SAME .md is the @-include wired into a consumer's AGENTS.md / CLAUDE.md (D4), so
// the MCP-initialize instructions and the consumer @-include can never drift. Edit the
// discipline in the .md; the fuller per-topic detail lives in templates/rules/*.md.
// No em or en dashes in this file's own comments (project rule).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISCIPLINE_MD = path.resolve(HERE, "..", "..", "templates", "agents-memory-instructions.md");

// Strip the maintainer HTML-comment header so the instructions payload is clean prose.
// A missing file is fatal by design (like a missing prompt template): the discipline is
// not optional, so fail loud rather than ship an empty `instructions`.
export const INSTRUCTIONS = fs
  .readFileSync(DISCIPLINE_MD, "utf8")
  .replace(/<!--[\s\S]*?-->\s*/g, "")
  .trim();

// Longer SessionStart context: names the server + the discipline + a compile note.
export function buildSessionStartContext({
  serverName = "llm-wiki-memory",
  compileTriggered = false,
} = {}) {
  return [
    `Project memory is available through the \`${serverName}\` MCP server, backed by a local LLM wiki under ./.llm-wiki-memory/wiki (no RAG, no Docker).`,
    INSTRUCTIONS,
    compileTriggered
      ? "Compile was triggered in the background to promote any unprocessed daily docs."
      : "Compile was already attempted today (or is not due), so it was skipped this session start.",
  ].join("\n\n");
}

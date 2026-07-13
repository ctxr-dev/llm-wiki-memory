#!/usr/bin/env bash
# Print a ready-to-paste MCP server config for a given client. The memory
# server is a local stdio process; this resolves the absolute paths so the
# snippet works from any client (Cursor, Codex, Claude Desktop, generic), and
# emits a project-relative snippet for Claude Code's project-scope .mcp.json.
#
# Usage: mcp-config.sh <claude-code|cursor|claude-desktop|codex|generic|all>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"   # .llm-wiki-memory/src
TEMPLATES="$SRC_DIR/templates"
INDEX="$SRC_DIR/mcp-server/index.mjs"

if [[ "$(basename "$SRC_DIR")" == "src" && "$(basename "$(dirname "$SRC_DIR")")" == ".llm-wiki-memory" ]]; then
  WORKSPACE_DIR="$(cd "$SRC_DIR/../.." && pwd -P)"
else
  WORKSPACE_DIR="$(cd "$SRC_DIR/.." && pwd -P)"
fi
DATA_DIR="$WORKSPACE_DIR/.llm-wiki-memory"
# Home-based path (single install under $HOME) for project-scoped configs
# (Claude Code, Cursor). ${HOME} is interpolated by the MCP client at launch;
# a literal ~ is NOT expanded in JSON args, so never use it here.
INDEX_REL='${HOME}/.llm-wiki-memory/src/mcp-server/index.mjs'

# Project-scoped clients get a relative path (survives the workspace moving).
# Global single-file clients (Claude Desktop, ~/.codex) have no project cwd, so
# they need the absolute path. Neither needs MEMORY_DATA_DIR: the server
# self-discovers its data dir from its own file location (scripts/lib/env.mjs).
# Literal bash substitution (not sed) so an install path containing sed-special
# chars (# & \ /) can never corrupt the emitted config.
render_with() {
  local repl="$1" content
  content="$(cat "$2")"
  printf '%s\n' "${content//__SERVER_INDEX__/$repl}"
}
render_rel() { render_with "$INDEX_REL" "$1"; }
render_abs() { render_with "$INDEX" "$1"; }

emit() {
  case "$1" in
    claude-code)
      echo "# Claude Code - merge into ./.mcp.json (project scope; relative path):"
      cat "$TEMPLATES/mcp.json" ;;
    cursor)
      echo "# Cursor - merge into ./.cursor/mcp.json (project scope; relative path):"
      render_rel "$TEMPLATES/agents/clients/cursor.json" ;;
    claude-desktop)
      echo "# Claude Desktop - merge into claude_desktop_config.json (global; absolute path):"
      render_abs "$TEMPLATES/agents/clients/claude-desktop.json" ;;
    codex)
      echo "# Codex/OpenAI - add to ~/.codex/config.toml (global; absolute path) (or: codex mcp add):"
      render_abs "$TEMPLATES/agents/clients/openai-codex.toml" ;;
    generic)
      # A generic client has no guaranteed cwd, so emit an absolute path here
      # (the committed .agents/clients/generic-mcp.json stays relative for the
      # project-root-cwd case; this on-demand snippet is paste-anywhere).
      echo "# Generic MCP client - stdio server config (absolute; works from any cwd):"
      render_abs "$TEMPLATES/agents/clients/generic-mcp.json" ;;
    *)
      echo "unknown client: $1" >&2
      echo "valid: claude-code | cursor | claude-desktop | codex | generic | all" >&2
      return 1 ;;
  esac
}

CLIENT="${1:-all}"
if [[ "$CLIENT" == "all" ]]; then
  for c in claude-code cursor claude-desktop codex generic; do
    emit "$c"; echo
  done
else
  emit "$CLIENT"
fi

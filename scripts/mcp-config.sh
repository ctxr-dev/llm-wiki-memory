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
# Path relative to the workspace root, for configs that live IN the project and
# are launched with the project as cwd (Claude Code, Cursor/project, generic).
INDEX_REL="./.llm-wiki-memory/src/mcp-server/index.mjs"

# Project-scoped clients get a relative path (survives the workspace moving).
# Global single-file clients (Claude Desktop, ~/.codex) have no project cwd, so
# they need the absolute path. Neither needs MEMORY_DATA_DIR: the server
# self-discovers its data dir from its own file location (scripts/lib/env.mjs).
render_rel() { sed -e "s#__SERVER_INDEX__#$INDEX_REL#g" "$1"; }
render_abs() { sed -e "s#__SERVER_INDEX__#$INDEX#g" "$1"; }

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
      echo "# Generic MCP client - stdio server config (relative; launch from project root):"
      render_rel "$TEMPLATES/agents/clients/generic-mcp.json" ;;
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

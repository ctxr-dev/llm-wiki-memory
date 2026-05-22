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

render() { sed -e "s#__SERVER_INDEX__#$INDEX#g" -e "s#__DATA_DIR__#$DATA_DIR#g" "$1"; }

emit() {
  case "$1" in
    claude-code)
      echo "# Claude Code - merge into ./.mcp.json (project scope; relative path):"
      cat "$TEMPLATES/mcp.json" ;;
    cursor)
      echo "# Cursor - merge into ./.cursor/mcp.json (or global ~/.cursor/mcp.json):"
      render "$TEMPLATES/agents/clients/cursor.json" ;;
    claude-desktop)
      echo "# Claude Desktop - merge into claude_desktop_config.json:"
      render "$TEMPLATES/agents/clients/claude-desktop.json" ;;
    codex)
      echo "# Codex/OpenAI - add to ~/.codex/config.toml (or: codex mcp add):"
      render "$TEMPLATES/agents/clients/openai-codex.toml" ;;
    generic)
      echo "# Generic MCP client - stdio server config:"
      render "$TEMPLATES/agents/clients/generic-mcp.json" ;;
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

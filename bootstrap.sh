#!/usr/bin/env bash
# llm-wiki-memory bootstrap. Installs the local LLM-wiki memory system into a
# target project: hooks, the stdio MCP server, the hosted wiki, and config.
# No Docker, no external service. Idempotent.
#
# Expected layout: this script lives at <workspace>/.llm-wiki-memory/src/bootstrap.sh
#
# Usage:
#   ./.llm-wiki-memory/src/bootstrap.sh [--commit-memory] [--provider claude|codex|anthropic|openai] [--schedule daily|off]
#
#   --commit-memory  Do NOT gitignore the whole ./.llm-wiki-memory tree; commit
#                    the wiki content (still ignores node_modules, the embed
#                    index, and settings/.env). Default: ignore the whole tree.
#   --schedule       daily: (re)install a daily compile job (launchd on macOS,
#                    crontab on Linux). off: remove it. Default: do nothing.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Workspace = two levels up when installed at <ws>/.llm-wiki-memory/src,
# else the parent (repo-dev checkout).
if [[ "$(basename "$SRC_DIR")" == "src" && "$(basename "$(dirname "$SRC_DIR")")" == ".llm-wiki-memory" ]]; then
  WORKSPACE_DIR="$(cd "$SRC_DIR/../.." && pwd -P)"
else
  WORKSPACE_DIR="$(cd "$SRC_DIR/.." && pwd -P)"
fi
DATA_DIR="$WORKSPACE_DIR/.llm-wiki-memory"

COMMIT_MEMORY=0
PROVIDER=""
SCHEDULE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit-memory) COMMIT_MEMORY=1; shift ;;
    --provider) PROVIDER="${2:-}"; shift 2 ;;
    --schedule) SCHEDULE="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

log() { printf '\033[1;36m[llm-wiki-memory]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[llm-wiki-memory] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- prereqs ---
command -v node >/dev/null 2>&1 || die "node is required (>=20)."
command -v git  >/dev/null 2>&1 || die "git is required."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "node >=20 required (found $(node -v))."

# --- install deps ---
log "Installing dependencies in $SRC_DIR ..."
( cd "$SRC_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1 ) || die "npm install failed in $SRC_DIR."

# Confirm the skill CLI resolves.
if ! ( cd "$SRC_DIR" && node -e "require('module').createRequire(process.cwd()+'/package.json').resolve('@ctxr/skill-llm-wiki/package.json')" >/dev/null 2>&1 ); then
  die "@ctxr/skill-llm-wiki is not resolvable. Ensure it is installable from your registry (or vendor it)."
fi

# --- detect provider ---
if [[ -z "$PROVIDER" ]]; then
  for p in claude codex; do
    if command -v "$p" >/dev/null 2>&1; then PROVIDER="$p"; break; fi
  done
  [[ -z "$PROVIDER" ]] && PROVIDER="claude"
fi
log "LLM provider: $PROVIDER"

# --- settings/.env ---
mkdir -p "$DATA_DIR/settings"
ENV_FILE="$DATA_DIR/settings/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$SRC_DIR/templates/env.example" "$ENV_FILE"
  # Apply provider choice.
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s/^MEMORY_LLM_PROVIDER=.*/MEMORY_LLM_PROVIDER=$PROVIDER/" "$ENV_FILE"
  else
    sed -i "s/^MEMORY_LLM_PROVIDER=.*/MEMORY_LLM_PROVIDER=$PROVIDER/" "$ENV_FILE"
  fi
  log "Wrote $ENV_FILE"
else
  log "Kept existing $ENV_FILE"
fi

# --- Claude Code hooks ---
node "$SRC_DIR/scripts/merge-config.mjs" \
  "$WORKSPACE_DIR/.claude/settings.json" \
  "$SRC_DIR/templates/claude/settings.json" \
  hooks

# --- MCP server registration (Claude Code project scope) ---
node "$SRC_DIR/scripts/merge-config.mjs" \
  "$WORKSPACE_DIR/.mcp.json" \
  "$SRC_DIR/templates/mcp.json" \
  mcpServers

# --- vendor-neutral .agents/ config (Cursor, Codex, Claude Desktop, generic) ---
# Use a path RELATIVE to the workspace root so the config survives the workspace
# being moved/renamed: clients launch the stdio server with the project root as
# cwd, and the server self-discovers its data dir from its own file location
# (see scripts/lib/env.mjs), so no MEMORY_DATA_DIR env is needed here.
INDEX_REL="./.llm-wiki-memory/src/mcp-server/index.mjs"
# Idempotent render: write the template on first install, but NEVER clobber a
# file the user has since customized (e.g. wrapping the server with their
# org's prompt_security shim). If the on-disk file differs from a pristine
# render, preserve it and tell the operator how to regenerate.
render_agent() {
  local src="$1" dst="$2" rendered
  rendered="$(sed -e "s#__SERVER_INDEX__#$INDEX_REL#g" "$src")"
  if [[ -f "$dst" ]] && [[ "$(cat "$dst")" != "$rendered" ]]; then
    log "Preserving customized $dst (delete it to regenerate from template)"
    return 0
  fi
  printf '%s\n' "$rendered" > "$dst"
}
mkdir -p "$WORKSPACE_DIR/.agents/clients"
cp "$SRC_DIR/templates/agents/README.md" "$WORKSPACE_DIR/.agents/README.md"
render_agent "$SRC_DIR/templates/agents/mcp.json" "$WORKSPACE_DIR/.agents/mcp.json"
for c in cursor claude-desktop generic-mcp; do
  render_agent "$SRC_DIR/templates/agents/clients/$c.json" "$WORKSPACE_DIR/.agents/clients/$c.json"
done
render_agent "$SRC_DIR/templates/agents/clients/openai-codex.toml" "$WORKSPACE_DIR/.agents/clients/openai-codex.toml"
log "Wrote vendor-neutral MCP config to .agents/ (Cursor, Codex, Claude Desktop, generic)."

# --- materialise the wiki ---
log "Initialising the hosted wiki ..."
( cd "$SRC_DIR" && MEMORY_DATA_DIR="$DATA_DIR" node scripts/cli.mjs init >/dev/null ) || die "wiki init failed."

# --- validate the wiki (non-fatal) ---
VALIDATE_OUT="$(cd "$SRC_DIR" && MEMORY_DATA_DIR="$DATA_DIR" node scripts/cli.mjs validate 2>&1 || true)"
if printf '%s' "$VALIDATE_OUT" | grep -q "0 error"; then
  log "Wiki validation passed."
else
  log "WARNING: wiki validation reported issues (continuing anyway):"
  log "$VALIDATE_OUT"
fi

# --- render memory-discipline skill/rule files to all agent surfaces ---
if [ -d "$SRC_DIR/templates/skills" ]; then
  for dest in "$WORKSPACE_DIR/.agents/rules" "$WORKSPACE_DIR/.claude/skills" "$WORKSPACE_DIR/.cursor/rules"; do
    mkdir -p "$dest"
    # Plain copy (no placeholder substitution). Quoted glob expands per file.
    for f in "$SRC_DIR"/templates/skills/*.md; do
      [ -e "$f" ] && cp "$f" "$dest/"
    done
  done
  log "Rendered memory rules to .agents/rules, .claude/skills, and .cursor/rules."
fi

# --- pointer block in AGENTS.md and CLAUDE.md (idempotent, marker-fenced) ---
POINTER_CONTENT="$(cat <<'EOF'
## Project memory (llm-wiki-memory)

Project memory is available through the local `llm-wiki-memory` MCP server.
The memory discipline rules live in `.agents/rules/` (also mirrored to
`.claude/skills/`). Read them before doing non-trivial work.

Key tools:
- `recall_lessons`: call BEFORE starting any non-trivial work.
- `save_lesson`: call the moment the user corrects you.
- `save_to_dataset`: persist knowledge, plans, and investigations.
- `search_memory`: query the wiki for relevant context.
EOF
)"
for doc in "$WORKSPACE_DIR/AGENTS.md" "$WORKSPACE_DIR/CLAUDE.md"; do
  printf '%s' "$POINTER_CONTENT" | node "$SRC_DIR/scripts/merge-marker.mjs" \
    "$doc" "<!-- BEGIN llm-wiki-memory -->" "<!-- END llm-wiki-memory -->" -
done
log "Updated AGENTS.md and CLAUDE.md memory pointer blocks."

# --- gitignore ---
GITIGNORE="$WORKSPACE_DIR/.gitignore"
touch "$GITIGNORE"
if [[ "$COMMIT_MEMORY" -eq 1 ]]; then
  for line in "/.llm-wiki-memory/src/node_modules" "/.llm-wiki-memory/index" "/.llm-wiki-memory/settings/.env" "/.llm-wiki-memory/src/.compile-state.json*" "/.llm-wiki-memory/src/.compile.lock"; do
    grep -qxF "$line" "$GITIGNORE" || echo "$line" >> "$GITIGNORE"
  done
  log "Committing wiki content; ignoring node_modules / index / secrets only."
else
  grep -qxF "/.llm-wiki-memory" "$GITIGNORE" || {
    printf '\n# llm-wiki-memory (local memory; not committed)\n/.llm-wiki-memory\n' >> "$GITIGNORE"
  }
  log "Ignoring the whole /.llm-wiki-memory tree (use --commit-memory to commit the wiki)."
fi

# --- optional scheduled compile job ---
schedule_job() {
  local action="$1"
  local job_cmd="node \"$SRC_DIR/scripts/cli.mjs\" compile"
  # Stable id derived from the workspace path (sanitised + short hash).
  local ws_hash
  ws_hash="$(printf '%s' "$WORKSPACE_DIR" | cksum | awk '{print $1}')"

  if [[ "$(uname)" == "Darwin" ]]; then
    if ! command -v launchctl >/dev/null 2>&1; then
      log "WARNING: launchctl not available; skipping schedule setup."
      return 0
    fi
    local label="com.llm-wiki-memory.$ws_hash"
    local plist="$HOME/Library/LaunchAgents/$label.plist"
    # Always unload first so a re-run replaces cleanly (idempotent).
    launchctl unload "$plist" >/dev/null 2>&1 || true
    if [[ "$action" == "off" ]]; then
      rm -f "$plist"
      log "Removed scheduled compile job ($label)."
      return 0
    fi
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MEMORY_DATA_DIR</key>
    <string>$DATA_DIR</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$job_cmd</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
</dict>
</plist>
PLIST
    launchctl load "$plist" >/dev/null 2>&1 || log "WARNING: launchctl load failed for $plist."
    log "Installed daily compile job (launchd, 03:00): $plist"
  else
    if ! command -v crontab >/dev/null 2>&1; then
      log "WARNING: crontab not available; skipping schedule setup."
      return 0
    fi
    local tag="# llm-wiki-memory:$WORKSPACE_DIR"
    # Filter out any prior line for this workspace (idempotent).
    local filtered
    filtered="$(crontab -l 2>/dev/null | grep -vF "$tag" || true)"
    if [[ "$action" == "off" ]]; then
      printf '%s\n' "$filtered" | grep -v '^$' | crontab - 2>/dev/null || true
      log "Removed scheduled compile job (crontab)."
      return 0
    fi
    local line="0 3 * * * MEMORY_DATA_DIR=\"$DATA_DIR\" $job_cmd $tag"
    { printf '%s\n' "$filtered" | grep -v '^$'; printf '%s\n' "$line"; } | crontab - \
      || log "WARNING: failed to update crontab."
    log "Installed daily compile job (crontab, 03:00) tagged: $tag"
  fi
}

case "$SCHEDULE" in
  "") : ;;
  daily) schedule_job daily ;;
  off)   schedule_job off ;;
  *) log "WARNING: unknown --schedule value '$SCHEDULE' (expected daily|off); skipping." ;;
esac

log "Done."
log "Claude Code: restart so it picks up .mcp.json and .claude/settings.json (hooks + auto-capture)."
log "Other agents (Cursor / Codex / Claude Desktop / generic): register the server with"
log "  ./.llm-wiki-memory/src/scripts/mcp-config.sh <client>   (or see .agents/README.md)"
log "Memory wiki: $DATA_DIR/wiki"

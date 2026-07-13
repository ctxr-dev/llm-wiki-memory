#!/usr/bin/env bash
# llm-wiki-memory bootstrap. Installs the local LLM-wiki memory system into a
# target project: hooks, the stdio MCP server, the hosted wiki, and config.
# No Docker, no external service. Idempotent.
#
# Expected layout: this script lives at <workspace>/.llm-wiki-memory/src/bootstrap.sh
#
# Usage:
#   ./.llm-wiki-memory/src/bootstrap.sh [--commit-memory] [--template <name>] [--provider claude|codex|anthropic|openai|openai-compatible|mock] [--schedule daily|off] [--enable-self-observability|--disable-self-observability]
#   ./.llm-wiki-memory/src/bootstrap.sh --uninstall
#
#   --template       Layout template to install into a FRESH wiki (one of the
#                    examples/layouts/<name>/ folders). Default: default. A repo
#                    mount uses `repo`. Ignored once a wiki already exists.
#   --uninstall      Reverse the machine-managed install surfaces: remove the
#                    MCP registration, the cron/launchd job, and the chained
#                    sync-embeddings git-hook block; then PRINT the manual
#                    reversals (gitignore edit, per-mount personal git, deleting
#                    the mount). Never deletes memory data. Idempotent.
#   --commit-memory  Do NOT gitignore the whole ./.llm-wiki-memory tree; commit
#                    the wiki content (still ignores node_modules, the embed
#                    index, and settings/.env). Default: ignore the whole tree.
#   --enable-self-observability / --disable-self-observability
#                    Opt in / out of self-observability: reference the
#                    `self-observability` rule into this project's rule dirs so
#                    the agent records llm-wiki-memory anomalies under
#                    .llm-wiki-memory/monitoring/ and offers engine fixes at
#                    session-end. Consent persists in a settings sentinel across
#                    re-runs; default: leave prior consent untouched (off when
#                    never set).
#   --schedule       daily: (re)install a daily compile job (launchd on macOS,
#                    crontab on Linux). off: remove it. Default: do nothing.
#   --provider       Explicit choice. Otherwise auto-detected in priority order:
#                    1) `claude` CLI on PATH, 2) `codex` CLI on PATH,
#                    3) $ANTHROPIC_API_KEY exported, 4) $OPENAI_API_KEY exported,
#                    5) $MEMORY_LLM_BASE_URL exported, 6) ollama reachable at
#                    http://localhost:11434, 7) fallback to `mock` (a stderr
#                    warning is emitted in this case).
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
TEMPLATE="default"
UNINSTALL=0
SELF_OBS=""   # "on" enables, "off" disables, "" leaves prior consent untouched
while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit-memory) COMMIT_MEMORY=1; shift ;;
    --template) TEMPLATE="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --provider) PROVIDER="${2:-}"; shift 2 ;;
    --schedule) SCHEDULE="${2:-}"; shift 2 ;;
    --enable-self-observability)  SELF_OBS="on";  shift ;;
    --disable-self-observability) SELF_OBS="off"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

log() { printf '\033[1;36m[llm-wiki-memory]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[llm-wiki-memory] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- uninstall (thin shell; fs reversals live in scripts/uninstall.mjs) ---
# Remove the cron/launchd job (OS glue owned here), then hand the filesystem
# reversals (MCP registration + chained git-hook block) to the Node helper,
# which also prints the manual steps it deliberately does NOT perform. Never
# deletes memory data. Idempotent.
if [[ "$UNINSTALL" -eq 1 ]]; then
  command -v node >/dev/null 2>&1 || die "node is required to uninstall."
  log "Uninstalling llm-wiki-memory from $WORKSPACE_DIR (memory data is left intact) ..."
  ws_hash="$(printf '%s' "$WORKSPACE_DIR" | cksum | awk '{print $1}')"
  if [[ "$(uname)" == "Darwin" ]]; then
    plist="$HOME/Library/LaunchAgents/com.llm-wiki-memory.$ws_hash.plist"
    if command -v launchctl >/dev/null 2>&1; then
      launchctl unload "$plist" >/dev/null 2>&1 || true
    fi
    rm -f "$plist"
    log "Removed launchd cron job if present ($plist)."
  elif command -v crontab >/dev/null 2>&1; then
    tag="# llm-wiki-memory:$WORKSPACE_DIR"
    filtered="$(crontab -l 2>/dev/null | awk -v t="$tag" 'index($0, t) == 0 || substr($0, length($0) - length(t) + 1) != t' || true)"
    printf '%s\n' "$filtered" | grep -v '^$' | crontab - 2>/dev/null || true
    rm -f "$DATA_DIR/state/cron-daily.sh"
    log "Removed crontab cron job if present (tag: $tag)."
  fi
  node "$SRC_DIR/scripts/uninstall.mjs" "$WORKSPACE_DIR" || die "uninstall helper failed."
  log "Uninstall complete."
  exit 0
fi

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
# Priority order (first match wins). Each branch corresponds to a documented
# install context: managed-by-claude / managed-by-codex / direct API key /
# local model server / nothing-installed. The `mock` fallback exists so a fresh
# clone of this repo doesn't fail at runtime — it lets every test pass and
# every consolidate run skip its LLM passes cleanly while telling the operator
# how to enable them. Without this, an install with no provider silently sat
# on "claude" and threw cryptic CLI-not-found errors at runtime.
BASE_URL_HINT=""
if [[ -z "$PROVIDER" ]]; then
  if command -v claude >/dev/null 2>&1; then
    PROVIDER="claude"
  elif command -v codex >/dev/null 2>&1; then
    PROVIDER="codex"
  elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    PROVIDER="anthropic"
  elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
    PROVIDER="openai"
  elif [[ -n "${MEMORY_LLM_BASE_URL:-}" ]]; then
    PROVIDER="openai-compatible"
  elif command -v curl >/dev/null 2>&1 && curl -fsS --max-time 1 http://localhost:11434/api/version >/dev/null 2>&1; then
    PROVIDER="openai-compatible"
    # Probe-detected ollama on its default port: pre-fill MEMORY_LLM_BASE_URL
    # in .env so the user doesn't have to. They can override anytime.
    BASE_URL_HINT="http://localhost:11434/v1"
  else
    PROVIDER="mock"
  fi
fi
log "LLM provider: $PROVIDER"
if [[ "$PROVIDER" == "mock" ]]; then
  printf '\033[1;33m[llm-wiki-memory] WARN:\033[0m No LLM provider detected (no claude/codex CLI on PATH; no ANTHROPIC_API_KEY/OPENAI_API_KEY/MEMORY_LLM_BASE_URL set; no ollama at http://localhost:11434). Defaulting to MEMORY_LLM_PROVIDER=mock. Consolidate'\''s LLM passes will be skipped. Set MEMORY_LLM_PROVIDER (or one of those env vars) in %s to enable.\n' "$DATA_DIR/settings/.env" >&2
fi

# --- settings/.env ---
mkdir -p "$DATA_DIR/settings"
ENV_FILE="$DATA_DIR/settings/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$SRC_DIR/templates/env.example" "$ENV_FILE"
  # Apply provider choice (+ pre-filled BASE_URL when probe-detected).
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s|^MEMORY_LLM_PROVIDER=.*|MEMORY_LLM_PROVIDER=$PROVIDER|" "$ENV_FILE"
    if [[ -n "$BASE_URL_HINT" ]]; then
      # Replace MEMORY_LLM_BASE_URL line if present; otherwise append.
      if grep -q "^MEMORY_LLM_BASE_URL=" "$ENV_FILE"; then
        sed -i '' "s|^MEMORY_LLM_BASE_URL=.*|MEMORY_LLM_BASE_URL=$BASE_URL_HINT|" "$ENV_FILE"
      else
        printf '\nMEMORY_LLM_BASE_URL=%s\n' "$BASE_URL_HINT" >> "$ENV_FILE"
      fi
    fi
  else
    sed -i "s|^MEMORY_LLM_PROVIDER=.*|MEMORY_LLM_PROVIDER=$PROVIDER|" "$ENV_FILE"
    if [[ -n "$BASE_URL_HINT" ]]; then
      if grep -q "^MEMORY_LLM_BASE_URL=" "$ENV_FILE"; then
        sed -i "s|^MEMORY_LLM_BASE_URL=.*|MEMORY_LLM_BASE_URL=$BASE_URL_HINT|" "$ENV_FILE"
      else
        printf '\nMEMORY_LLM_BASE_URL=%s\n' "$BASE_URL_HINT" >> "$ENV_FILE"
      fi
    fi
  fi
  log "Wrote $ENV_FILE"
else
  # Idempotent: preserve user edits. If MEMORY_LLM_PROVIDER is already set, the
  # auto-detected value is informational only — the file wins via env.mjs's
  # process.env-then-.env-file precedence.
  if grep -q "^MEMORY_LLM_PROVIDER=" "$ENV_FILE"; then
    EXISTING_PROVIDER="$(grep "^MEMORY_LLM_PROVIDER=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs)"
    if [[ -n "$EXISTING_PROVIDER" && "$EXISTING_PROVIDER" != "$PROVIDER" ]]; then
      log "Kept existing $ENV_FILE (MEMORY_LLM_PROVIDER=$EXISTING_PROVIDER; auto-detect would have chosen $PROVIDER)"
    else
      log "Kept existing $ENV_FILE"
    fi
  else
    log "Kept existing $ENV_FILE"
  fi
fi

# --- settings/settings.yaml (canonical app config) + auto-migration ---
# Run the migrator first. On a fresh install it's a no-op; on an upgrade it
# carries old .env keys + old llm.yaml into the new settings.yaml, backs up
# the old .env, and rewrites .env to the strict subset only.
if ! node "$SRC_DIR/scripts/migrate-settings.mjs" "$DATA_DIR" >&2; then
  log "ERROR: settings migration failed (see the '[migrate-settings] failed:' line above). Your existing .env is left intact; aborting before the settings.yaml defaults fallback so you don't silently run on default config. Fix the cause and re-run bootstrap."
  exit 1
fi

SETTINGS_YAML_FILE="$DATA_DIR/settings/settings.yaml"
if [[ ! -f "$SETTINGS_YAML_FILE" ]]; then
  cp "$SRC_DIR/templates/settings.yaml" "$SETTINGS_YAML_FILE"
  log "Wrote $SETTINGS_YAML_FILE"
else
  log "Kept existing $SETTINGS_YAML_FILE"
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
INDEX_REL='${HOME}/.llm-wiki-memory/src/mcp-server/index.mjs'
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
# --template selects the layout for a FRESH wiki (default: default). A repo
# mount passes `repo`; once a wiki exists, init keeps the existing layout.
log "Initialising the hosted wiki (template: $TEMPLATE) ..."
( cd "$SRC_DIR" && MEMORY_DATA_DIR="$DATA_DIR" node scripts/cli.mjs init --template "$TEMPLATE" >/dev/null ) || die "wiki init failed."

# --- validate the wiki (non-fatal) ---
VALIDATE_OUT="$(cd "$SRC_DIR" && MEMORY_DATA_DIR="$DATA_DIR" node scripts/cli.mjs validate 2>&1 || true)"
if printf '%s' "$VALIDATE_OUT" | grep -q "0 error"; then
  log "Wiki validation passed."
else
  log "WARNING: wiki validation reported issues (continuing anyway):"
  log "$VALIDATE_OUT"
fi

# --- wiki git repo (auto-commit history) ---
# The auto-commit layer (settings wiki.autoCommit) commits ONLY to the wiki's
# OWN repo: it verifies `git -C <wiki> rev-parse --show-toplevel` equals the
# wiki root, so it can never commit into the enclosing project. Give the wiki
# that repo on the default (gitignored) install. Under --commit-memory the
# wiki content rides inside the WORKSPACE repo, where a nested .git would
# break tracking — skip, and auto-commit stays a silent no-op.
if [[ "$COMMIT_MEMORY" -eq 0 && -d "$DATA_DIR/wiki" && ! -e "$DATA_DIR/wiki/.git" ]]; then
  if git -C "$DATA_DIR/wiki" init -q 2>/dev/null; then
    log "Initialised git repo at $DATA_DIR/wiki (auto-commit history; disable via settings wiki.autoCommit)"
  else
    log "WARNING: could not git init $DATA_DIR/wiki; wiki auto-commit stays a no-op"
  fi
fi

# --- wire memory rules/skills + AGENTS.md/CLAUDE.md as @-pointers (reference-only) ---
# Every llm-wiki-memory rule/skill becomes a prefixed llm-wiki-memory-<name>.md
# @-pointer into ~/.llm-wiki-memory/src (never a copy or symlink); AGENTS.md/CLAUDE.md
# get one marker-fenced @-include. Self-observability stays opt-in via the sentinel,
# so a flag-less re-bootstrap preserves consent. Logic: scripts/wire-memory-surfaces.mjs.
SELF_OBS_SENTINEL="$DATA_DIR/settings/self-observability.enabled"
if [ "$SELF_OBS" = "on" ]; then
  : > "$SELF_OBS_SENTINEL"
elif [ "$SELF_OBS" = "off" ]; then
  rm -f "$SELF_OBS_SENTINEL"
fi
SELF_OBS_ENABLED=0
[ -f "$SELF_OBS_SENTINEL" ] && SELF_OBS_ENABLED=1
node "$SRC_DIR/scripts/wire-memory-surfaces.mjs" \
  "$SRC_DIR" "$WORKSPACE_DIR" "$HOME" "$SELF_OBS_ENABLED"
log "Wired memory rules/skills as @-pointers (.agents/rules, .claude/rules, .claude/skills, .cursor/rules) and AGENTS.md/CLAUDE.md @-includes → ~/.llm-wiki-memory/src."

# --- gitignore ---
GITIGNORE="$WORKSPACE_DIR/.gitignore"
touch "$GITIGNORE"
if [[ "$COMMIT_MEMORY" -eq 1 ]]; then
  # Note on state paths: after the env.mjs refactor, compile state + lock +
  # the embed-gc and consolidate state files live under <data>/state/, not
  # <data>/src/. Ignore the whole `state/` directory so locks + journals +
  # the consolidate/embed-gc bookkeeping never enter git, regardless of which
  # subsystem owns them. Wiki index.md files are DERIVED (regenerated locally on
  # init/clone-adopt via index-rebuild), so they are ignored too — this keeps a
  # clone free of them, which is what makes init's missing-index recovery fire.
  for line in "/.llm-wiki-memory/src/node_modules" "/.llm-wiki-memory/index" "/.llm-wiki-memory/settings/.env" "/.llm-wiki-memory/settings/.env.bak" "/.llm-wiki-memory/state" "/.llm-wiki-memory/monitoring" "/.llm-wiki-memory/settings/self-observability.enabled" "/.llm-wiki-memory/wiki/**/index.md"; do
    grep -qxF "$line" "$GITIGNORE" || echo "$line" >> "$GITIGNORE"
  done
  log "Committing wiki content; ignoring node_modules / index / secrets only."
  # Phase G mount primitives: when the wiki content rides inside the consuming
  # repo AND its layout declares shared (ownership: repo) categories, provision
  # the per-folder git surfaces (negated .gitignore, private personal git,
  # host-ignore shadow check, chained sync-embeddings hook). A no-op — logged as
  # skipped — when no shared category is declared, so a plain commit-memory
  # install is byte-identical to before. The interactive repo-vs-personal FLOW
  # is Phase J; this only wires the primitives.
  MOUNT_OUT="$(node "$SRC_DIR/scripts/mount-init.mjs" "$WORKSPACE_DIR" 2>&1 || true)"
  if printf '%s' "$MOUNT_OUT" | grep -q '"skipped": "no-shared-categories"'; then
    :
  else
    log "Mount primitives provisioned (negated .gitignore, personal git, sync-embeddings hook)."
    printf '%s' "$MOUNT_OUT" | grep -q '"ok": false' && log "$MOUNT_OUT"
  fi
else
  grep -qxF "/.llm-wiki-memory" "$GITIGNORE" || {
    printf '\n# llm-wiki-memory (local memory; not committed)\n/.llm-wiki-memory\n' >> "$GITIGNORE"
  }
  log "Ignoring the whole /.llm-wiki-memory tree (use --commit-memory to commit the wiki)."
fi

# --- optional scheduled cron-job (hourly, self-throttling, self-healing) ---
# Runs HOURLY at minute 00. Each tick invokes `cli.mjs cron-job` which:
#   1. compile      promotes any unprocessed daily docs (its own per-UTC-day
#                   state file makes successive hourly attempts cheap).
#   2. consolidate --if-due  refines the corpus (deterministic dedup + LLM
#                   merge + semantic refresh), self-throttled to
#                   MEMORY_CONSOLIDATE_INTERVAL_DAYS (default 1).
# Each attempt appends a structured entry to state/.consolidate-attempts.log
# (success or error). The SessionStart hook runs `cron-health` and surfaces
# any UNRESOLVED error to the user — the system either self-heals on the
# next hourly tick or the user sees the failure and can investigate.
# Cron is set to fire hourly (not daily) so transient errors clear quickly.

# Escape XML metacharacters for safe interpolation into the launchd plist.
# A workspace path containing & < > (all legal in APFS filenames) — or the
# literal double-quotes job_cmd wraps around $SRC_DIR — would otherwise emit
# malformed plist XML, which launchd silently refuses to load: the cron job
# never runs and nothing tells the operator. Order matters: & first, so the
# &amp; / &lt; ... entities we introduce aren't re-escaped.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

schedule_job() {
  local action="$1"
  # Resolve an absolute node path so the launchd job (minimal PATH) finds it,
  # and so we can pass node + args as discrete ProgramArguments elements rather
  # than a `/bin/sh -c "<string>"` — which would mis-parse an install path that
  # contains a literal double-quote.
  local node_bin
  node_bin="$(command -v node || echo node)"
  local cli_path="$SRC_DIR/scripts/cli.mjs"
  # Hybrid PATH for the scheduled job: the installing user's live PATH first,
  # then well-known CLI install dirs (claude / codex / cursor-agent homes).
  # launchd and cron strip PATH to /usr/bin:/bin:/usr/sbin:/sbin, which hides
  # the provider CLIs and silently disabled LLM promotion (2026-06-04
  # incident). Built by the same node helper llm.mjs uses at runtime — one
  # source of truth; fall back to the live PATH if the helper fails.
  local cron_path
  cron_path="$("$node_bin" "$SRC_DIR/scripts/lib/cron-path.mjs" 2>/dev/null || true)"
  [[ -n "$cron_path" ]] || cron_path="$PATH"
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
    local label_x data_dir_x node_bin_x cli_path_x cron_path_x
    label_x="$(xml_escape "$label")"
    data_dir_x="$(xml_escape "$DATA_DIR")"
    node_bin_x="$(xml_escape "$node_bin")"
    cli_path_x="$(xml_escape "$cli_path")"
    cron_path_x="$(xml_escape "$cron_path")"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label_x</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MEMORY_DATA_DIR</key>
    <string>$data_dir_x</string>
    <key>PATH</key>
    <string>$cron_path_x</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin_x</string>
    <string>$cli_path_x</string>
    <string>cron-job</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
</dict>
</plist>
PLIST
    launchctl load "$plist" >/dev/null 2>&1 || log "WARNING: launchctl load failed for $plist."
    log "Installed hourly cron-job (launchd, every hour at :00): $plist"
  else
    if ! command -v crontab >/dev/null 2>&1; then
      log "WARNING: crontab not available; skipping schedule setup."
      return 0
    fi
    local tag="# llm-wiki-memory:$WORKSPACE_DIR"
    local wrapper="$DATA_DIR/state/cron-daily.sh"
    # Filter out any prior line for THIS workspace (idempotent). The tag is the
    # exact line suffix (see the cron line below), so match it as a suffix with
    # awk's literal index/substr — NOT `grep -vF`, whose UNANCHORED substring
    # match would also strip a sibling workspace whose path is a PREFIX of this
    # one (e.g. /a/proj vs /a/proj2), silently killing the sibling's cron job.
    local filtered
    filtered="$(crontab -l 2>/dev/null | awk -v t="$tag" 'index($0, t) == 0 || substr($0, length($0) - length(t) + 1) != t' || true)"
    if [[ "$action" == "off" ]]; then
      printf '%s\n' "$filtered" | grep -v '^$' | crontab - 2>/dev/null || true
      rm -f "$wrapper"
      log "Removed scheduled compile job (crontab) + wrapper."
      return 0
    fi
    # Generate a wrapper script that the cron entry calls. Putting the env
    # var + command chain INSIDE a bash double-quoted script side-steps the
    # cron-line escaping problems for $DATA_DIR / $SRC_DIR: cron interprets
    # `%` as a newline, and a single-quote in either path would close the
    # outer `sh -c '...'` quoting. The wrapper carries the paths in
    # double-quotes inside its own bash context where neither character is
    # special. (POSIX shell scopes `VAR=val cmd1 && cmd2` to cmd1 only — so
    # we also export the env so it applies to BOTH compile and consolidate.)
    mkdir -p "$(dirname "$wrapper")"
    cat > "$wrapper" <<WRAPPER
#!/usr/bin/env bash
# Auto-generated by llm-wiki-memory bootstrap.sh — invoked HOURLY by cron.
# The cron-job subcommand handles compile + consolidate + structured
# attempt logging. Do NOT hand-edit; re-run bootstrap.sh to regenerate.
set -u
export MEMORY_DATA_DIR="$DATA_DIR"
export PATH="$cron_path"
exec "$node_bin" "$SRC_DIR/scripts/cli.mjs" cron-job
WRAPPER
    chmod +x "$wrapper"
    # 0 * * * * = every hour at :00. Internal --if-due throttle keeps the
    # actual heavy work bounded to once per MEMORY_CONSOLIDATE_INTERVAL_DAYS.
    local line="0 * * * * \"$wrapper\" $tag"
    { printf '%s\n' "$filtered" | grep -v '^$'; printf '%s\n' "$line"; } | crontab - \
      || log "WARNING: failed to update crontab."
    log "Installed hourly cron-job (crontab, every hour at :00) via wrapper $wrapper tagged: $tag"
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

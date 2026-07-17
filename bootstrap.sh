#!/usr/bin/env bash
# llm-wiki-memory bootstrap. Installs the local LLM-wiki memory system into a
# target project: hooks, the stdio MCP server, the hosted wiki, and config.
# No Docker, no external service. Idempotent.
#
# Expected layout: this script lives at <workspace>/.llm-wiki-memory/src/bootstrap.sh
#
# Usage:
#   ./.llm-wiki-memory/src/bootstrap.sh [--commit-memory] [--template <name>] [--provider claude|codex|anthropic|openai|openai-compatible|mock] [--schedule hourly|off] [--enable-self-observability|--disable-self-observability] [--upgrade] [--migrate] [--uninstall]
#   --upgrade        fetch + fast-forward-merge the engine, then re-run this
#                    script (idempotent re-wire) with --migrate. One deterministic
#                    command instead of a prose runbook.
#   --migrate        run idempotent data migrations (migrate-identity) after install.
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
#   --commit-memory  Do NOT gitignore the whole ./.llm-wiki-memory tree; git-track
#                    the wiki content so YOU commit it (the engine never does; still
#                    ignores node_modules, the embed index, settings/.env). Default:
#                    ignore the whole tree. A shared (repo-layout) wiki is tracked
#                    automatically without this flag.
#   --enable-self-observability / --disable-self-observability
#                    Opt in / out of self-observability: reference the
#                    `self-observability` rule into this project's rule dirs so
#                    the agent records llm-wiki-memory anomalies under
#                    .llm-wiki-memory/monitoring/ and offers engine fixes at
#                    session-end. Consent persists in a settings sentinel across
#                    re-runs; default: leave prior consent untouched (off when
#                    never set).
#   --schedule       hourly: (re)install the maintenance job (launchd on macOS,
#                    crontab on Linux); it fires HOURLY at minute 0. off: remove
#                    it. Default: do nothing. ('daily' is a deprecated alias for
#                    hourly — it installs the SAME hourly job.)
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
UPGRADE=0
MIGRATE=0
SELF_OBS=""   # "on" enables, "off" disables, "" leaves prior consent untouched
REEXEC_ARGS=()   # every arg except --upgrade, replayed when --upgrade re-execs the fresh install
while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit-memory) COMMIT_MEMORY=1; REEXEC_ARGS+=("$1"); shift ;;
    --template) [[ $# -ge 2 && "${2:-}" != --* ]] || { echo "--template requires a value" >&2; exit 1; }; TEMPLATE="$2"; REEXEC_ARGS+=("$1" "$2"); shift 2 ;;
    --uninstall) UNINSTALL=1; REEXEC_ARGS+=("$1"); shift ;;
    --provider) [[ $# -ge 2 && "${2:-}" != --* ]] || { echo "--provider requires a value" >&2; exit 1; }; PROVIDER="$2"; REEXEC_ARGS+=("$1" "$2"); shift 2 ;;
    --schedule) [[ $# -ge 2 && "${2:-}" != --* ]] || { echo "--schedule requires a value" >&2; exit 1; }; SCHEDULE="$2"; REEXEC_ARGS+=("$1" "$2"); shift 2 ;;
    --enable-self-observability)  SELF_OBS="on";  REEXEC_ARGS+=("$1"); shift ;;
    --disable-self-observability) SELF_OBS="off"; REEXEC_ARGS+=("$1"); shift ;;
    --upgrade) UPGRADE=1; shift ;;
    --migrate) MIGRATE=1; REEXEC_ARGS+=("$1"); shift ;;
    --help | -h)
      echo "bootstrap.sh — install / upgrade llm-wiki-memory (global MCP + hooks, hosted wiki, config)."
      echo "Usage: ./.llm-wiki-memory/src/bootstrap.sh [--commit-memory] [--template <name>] [--provider <p>] [--schedule hourly|off] [--enable-self-observability|--disable-self-observability] [--upgrade] [--migrate] [--uninstall]"
      echo "Shared team wiki? Do NOT clone the engine into the repo — from your install's src dir run: node scripts/mount-init.mjs <repo>"
      echo "Docs (any OS, via WebFetch): https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/ — README.md · AI-INSTALL-PROMPT.md · docs/shared-wikis.md"
      exit 0
      ;;
    *) echo "unknown arg: $1 (see --help)" >&2; exit 1 ;;
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
  # LWM_BOOTSTRAP_SKIP_SCHED_OS lets the e2e reverse the fs surfaces without
  # touching the real user's launchd/crontab (default: unset = tear down).
  if [[ -z "${LWM_BOOTSTRAP_SKIP_SCHED_OS:-}" ]]; then
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
  fi
  node "$SRC_DIR/scripts/bootstrap/unregister-global.mjs" "$HOME" >&2 || true
  node "$SRC_DIR/scripts/uninstall.mjs" "$WORKSPACE_DIR" || die "uninstall helper failed."
  log "Uninstall complete (global MCP + hooks removed from \$HOME; memory data left intact)."
  exit 0
fi

# --- prereqs ---
command -v node >/dev/null 2>&1 || die "node is required (>=20)."
command -v git  >/dev/null 2>&1 || die "git is required."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "node >=20 required (found $(node -v))."

# --- upgrade (deterministic: fetch + ff-merge, then re-exec the fresh install + migrate) ---
# One command replaces the prose runbook: pull the new engine, then re-run the
# freshly-merged bootstrap (idempotent re-wire) with --migrate (idempotent data
# migrations). bash re-executes rather than sourcing the just-changed script.
if [[ "$UPGRADE" -eq 1 ]]; then
  log "Upgrade: fetching origin + fast-forward-merging into $SRC_DIR ..."
  git -C "$SRC_DIR" fetch origin || die "git fetch failed."
  if ! git -C "$SRC_DIR" merge --ff-only origin/main 2>/dev/null; then
    # A cloud-sync daemon strips the exec bit (100755→100644) and blocks --ff-only.
    git -C "$SRC_DIR" config core.fileMode false
    git -C "$SRC_DIR" checkout -- . 2>/dev/null || true
    git -C "$SRC_DIR" merge --ff-only origin/main ||
      die "fast-forward merge failed (content diverged? resolve $SRC_DIR by hand)."
  fi
  log "Upgrade: re-running the freshly-merged bootstrap (idempotent re-wire + migrations) ..."
  # bash 3.2 (macOS default) + `set -u`: expanding an EMPTY array as "${a[@]}" is an
  # unbound-variable error, so guard it — bare `--upgrade` yields an empty REEXEC_ARGS.
  exec bash "$SRC_DIR/bootstrap.sh" --migrate ${REEXEC_ARGS[@]+"${REEXEC_ARGS[@]}"}
fi

# --- install deps ---
# LWM_BOOTSTRAP_SKIP_NPM lets the install e2e drive the real script against a
# pre-populated node_modules without a network install (default: unset = install).
if [[ -z "${LWM_BOOTSTRAP_SKIP_NPM:-}" ]]; then
  log "Installing dependencies in $SRC_DIR ..."
  ( cd "$SRC_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1 ) || die "npm install failed in $SRC_DIR."
fi

# Confirm the skill CLI resolves.
if ! ( cd "$SRC_DIR" && node -e "require('module').createRequire(process.cwd()+'/package.json').resolve('@ctxr/skill-llm-wiki/package.json')" >/dev/null 2>&1 ); then
  die "@ctxr/skill-llm-wiki is not resolvable. Ensure it is installable from your registry (or vendor it)."
fi

# --- detect provider ---
# The priority ladder (claude/codex CLI → API keys → base-url → ollama probe →
# mock fallback) lives in scripts/bootstrap/detect-provider.mjs (unit-tested).
# An explicit --provider ($PROVIDER already set) short-circuits it. Output is
# "<provider>\t<baseUrlHint>".
DETECT="$(node "$SRC_DIR/scripts/bootstrap/detect-provider.mjs" "$PROVIDER")"
PROVIDER="${DETECT%%$'\t'*}"
BASE_URL_HINT="${DETECT#*$'\t'}"
log "LLM provider: $PROVIDER"
if [[ "$PROVIDER" == "mock" ]]; then
  printf '\033[1;33m[llm-wiki-memory] WARN:\033[0m No LLM provider detected (no claude/codex CLI on PATH; no ANTHROPIC_API_KEY/OPENAI_API_KEY/MEMORY_LLM_BASE_URL set; no ollama at http://localhost:11434). Defaulting to MEMORY_LLM_PROVIDER=mock. Consolidate'\''s LLM passes will be skipped. Set MEMORY_LLM_PROVIDER (or one of those env vars) in %s to enable.\n' "$DATA_DIR/settings/.env" >&2
fi

# --- settings/.env (create-only; one JS path, no BSD/GNU sed fork) ---
node "$SRC_DIR/scripts/bootstrap/setup-env.mjs" \
  "$DATA_DIR" "$SRC_DIR/templates/env.example" "$PROVIDER" "$BASE_URL_HINT" >&2

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

# --- MCP server + Claude Code hooks: GLOBAL (user-home) registration ---
# Registered ONCE in the user's HOME (not per repo) so a shared repo carries no
# client config. Present clients (Cursor / Codex / Claude Desktop) are registered
# globally too; a customized/wrapped command (mandated security shim) survives.
node "$SRC_DIR/scripts/bootstrap/register-global.mjs" "$HOME" >&2
# Migrate a pre-global install: remove stale per-repo client config (home-aware —
# a brain's global hooks are never mistaken for per-repo ones).
node "$SRC_DIR/scripts/bootstrap/unregister-global.mjs" --migrate "$WORKSPACE_DIR" "$HOME" >&2
log "Registered the MCP server + hooks globally in \$HOME (no per-repo client config)."

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

# --- wiki git repo (auto-commit) ---
# Private brain gets its own wiki/.git so the auto-commit layer commits to it. A
# SHARED wiki (layout declares `ownership: repo`) is never given a repo — the human
# commits it via the host repo, and gitUsable() refuses it at runtime. Detection
# uses the SAME engine predicate as gitUsable (merges layout.local.yaml; parses YAML).
WIKI_IS_SHARED="$(node "$SRC_DIR/scripts/bootstrap/shared-wiki.mjs" "$DATA_DIR/wiki")"

if [[ "$WIKI_IS_SHARED" -eq 1 ]]; then
  # Shared wiki: never git-init a standalone wiki/.git (the host repo tracks it; the
  # engine never commits it). The gitignore block below tracks it either way.
  :
elif [[ "$COMMIT_MEMORY" -eq 0 && -d "$DATA_DIR/wiki" && ! -e "$DATA_DIR/wiki/.git" ]]; then
  if git -C "$DATA_DIR/wiki" init -q 2>/dev/null; then
    log "Initialised git repo at $DATA_DIR/wiki (auto-commit history; disable via settings wiki.autoCommit)"
  else
    log "WARNING: could not git init $DATA_DIR/wiki; wiki auto-commit stays a no-op"
  fi
fi

# A stray wiki/.git on a shared/committed wiki breaks host-repo tracking (embedded
# gitlink) and is what the guard refuses — remove it (wiki DATA preserved).
if [[ ("$COMMIT_MEMORY" -eq 1 || "$WIKI_IS_SHARED" -eq 1) && -e "$DATA_DIR/wiki/.git" ]]; then
  rm -rf "$DATA_DIR/wiki/.git"
  log "Removed standalone $DATA_DIR/wiki/.git so the workspace repo tracks the shared wiki (standalone auto-commit history dropped; wiki data preserved)."
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

# --- data migrations (idempotent; run on --migrate / --upgrade) ---
# migrate-identity restamps legacy basename project_module to the deterministic
# git/file identity; a no-op on a fresh or already-migrated wiki.
if [[ "$MIGRATE" -eq 1 ]]; then
  log "Running data migrations (idempotent) ..."
  ( cd "$SRC_DIR" && MEMORY_DATA_DIR="$DATA_DIR" node scripts/cli.mjs migrate-identity ) ||
    log "WARNING: migrate-identity reported an issue (continuing)."
fi

# --- gitignore (marker-fenced block, mechanically reversible by uninstall) ---
GITIGNORE="$WORKSPACE_DIR/.gitignore"
GI_BEGIN="# >>> llm-wiki-memory >>>"
GI_END="# <<< llm-wiki-memory <<<"
if [[ "$COMMIT_MEMORY" -eq 1 || "$WIKI_IS_SHARED" -eq 1 ]]; then
  # Git-TRACK the wiki content (the HUMAN commits it; the engine never runs git on
  # a shared wiki); ignore only derived/secret/local paths. A SHARED wiki
  # (WIKI_IS_SHARED — its layout declares an `ownership: repo` category) ALWAYS
  # takes this branch, even on a bare re-run WITHOUT --commit-memory, so a
  # bootstrap re-run can NEVER silently un-track a shared team wiki. state/ holds
  # locks + journals + consolidate/embed-gc bookkeeping; wiki index.md files are
  # DERIVED (regenerated on init/clone-adopt), so a clone stays free of them —
  # which is what makes init's missing-index recovery fire.
  printf '%s\n' \
    "/.llm-wiki-memory/src/node_modules" \
    "/.llm-wiki-memory/index" \
    "/.llm-wiki-memory/settings/.env" \
    "/.llm-wiki-memory/settings/.env.bak" \
    "/.llm-wiki-memory/state" \
    "/.llm-wiki-memory/monitoring" \
    "/.llm-wiki-memory/settings/self-observability.enabled" \
    "/.llm-wiki-memory/wiki/**/index.md" |
    node "$SRC_DIR/scripts/merge-marker.mjs" "$GITIGNORE" "$GI_BEGIN" "$GI_END" -
  log "Git-tracking wiki content (you commit it; the engine never does); ignoring node_modules / index / secrets only (fenced block)."
  MOUNT_OUT="$(node "$SRC_DIR/scripts/mount-init.mjs" "$WORKSPACE_DIR" 2>&1 || true)"
  if printf '%s' "$MOUNT_OUT" | grep -q '"skipped": "no-shared-categories"'; then
    :
  else
    log "Mount primitives provisioned (negated .gitignore, personal git, sync-embeddings hook)."
    printf '%s' "$MOUNT_OUT" | grep -q '"ok": false' && log "$MOUNT_OUT"
  fi
else
  printf '/.llm-wiki-memory\n' |
    node "$SRC_DIR/scripts/merge-marker.mjs" "$GITIGNORE" "$GI_BEGIN" "$GI_END" -
  log "Ignoring the whole /.llm-wiki-memory tree in a fenced block (use --commit-memory to git-track it as a shared wiki)."
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

# The plist/wrapper/cron-line text + the crontab idempotency filter are built by
# scripts/bootstrap/render-schedule.mjs (byte-tested; ws_hash stays a POSIX cksum
# here so install↔uninstall derive the same ids). This shell owns only the OS
# calls (launchctl/crontab/file writes), guarded by LWM_BOOTSTRAP_SKIP_SCHED_OS so
# the install e2e can run without mutating the real launchd/crontab.
RENDER_SCHED="$SRC_DIR/scripts/bootstrap/render-schedule.mjs"

schedule_job() {
  local action="$1"
  local node_bin cli_path cron_path ws_hash ids label plist tag wrapper
  node_bin="$(command -v node || echo node)"
  cli_path="$SRC_DIR/scripts/cli.mjs"
  cron_path="$("$node_bin" "$SRC_DIR/scripts/lib/cron-path.mjs" 2>/dev/null || true)"
  [[ -n "$cron_path" ]] || cron_path="$PATH"
  ws_hash="$(printf '%s' "$WORKSPACE_DIR" | cksum | awk '{print $1}')"
  ids="$("$node_bin" "$RENDER_SCHED" ids "$ws_hash" "$WORKSPACE_DIR" "$DATA_DIR" "$HOME")"
  IFS=$'\t' read -r label plist tag wrapper <<<"$ids"

  if [[ "$(uname)" == "Darwin" ]]; then
    command -v launchctl >/dev/null 2>&1 ||
      { log "WARNING: launchctl not available; skipping schedule setup."; return 0; }
    [[ -n "${LWM_BOOTSTRAP_SKIP_SCHED_OS:-}" ]] || launchctl unload "$plist" >/dev/null 2>&1 || true
    if [[ "$action" == "off" ]]; then
      rm -f "$plist"
      log "Removed scheduled compile job ($label)."
      return 0
    fi
    mkdir -p "$HOME/Library/LaunchAgents"
    "$node_bin" "$RENDER_SCHED" plist "$label" "$DATA_DIR" "$node_bin" "$cli_path" "$cron_path" >"$plist"
    [[ -n "${LWM_BOOTSTRAP_SKIP_SCHED_OS:-}" ]] ||
      launchctl load "$plist" >/dev/null 2>&1 || log "WARNING: launchctl load failed for $plist."
    log "Installed hourly cron-job (launchd, every hour at :00): $plist"
  else
    command -v crontab >/dev/null 2>&1 ||
      { log "WARNING: crontab not available; skipping schedule setup."; return 0; }
    # Capture the existing crontab with `|| true` BEFORE the pipe: a fresh
    # machine's `crontab -l` exits 1 ("no crontab"), which under `set -o pipefail`
    # would otherwise fail the whole pipe and fire a spurious WARNING even though
    # `crontab -` succeeded.
    local current
    if [[ "$action" == "off" ]]; then
      if [[ -z "${LWM_BOOTSTRAP_SKIP_SCHED_OS:-}" ]]; then
        current="$(crontab -l 2>/dev/null || true)"
        printf '%s' "$current" | "$node_bin" "$RENDER_SCHED" filter-crontab "$tag" | crontab - 2>/dev/null || true
      fi
      rm -f "$wrapper"
      log "Removed scheduled compile job (crontab) + wrapper."
      return 0
    fi
    mkdir -p "$(dirname "$wrapper")"
    "$node_bin" "$RENDER_SCHED" wrapper "$DATA_DIR" "$cron_path" "$node_bin" "$cli_path" >"$wrapper"
    chmod +x "$wrapper"
    local line
    line="$("$node_bin" "$RENDER_SCHED" cron-line "$wrapper" "$tag")"
    if [[ -z "${LWM_BOOTSTRAP_SKIP_SCHED_OS:-}" ]]; then
      current="$(crontab -l 2>/dev/null || true)"
      printf '%s' "$current" | "$node_bin" "$RENDER_SCHED" filter-crontab "$tag" "$line" | crontab - 2>/dev/null ||
        log "WARNING: failed to update crontab."
    fi
    log "Installed hourly cron-job (crontab, every hour at :00) via wrapper $wrapper tagged: $tag"
  fi
}

case "$SCHEDULE" in
  "") : ;;
  hourly | daily) schedule_job "$SCHEDULE" ;; # 'daily' is a deprecated alias; the job fires HOURLY either way
  off) schedule_job off ;;
  *) log "WARNING: unknown --schedule value '$SCHEDULE' (expected hourly|off; 'daily' is a deprecated alias for hourly); skipping." ;;
esac

log "Done."
log "Claude Code: restart so it picks up the global ~/.claude.json server + ~/.claude/settings.json hooks."
log "A client we didn't detect (no config dir yet)? Register it globally with:"
log "  ./.llm-wiki-memory/src/scripts/mcp-config.sh <client>"
log "Memory wiki: $DATA_DIR/wiki"

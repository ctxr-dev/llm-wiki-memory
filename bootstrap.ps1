# llm-wiki-memory bootstrap for Windows (PowerShell). Native equivalent of
# bootstrap.sh: installs the local LLM-wiki memory system into a target project —
# global MCP + hooks, the hosted wiki, config. No Docker, no external service.
# Idempotent. The heavy logic lives in the SAME cross-platform Node step modules
# bootstrap.sh calls (scripts/bootstrap/*.mjs, scripts/*.mjs); this script is the
# Windows orchestrator + path handling + Task Scheduler.
#
# Expected layout: this script lives at <workspace>\.llm-wiki-memory\src\bootstrap.ps1
#
# Usage:
#   pwsh -File .\.llm-wiki-memory\src\bootstrap.ps1 [-CommitMemory] [-Template <name>]
#        [-Provider <name>] [-Schedule hourly|off]
#        [-EnableSelfObservability] [-DisableSelfObservability] [-Migrate] [-Uninstall]
[CmdletBinding()]
param(
  [switch]$CommitMemory,
  [string]$Template = "default",
  [string]$Provider = "",
  [string]$Schedule = "",
  [switch]$EnableSelfObservability,
  [switch]$DisableSelfObservability,
  [switch]$Migrate,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Log($msg) { Write-Host "[llm-wiki-memory] $msg" -ForegroundColor Cyan }
function Die($msg) { Write-Host "[llm-wiki-memory] ERROR: $msg" -ForegroundColor Red; exit 1 }

# --- resolve locations ---
$SrcDir = $PSScriptRoot
# Workspace = two levels up when installed at <ws>\.llm-wiki-memory\src, else the parent.
$parent = Split-Path -Parent $SrcDir
if ((Split-Path -Leaf $SrcDir) -eq "src" -and (Split-Path -Leaf $parent) -eq ".llm-wiki-memory") {
  $WorkspaceDir = (Resolve-Path (Join-Path $SrcDir "..\..")).Path
} else {
  $WorkspaceDir = (Resolve-Path (Join-Path $SrcDir "..")).Path
}
$DataDir = Join-Path $WorkspaceDir ".llm-wiki-memory"
# os.homedir() on Windows reads USERPROFILE; the global-register/wire steps use it.
$HomeDir = $env:USERPROFILE
if (-not $HomeDir) { $HomeDir = $HOME }

function NodeStep([string]$rel, [string[]]$stepArgs) {
  # Run a Node step module by its src-relative path; throw on non-zero exit.
  $script = Join-Path $SrcDir $rel
  & node $script @stepArgs
  if ($LASTEXITCODE -ne 0) { Die "step failed: node $rel (exit $LASTEXITCODE)" }
}

function NodeOut([string]$rel, [string[]]$stepArgs) {
  # Run a Node step and return its single-line stdout (trimmed); Die on non-zero
  # exit. "$out" stringifies null/empty safely so .Trim() can't crash StrictMode.
  $script = Join-Path $SrcDir $rel
  $out = & node $script @stepArgs
  if ($LASTEXITCODE -ne 0) { Die "step failed: node $rel (exit $LASTEXITCODE)" }
  return "$out".Trim()
}

# --- uninstall (thin; fs reversals live in scripts/uninstall.mjs) ---
if ($Uninstall) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "node is required to uninstall." }
  Log "Uninstalling llm-wiki-memory from $WorkspaceDir (memory data is left intact) ..."
  # LWM_BOOTSTRAP_SKIP_SCHED_OS lets the e2e reverse the fs surfaces without
  # touching the real user's Task Scheduler (default: unset = tear down).
  if (-not $env:LWM_BOOTSTRAP_SKIP_SCHED_OS) {
    $wsHash = & node (Join-Path $SrcDir "scripts\bootstrap\ws-hash.mjs") $WorkspaceDir
    $ids = (& node (Join-Path $SrcDir "scripts\bootstrap\render-schedule.mjs") "win-ids" $wsHash $DataDir) -split "`t"
    $taskName = $ids[0]
    # Guard the delete on a real name: a failed derivation must not schtasks /tn ""
    # (a no-op that leaves the real task orphaned) — warn and let a re-run clean it.
    if ($taskName) {
      & schtasks /delete /tn $taskName /f *> $null
      Log "Removed scheduled task if present ($taskName)."
    } else {
      Log "WARNING: could not derive the scheduled-task name; skipped its teardown (re-run --uninstall if a task lingers)."
    }
  }
  & node (Join-Path $SrcDir "scripts\bootstrap\unregister-global.mjs") $HomeDir 2>&1 | Write-Host
  & node (Join-Path $SrcDir "scripts\uninstall.mjs") $WorkspaceDir
  if ($LASTEXITCODE -ne 0) { Die "uninstall helper failed." }
  Log "Uninstall complete (global MCP + hooks removed from `$HOME; memory data left intact)."
  exit 0
}

# --- prereqs ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "node is required (>=20)." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die "git is required." }
$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { Die "node >=20 required (found $(& node -v))." }

# --- install deps ---
if (-not $env:LWM_BOOTSTRAP_SKIP_NPM) {
  Log "Installing dependencies in $SrcDir ..."
  Push-Location $SrcDir
  try { & npm install --no-audit --no-fund | Out-Null }
  finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Die "npm install failed in $SrcDir." }
}

# Confirm the skill CLI resolves.
Push-Location $SrcDir
try {
  & node -e "require('module').createRequire(process.cwd()+'/package.json').resolve('@ctxr/skill-llm-wiki/package.json')" | Out-Null
} finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Die "@ctxr/skill-llm-wiki is not resolvable. Ensure it is installable from your registry (or vendor it)." }

# --- detect provider (same ladder as bootstrap.sh, via the tested node module) ---
$detect = NodeOut "scripts\bootstrap\detect-provider.mjs" @($Provider)
$detectParts = $detect -split "`t"
$Provider = $detectParts[0]
$baseUrlHint = if ($detectParts.Count -gt 1) { $detectParts[1] } else { "" }
Log "LLM provider: $Provider"
if ($Provider -eq "mock") {
  Write-Host "[llm-wiki-memory] WARN: No LLM provider detected. Defaulting to MEMORY_LLM_PROVIDER=mock. Set MEMORY_LLM_PROVIDER (or a provider env var) in $DataDir\settings\.env to enable." -ForegroundColor Yellow
}

# --- settings/.env (create-only; one JS path) ---
NodeStep "scripts\bootstrap\setup-env.mjs" @($DataDir, (Join-Path $SrcDir "templates\env.example"), $Provider, $baseUrlHint)

# --- settings/settings.yaml (+ auto-migration) ---
NodeStep "scripts\migrate-settings.mjs" @($DataDir)
$settingsYaml = Join-Path $DataDir "settings\settings.yaml"
if (-not (Test-Path $settingsYaml)) {
  Copy-Item (Join-Path $SrcDir "templates\settings.yaml") $settingsYaml
  Log "Wrote $settingsYaml"
} else {
  Log "Kept existing $settingsYaml"
}

# --- MCP server + hooks: GLOBAL (user-home) registration ---
NodeStep "scripts\bootstrap\register-global.mjs" @($HomeDir)
NodeStep "scripts\bootstrap\unregister-global.mjs" @("--migrate", $WorkspaceDir, $HomeDir)
Log "Registered the MCP server + hooks globally in `$HOME (no per-repo client config)."

# --- materialise + validate the wiki ---
$env:MEMORY_DATA_DIR = $DataDir
Log "Initialising the hosted wiki (template: $Template) ..."
Push-Location $SrcDir
try { & node (Join-Path $SrcDir "scripts\cli.mjs") init --template $Template | Out-Null }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Die "wiki init failed." }

Push-Location $SrcDir
try { $validateOut = (& node (Join-Path $SrcDir "scripts\cli.mjs") validate 2>&1 | Out-String) }
finally { Pop-Location }
if ($validateOut -match "0 error") { Log "Wiki validation passed." }
else { Log "WARNING: wiki validation reported issues (continuing anyway):"; Log $validateOut }

# --- wiki git repo (auto-commit); a SHARED wiki is never given a standalone repo ---
$wikiDir = Join-Path $DataDir "wiki"
$wikiIsShared = NodeOut "scripts\bootstrap\shared-wiki.mjs" @($wikiDir)
$wikiGit = Join-Path $wikiDir ".git"
if ($wikiIsShared -eq "1") {
  # Shared: never git-init a standalone wiki\.git; the host repo tracks it.
} elseif (-not $CommitMemory -and (Test-Path $wikiDir) -and -not (Test-Path $wikiGit)) {
  & git -C $wikiDir init -q 2>&1 | Out-Null
  if (Test-Path $wikiGit) { Log "Initialised git repo at $wikiDir (auto-commit history)." }
  else { Log "WARNING: could not git init $wikiDir; wiki auto-commit stays a no-op" }
}
if (($CommitMemory -or $wikiIsShared -eq "1") -and (Test-Path $wikiGit)) {
  Remove-Item -Recurse -Force $wikiGit
  Log "Removed standalone $wikiGit so the workspace repo tracks the shared wiki (data preserved)."
}

# --- wire memory rules/skills + AGENTS.md/CLAUDE.md as @-pointers (reference-only) ---
$selfObsSentinel = Join-Path $DataDir "settings\self-observability.enabled"
if ($EnableSelfObservability) { New-Item -ItemType File -Force -Path $selfObsSentinel | Out-Null }
elseif ($DisableSelfObservability) { Remove-Item -Force -ErrorAction SilentlyContinue $selfObsSentinel }
$selfObsEnabled = if (Test-Path $selfObsSentinel) { "1" } else { "0" }
NodeStep "scripts\wire-memory-surfaces.mjs" @($SrcDir, $WorkspaceDir, $HomeDir, $selfObsEnabled)
Log "Wired memory rules/skills as @-pointers and AGENTS.md/CLAUDE.md @-includes -> `$HOME\.llm-wiki-memory\src."

# --- data migrations (idempotent; run on -Migrate) ---
if ($Migrate) {
  Log "Running data migrations (idempotent) ..."
  Push-Location $SrcDir
  try { & node (Join-Path $SrcDir "scripts\cli.mjs") migrate-identity }
  finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Log "WARNING: migrate-identity reported an issue (continuing)." }
}

# --- gitignore (marker-fenced block) + mount primitives ---
$gitignore = Join-Path $WorkspaceDir ".gitignore"
$giBegin = "# >>> llm-wiki-memory >>>"
$giEnd = "# <<< llm-wiki-memory <<<"
$mergeMarker = Join-Path $SrcDir "scripts\merge-marker.mjs"
if ($CommitMemory -or $wikiIsShared -eq "1") {
  $lines = @(
    "/.llm-wiki-memory/src/node_modules",
    "/.llm-wiki-memory/index",
    "/.llm-wiki-memory/settings/.env",
    "/.llm-wiki-memory/settings/.env.bak",
    "/.llm-wiki-memory/state",
    "/.llm-wiki-memory/monitoring",
    "/.llm-wiki-memory/settings/self-observability.enabled",
    "/.llm-wiki-memory/wiki/**/index.md"
  ) -join "`n"
  $lines | & node $mergeMarker $gitignore $giBegin $giEnd "-"
  Log "Git-tracking wiki content (you commit it; the engine never does); ignoring node_modules / index / secrets only."
  $mountOut = (& node (Join-Path $SrcDir "scripts\mount-init.mjs") $WorkspaceDir 2>&1 | Out-String)
  if ($mountOut -notmatch '"skipped": "no-shared-categories"') {
    Log "Mount primitives provisioned (negated .gitignore, personal git, sync-embeddings hook)."
    if ($mountOut -match '"ok": false') { Log $mountOut }
  }
} else {
  "/.llm-wiki-memory" | & node $mergeMarker $gitignore $giBegin $giEnd "-"
  Log "Ignoring the whole /.llm-wiki-memory tree in a fenced block (use -CommitMemory to git-track it as a shared wiki)."
}

# --- optional scheduled maintenance task (hourly, via Task Scheduler) ---
function Set-ScheduleTask([string]$action) {
  $wsHash = NodeOut "scripts\bootstrap\ws-hash.mjs" @($WorkspaceDir)
  $ids = (NodeOut "scripts\bootstrap\render-schedule.mjs" @("win-ids", $wsHash, $DataDir)) -split "`t"
  $taskName = $ids[0]
  $wrapperPath = $ids[1]
  if ($action -eq "off") {
    if (-not $env:LWM_BOOTSTRAP_SKIP_SCHED_OS) { & schtasks /delete /tn $taskName /f *> $null }
    Remove-Item -Force -ErrorAction SilentlyContinue $wrapperPath
    Log "Removed scheduled task ($taskName)."
    return
  }
  $nodeBin = (Get-Command node).Source
  $cliPath = Join-Path $SrcDir "scripts\cli.mjs"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $wrapperPath) | Out-Null
  # Pipe node's stdout STRAIGHT to the file so each \r\n line is written verbatim:
  # capturing into a variable arrays-ifies the multi-line output, and -NoNewline
  # would then concatenate the lines into one unrunnable command. oem encoding is
  # what cmd.exe reads (ascii mangles a non-ASCII install path to '?').
  & node (Join-Path $SrcDir "scripts\bootstrap\render-schedule.mjs") "cmd-wrapper" $DataDir $nodeBin $cliPath |
    Set-Content -Path $wrapperPath -Encoding oem
  if ($LASTEXITCODE -ne 0) { Die "failed to render the schedule wrapper." }
  if (-not $env:LWM_BOOTSTRAP_SKIP_SCHED_OS) {
    & schtasks /create /sc hourly /mo 1 /tn $taskName /tr "`"$wrapperPath`"" /f *> $null
    if ($LASTEXITCODE -ne 0) { Log "WARNING: schtasks /create failed for $taskName." }
  }
  Log "Installed hourly maintenance task (Task Scheduler): $taskName"
}

switch ($Schedule) {
  "" { }
  "hourly" { Set-ScheduleTask "hourly" }
  "daily" { Set-ScheduleTask "hourly" } # deprecated alias; installs the SAME hourly task
  "off" { Set-ScheduleTask "off" }
  default { Log "WARNING: unknown -Schedule value '$Schedule' (expected hourly|off); skipping." }
}

Log "Done."
Log "Claude Code: restart so it picks up the global ~\.claude.json server + ~\.claude\settings.json hooks."
Log "Memory wiki: $wikiDir"

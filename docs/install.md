# Install (full guide)

The [README](../README.md#install) has the quickstart (one-line agent prompt + the macOS/Linux/Windows commands). This page covers what bootstrap does, updating, non-Claude clients, and shared team wikis.

The full one-shot procedure an agent follows lives in [`../AI-INSTALL-PROMPT.md`](../AI-INSTALL-PROMPT.md) — it covers both a fresh install and an update.

## Windows prerequisites

- [Git for Windows](https://git-scm.com/downloads/win). You already need it to `git clone`, and Claude Code runs the lifecycle hooks (and the git embedding-refresh hooks) through its bundled Git Bash — so capture/recall and index-warming work out of the box.
- **LLM provider:** on Windows, set an API key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) or a base URL (e.g. a local Ollama) — these are fetch-based and fully supported. The subscription-auth CLI providers (`claude` / `codex` / `cursor-agent`) are **not** used on Windows (they are npm `.cmd` shims that can't be spawned with the distillation prompt), so bootstrap won't auto-select them there.

The bootstrap is **idempotent** — re-running preserves your edits to `.env` and your rule files.

## What bootstrap does (8 steps)

1. Installs dependencies in `./.llm-wiki-memory/src`.
2. Auto-detects the LLM provider: `claude` CLI → `codex` CLI → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → `MEMORY_LLM_BASE_URL` → ollama at `:11434` → `mock` (with a stderr warning).
3. Writes `./.llm-wiki-memory/settings/.env` (preserves your edits on re-run).
4. Registers the stdio server + Claude Code hooks GLOBALLY in your home config (`~/.claude.json` + `~/.claude/settings.json`; Cursor `~/.cursor/mcp.json`, Codex `~/.codex/config.toml`, Claude Desktop — whichever you have) — never per-repo, so a shared repo carries no client config. A customized/wrapped command (e.g. a mandated security shim) is preserved; a re-bootstrap migrates a pre-global install by removing its stale per-repo `.mcp.json`/`.claude/settings.json`/`.agents/*`.
5. Wires the memory rules/skills. **Private brain:** `llm-wiki-memory-<name>.md` @-pointer files (referencing `~/.llm-wiki-memory/src` — no copies, no symlinks) into `.agents/rules/`, `.claude/skills/`, `.claude/rules/`, `.cursor/rules/`, plus one marker-fenced @-include block in `AGENTS.md`/`CLAUDE.md` (recorded in an install-manifest). **Shared (`--template repo`) mount:** ZERO machine-dependent files — only ONE machine-independent remote-read block in `AGENTS.md`/`CLAUDE.md` pointing at the discipline on `raw.githubusercontent.com/.../main/...`.
6. Materialises the hosted wiki at `./.llm-wiki-memory/wiki` (with the layout template that declares `consolidate: refine | none` per category) and validates it.
7. Adds `/.llm-wiki-memory` to `.gitignore` (`--commit-memory` git-tracks the wiki in the project instead — you commit it; the engine never does).
8. Optionally installs the hourly cron (`compile` + an opt-in `consolidate`) as a scheduled job — launchd on macOS, a crontab wrapper on Linux, a Task Scheduler task on Windows (`--schedule hourly` / `-Schedule hourly`; `daily` is a deprecated alias for the same hourly job); consolidation runs only when `consolidate.enabled: true` (default off).

## Update an existing install

```bash
git -C .llm-wiki-memory/src fetch origin
# Runbooks you have NOT applied yet — READ THESE FIRST, oldest → newest:
git -C .llm-wiki-memory/src diff --name-only HEAD origin/main -- docs/releases | grep 'update-prompt\.md$' | sort
git -C .llm-wiki-memory/src merge --ff-only origin/main
( cd .llm-wiki-memory/src && npm install --no-audit --no-fund )
./.llm-wiki-memory/src/bootstrap.sh   # idempotent; runbooks may add one-shot steps + verification
```

On **Windows**, the last line is `./.llm-wiki-memory/src/bootstrap.ps1` (the git/`npm install` steps above are identical in PowerShell).

**Upgrading a shared team wiki?** Nothing special needed — a shared wiki is auto-detected on any `bootstrap.sh` re-run and stays git-tracked (a bare re-run does **not** revert it to private; the engine still never runs git on it). See [shared-wikis.md](shared-wikis.md#upgrading-a-shared-install).

## Register with a non-Claude client

Bootstrap already auto-registers every client it detects, **globally** in your home config (never per-repo). Use these only for a client bootstrap didn't detect — each prints a global snippet to paste:

```bash
./.llm-wiki-memory/src/scripts/mcp-config.sh cursor          # ~/.cursor/mcp.json
./.llm-wiki-memory/src/scripts/mcp-config.sh codex           # ~/.codex/config.toml
./.llm-wiki-memory/src/scripts/mcp-config.sh claude-desktop  # claude_desktop_config.json (global)
./.llm-wiki-memory/src/scripts/mcp-config.sh all
```

## Install as a shared team wiki

The engine stays a single clone in `$HOME` — it is **never** cloned into the project. From inside the repo you want the team to share, run the home engine's `mount-init`:

```bash
node ~/.llm-wiki-memory/src/scripts/mount-init.mjs "$PWD"
```

One idempotent command sets up a fresh shared wiki *or* adopts one on clone: it seeds/adopts a shared `knowledge/` tree, un-ignores it so **you** commit it into the project (teammates inherit it on clone), keeps your caches / indexes / personal notes out of git, installs git hooks that warm the shared embeddings on pull, and writes one machine-independent remote-read block into `AGENTS.md`/`CLAUDE.md`. The engine never runs git on a shared wiki. The repo carries **no engine clone and no machine-dependent config** — MCP + hooks are global (`bootstrap.sh`). Full guide → [shared-wikis.md](shared-wikis.md).

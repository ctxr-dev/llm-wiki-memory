# Install (full guide)

The [README](../README.md#install) has the quickstart (one-line agent prompt + the macOS/Linux/Windows commands). This page covers what bootstrap does, updating, non-Claude clients, and shared team wikis.

The full one-shot procedure an agent follows lives in [`../AI-INSTALL-PROMPT.md`](../AI-INSTALL-PROMPT.md) — it covers both a fresh install and an update.

## Install ONCE, in your home directory

The engine is installed **once per machine, at `$HOME`** — and bootstrap enforces
that. A home install registers the MCP server + hooks globally and wires the rules,
skills and discipline into your user-level config, so memory works in **every**
directory on the machine. No project needs an install of its own, and nothing is
ever written into your repositories.

Running bootstrap anywhere else is refused, with the reason and the fix:

| Where you run it | Outcome |
|---|---|
| `$HOME` | installs / upgrades the one brain |
| a repo, no brain at `$HOME` yet | **refused** — install the home brain first |
| a repo, with `--template repo` and a home brain | allowed: gives the repo a shared **team wiki** (committed wiki data only; still no files outside `.llm-wiki-memory/`) |
| a repo, without `--template repo` | **refused** — your home brain already serves that repo; a second private brain would only duplicate its wiring into your project tree |
| anywhere that already has a wiki | proceeds — a re-run is an upgrade |

A refusal is inert: it happens before anything is written, so the directory is left
exactly as it was.

## Windows prerequisites

- [Git for Windows](https://git-scm.com/downloads/win). You already need it to `git clone`, and Claude Code runs the lifecycle hooks (and the git embedding-refresh hooks) through its bundled Git Bash — so capture/recall and index-warming work out of the box.
- **LLM provider:** on Windows, set an API key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) or a base URL (e.g. a local Ollama) — these are fetch-based and fully supported. The subscription-auth CLI providers (`claude` / `codex` / `cursor-agent`) are **not** used on Windows (they are npm `.cmd` shims that can't be spawned with the distillation prompt), so bootstrap won't auto-select them there.

The bootstrap is **idempotent** — re-running preserves your edits to `.env` and your rule files.

## What bootstrap does (8 steps)

1. Installs dependencies in `./.llm-wiki-memory/src`.
2. Auto-detects the LLM provider: `claude` CLI → `codex` CLI → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → `MEMORY_LLM_BASE_URL` → ollama at `:11434` → `mock` (with a stderr warning).
3. Writes `./.llm-wiki-memory/settings/.env` (preserves your edits on re-run).
4. Registers the stdio server + Claude Code hooks GLOBALLY in your home config (`~/.claude.json` + `~/.claude/settings.json`; Cursor `~/.cursor/mcp.json`, Codex `~/.codex/config.toml`, Claude Desktop — whichever you have) — never per-repo, so a shared repo carries no client config. A customized/wrapped command (e.g. a mandated security shim) is preserved; a re-bootstrap migrates a pre-global install by removing its stale per-repo `.mcp.json`/`.claude/settings.json`/`.agents/*`.
5. Wires the memory rules/skills. **Private brain:** @-pointer artifacts referencing `~/.llm-wiki-memory/src` — no copies, no symlinks — into `.agents/rules/`, `.claude/skills/`, `.claude/rules/`, `.cursor/rules/`, plus one marker-fenced @-include block in `AGENTS.md`/`CLAUDE.md` (recorded in an install-manifest). The **shape is per-surface**: the rule surfaces get flat `llm-wiki-memory-<name>.md` files, while `.claude/skills/` gets `llm-wiki-memory-<name>/SKILL.md` **with `name` + `description` frontmatter** — Claude Code discovers a skill only as a directory containing `SKILL.md`, so a flat file there is invisible to it. A re-bootstrap migrates a pre-existing flat `.claude/skills/llm-wiki-memory-*.md` to the directory shape and removes the dead file. **Shared (`--template repo`) mount:** NOTHING outside the mount — no pointer files and no `AGENTS.md`/`CLAUDE.md` block. That one per-machine private-brain install already supplies the rules, skills and discipline in every directory on the box, so injecting a per-repo copy would only duplicate them into a teammate's repository. Anything an older engine wrote there is stripped on the next run (a doc that held only our block is deleted; one the team also wrote in keeps their content).
6. Materialises the hosted wiki at `./.llm-wiki-memory/wiki` (with the layout template that declares `consolidate: refine | none` per category) and validates it.
7. Adds `/.llm-wiki-memory` to `.gitignore` (`--commit-memory` git-tracks the wiki in the project instead — you commit it; the engine never does).
8. Optionally installs the hourly cron (`compile` + an opt-in `consolidate`) as a scheduled job — launchd on macOS, a crontab wrapper on Linux, a Task Scheduler task on Windows (`--schedule hourly` / `-Schedule hourly`; `daily` is a deprecated alias for the same hourly job); consolidation runs only when `consolidate.enabled: true` (default off).

## Update an existing install

```bash
git -C .llm-wiki-memory/src fetch origin
git -C .llm-wiki-memory/src merge --ff-only origin/main
( cd .llm-wiki-memory/src && npm install --no-audit --no-fund )
./.llm-wiki-memory/src/bootstrap.sh
```

That is the whole procedure, **however many versions behind you are**. Breaking
changes ship an idempotent, state-detecting *migration* rather than a runbook to
read: bootstrap runs each one, skips those your install has already settled, and
prints anything it decided on your behalf at a safe default. Nothing to read, in
order, ever.

Inspect or force them with `cli.mjs migrations --explain` / `--remigrate`.

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

One idempotent command sets up a fresh shared wiki *or* adopts one on clone: it seeds/adopts a shared `knowledge/` tree, un-ignores it so **you** commit it into the project (teammates inherit it on clone), keeps your caches / indexes / personal notes out of git, and installs git hooks that warm the shared embeddings on pull. It writes NOTHING outside the mount — no `AGENTS.md`/`CLAUDE.md` block, no pointers (the one per-machine install already covers every directory). The engine never runs git on a shared wiki. The repo carries **no engine clone and no machine-dependent config** — MCP + hooks are global (`bootstrap.sh`). Full guide → [shared-wikis.md](shared-wikis.md).

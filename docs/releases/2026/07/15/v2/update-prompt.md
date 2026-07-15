# llm-wiki-memory: MCP server + hooks are now GLOBAL-only (no per-repo client config) (2026-07-15 v2)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past the
**2026-07-15 v2** release. Apply the 2026-07-13 (v1 nested wire, v2 identity, v3
reference-only install), 2026-07-14 (required `target`), and 2026-07-15 v1 (shared-wiki
git-safety) releases first if you have not.

**WHO IS AFFECTED — everyone.** This is a breaking change to HOW the MCP server and
the Claude Code hooks are registered: they move from **per-repo** config files
(`<repo>/.mcp.json`, `<repo>/.claude/settings.json`, `<repo>/.agents/*`) to a single
**user-home global** registration. A shared team repo now carries NO machine-dependent
client config.

## 1. What's new

The engine no longer writes any MCP/hook client config into a project. Instead
`bootstrap.sh` registers the stdio server ONCE in each present client's user-home
global config — Claude Code `~/.claude.json` (+ hooks in `~/.claude/settings.json`),
Cursor `~/.cursor/mcp.json`, Codex `~/.codex/config.toml`, Claude Desktop's global
config — and a re-bootstrap MIGRATES an existing install by removing the stale per-repo
copies. A customized/wrapped command (e.g. a mandated `prompt_security` shim) is
preserved on the global entry. Why: so a shared team repo contains only the wiki data +
yaml — nothing per-machine — and so a single registration serves every project (the
server resolves scope from the caller-passed `scopes`, never its launch cwd).

## 2. Procedure

Run against the runtime clone at `~/.llm-wiki-memory/src`:

1. `git -C ~/.llm-wiki-memory/src fetch origin && git -C ~/.llm-wiki-memory/src merge --ff-only origin/main`
   (or `bash ~/.llm-wiki-memory/src/bootstrap.sh --upgrade`, which does this + re-wires).
2. Re-run bootstrap for each workspace you had installed:
   `bash ~/.llm-wiki-memory/src/bootstrap.sh` — this now (a) registers the server + hooks
   globally, and (b) removes the stale per-repo `.mcp.json` / `.claude/settings.json`
   hooks / `.agents/*` client bundle from that workspace (home-aware: a private brain's
   global hooks are never mistaken for per-repo ones).
3. **RESTART Claude Code** so it drops the old project-scope server and picks up the
   global `~/.claude.json` server + `~/.claude/settings.json` hooks. (Restart Cursor /
   Codex / Claude Desktop likewise.)

## 3. Decisions

- **A client we didn't auto-detect** (its config dir doesn't exist yet): we do NOT create
  it. Register it globally yourself with `~/.llm-wiki-memory/src/scripts/mcp-config.sh <client>`.
- **A wrapped/customized `command`** (prompt_security): preserved — re-registration never
  overwrites a differing command. Keep the wrapper on the global entry.
- **Duplicate registration during upgrade:** until you re-bootstrap a workspace, its old
  per-repo `.mcp.json` still registers the server at project scope alongside the new global
  one. Re-bootstrap (step 2) removes the per-repo copy; restart clears the duplicate.

## 4. Verification

- `grep -q llm-wiki-memory ~/.claude.json` → present (global server registered).
- `grep -q "scripts/hooks" ~/.claude/settings.json` → present (global hooks).
- In an upgraded workspace: `test ! -f <repo>/.mcp.json || ! grep -q llm-wiki-memory <repo>/.mcp.json`
  and `test ! -d <repo>/.agents/clients` → the per-repo client config is gone.
- A shared (`ownership: repo`) mount: `grep -rl '~/.llm-wiki-memory' <repo>` returns
  nothing under version control — the repo carries only wiki data + yaml.
- `bash ~/.llm-wiki-memory/src/bootstrap.sh --uninstall` removes the global server + hooks
  and leaves the wiki DATA intact.

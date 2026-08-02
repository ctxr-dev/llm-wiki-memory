# AI install / update prompt (canonical)

This file is the canonical procedure an AI coding agent follows to install or
update llm-wiki-memory in a project. Humans: the README's Install section has
the manual commands; this file is what the one-liner there points your agent
at. One prompt covers both a fresh install and an update of an existing one.

---

Install or update llm-wiki-memory (local LLM-wiki memory: capture/compile/recall
hooks, an hourly refinement cron, a local stdio MCP server; local embeddings,
no Docker) in this project. Follow these steps EXACTLY; do not improvise.

**Platform.** On macOS / Linux the installer is `bootstrap.sh`. On Windows use
the native `bootstrap.ps1` (PowerShell) instead — everywhere below that names
`bootstrap.sh`, substitute `bootstrap.ps1` and translate its flags to the
PowerShell form (`--commit-memory` → `-CommitMemory`, `--template repo` →
`-Template repo`, `--schedule hourly` → `-Schedule hourly`, `--uninstall` →
`-Uninstall`). The `git`/`npm install` steps are identical on all platforms.

1. Check whether `./.llm-wiki-memory/src` exists in this project.

2. **It does NOT exist → fresh install.** Run
   `git clone https://github.com/ctxr-dev/llm-wiki-memory ./.llm-wiki-memory/src`
   then `./.llm-wiki-memory/src/bootstrap.sh` (idempotent). Bootstrap
   auto-registers the MCP server (and, for Claude Code, the lifecycle hooks)
   GLOBALLY in your home config — never per-repo — for whichever clients are
   present (Claude Code `~/.claude.json` + `~/.claude/settings.json`, Cursor
   `~/.cursor/mcp.json`, Codex `~/.codex/config.toml`, Claude Desktop); a client
   whose config dir doesn't exist is skipped, not created. When it finishes: if
   the user is on Claude Code, tell them to restart the session. For any client
   bootstrap did NOT detect, show them
   `./.llm-wiki-memory/src/scripts/mcp-config.sh <their-client>`, which prints a
   global snippet to paste. Done — skip step 3.

   Two fresh-install choices you may need to make (see the sections at the end):
   - **Layout template.** The fresh install is always the private per-developer
     brain (`default` layout) — install that. A SHARED, repo-committed team wiki
     is NOT a fresh-install flag: it is a per-repo mount added afterward with the
     one home engine's `mount-init` (no engine clone in the repo). See "Per-repo
     shared memory" below.
   - **Install location.** The private brain normally lives in the user's home
     directory, not in a project. Moving the engine home is a user-manual
     one-time step (Phase A) — do NOT relocate it yourself; install into
     `./.llm-wiki-memory/src` of the current project unless the user directs
     otherwise.

3. **It DOES exist → update.** Breaking changes ship idempotent, state-detecting
   MIGRATIONS, not runbooks, so there is nothing to read in order and no
   how-far-behind branch. Procedure, whatever the local state:
   1. `git -C .llm-wiki-memory/src fetch origin`
   2. `git -C .llm-wiki-memory/src merge --ff-only origin/main`
      (not a clean fast-forward → STOP and surface the divergence; never force-merge)
   3. `( cd .llm-wiki-memory/src && npm install --no-audit --no-fund )`
   4. `./.llm-wiki-memory/src/bootstrap.sh` — runs every pending migration, skips
      the settled ones, ABORTS loudly if one fails.
   5. Read bootstrap's migration summary. If it reports decisions it auto-defaulted,
      surface those lines to the user; review with `cli.mjs migrations --explain`.

4. **Offer self-observability (opt-in — ask once).** After bootstrap finishes,
   check whether `.llm-wiki-memory/settings/self-observability.enabled` exists.
   - If it does NOT, ASK the user once: "Enable llm-wiki-memory
     self-observability? The agent will watch the memory system while you work,
     record redacted anomaly captures under `.llm-wiki-memory/monitoring/`, and
     offer to plan engine fixes at session-end. Opt-in; default off." If they
     say yes, run `./.llm-wiki-memory/src/bootstrap.sh --enable-self-observability`
     (it references the `self-observability` rule into `.agents/rules`,
     `.claude/rules`, `.cursor/rules` and records consent in that sentinel). If
     they decline, do nothing.
   - If the sentinel ALREADY exists, consent was given previously — do NOT
     re-ask; the flag-less bootstrap re-run above already preserved it.

5. Never run `git add -A`, never commit or push anything; show the user the
   resulting change set and let them gate the git writes.

---

## Per-repo shared memory (opt-in)

A project can carry its OWN shared brain — a single `knowledge` category committed
into the repo so teammates who clone it inherit the knowledge — separate from each
developer's private brain (the `repo` layout).

**The engine is NEVER cloned into the project.** There is one engine clone, the
private brain at `~/.llm-wiki-memory/src`. Set up OR adopt a shared wiki with that
global engine's `mount-init` — one idempotent command, run from inside the repo:

```bash
node ~/.llm-wiki-memory/src/scripts/mount-init.mjs "$PWD"
```

- **Detect an already-shared repo first.** Before offering to set one up, check:
  `test -f .llm-wiki-memory/wiki/.layout/layout.yaml && git ls-files --error-unmatch .llm-wiki-memory/wiki/.layout/layout.yaml`.
  If that layout.yaml is tracked AND declares `ownership: repo`, the repo is
  already shared — run the `mount-init` above to ADOPT it (it wires the sync
  hooks + the gitignored derived caches rebuild locally; it never re-seeds or
  touches the committed leaves).
- **Otherwise, opt-in.** Ask whether this repo's memory should be PERSONAL
  (private, gitignored — the `default` layout) or SHARED (committed — the `repo`
  layout). For SHARED, run the same `mount-init`: on a repo with no wiki yet it
  SEEDS the `repo` layout (a negated `.gitignore` tracking only `knowledge/`, a
  private personal git repo, three sync-embeddings hooks) and writes the remote-read
  block. The user commits the shared category; the engine never commits it.

A shared repo carries ZERO machine-dependent files — **no engine clone**, no
per-repo client config, no `~/…` @-pointer files, and **no `AGENTS.md`/`CLAUDE.md`
block**: only the wiki data + yaml (`wiki/**`, `layout.yaml`, `layout.local.yaml`)
+ the mount `.gitignore`. The MCP server + hooks + rules + skills + the discipline
all live in each developer's home install (from `bootstrap.sh`) and apply in every
directory on their machine, so a teammate who clones installs the engine globally
once, runs the `mount-init` above, and is done — nothing is injected into the repo.
(The PRIVATE brain install is unchanged — it wires local `@~/.llm-wiki-memory/src/…`
pointers into `.agents/rules`/`.claude/skills`/`.claude/rules`/`.cursor/rules`.)

> **Legacy:** `./.llm-wiki-memory/src/bootstrap.sh --template repo --commit-memory`
> still works but requires an engine clone inside the repo — prefer the no-clone
> `mount-init` above, run from the one home engine.

## Uninstall

`./.llm-wiki-memory/src/bootstrap.sh --uninstall` reverses the machine-managed
surfaces: it removes the MCP server registration, the cron/launchd job, and the
chained sync-embeddings git-hook block, then PRINTS the manual reversals it
deliberately does NOT perform (revert the `.gitignore` edit, remove a per-mount
personal `.git`, and delete the mount / memory data). It NEVER deletes memory
data and is idempotent. Relay the printed manual steps to the user and let them
decide.

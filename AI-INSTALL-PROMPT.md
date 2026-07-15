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
   - **Layout template.** A plain install uses the `default` layout (the private
     per-developer brain). If the user wants a SHARED, repo-committed brain
     instead, install with `--template repo --commit-memory`. If you are unsure
     which they want, ASK once; otherwise take the `default`.
   - **Install location.** The private brain normally lives in the user's home
     directory, not in a project. Moving the engine home is a user-manual
     one-time step (Phase A) — do NOT relocate it yourself; install into
     `./.llm-wiki-memory/src` of the current project unless the user directs
     otherwise.

3. **It DOES exist → update.** Releases may contain BREAKING changes; each
   ships a runbook at `docs/releases/<yyyy>/<mm>/<dd>[/vN]/update-prompt.md`.
   Never just pull and re-run bootstrap blindly. Procedure:
   1. Print the current local state — this is the last applied update:
      `git -C .llm-wiki-memory/src log -1 --format='%h %cI'`
   2. `git -C .llm-wiki-memory/src fetch origin`
   3. List exactly the runbooks NOT yet applied locally (released after the
      local state):
      `git -C .llm-wiki-memory/src diff --name-only HEAD origin/main -- docs/releases | grep 'update-prompt\.md$' | sort`
      Apply order = this sorted list: dates ascend, and within one day the bare
      folder comes before `v2`, `v3`, … (numeric `vN` order).
   4. Read EVERY listed runbook, oldest first, from the fetched ref (do NOT
      merge yet): `git -C .llm-wiki-memory/src show origin/main:<path>`
   5. Build ONE short consolidated update plan from all of them in that order:
      a later runbook supersedes an earlier one where they touch the same file
      or setting; keep every DECISIONS fork and every VERIFICATION block. Show
      the user the plan as a few bullets before executing.
   6. Execute the plan:
      `git -C .llm-wiki-memory/src merge --ff-only origin/main` — if it is not
      a clean fast-forward, STOP and show the user the divergence (never
      force); `( cd .llm-wiki-memory/src && npm install --no-audit --no-fund )`;
      then the consolidated runbook steps — typically a re-run of
      `./.llm-wiki-memory/src/bootstrap.sh` (idempotent) plus any one-shot
      migration commands the runbooks name. A **SHARED team wiki** (its layout
      declares an `ownership: repo` category) is auto-detected on any re-run and
      stays git-tracked — a bare re-run does NOT revert it to private and needs no
      special flag. Optional check after: the workspace `.gitignore` fenced block
      still re-includes the shared categories, no `wiki/.git` exists, and the three
      `post-*` sync hooks are present. See `docs/shared-wikis.md` § "Upgrading a
      shared install".
   7. Verify with EVERY runbook's VERIFICATION block, oldest first; finish with
      `node .llm-wiki-memory/src/scripts/cli.mjs cron-health` reporting
      `healthy:true`. (On a box where daily docs are pending but NO LLM
      provider CLI is reachable, `healthy:false` with a
      `system:compile-llm-providers` escalation is the EXPECTED honest signal,
      not an install failure — fix provider availability, then re-check.)
   8. If step 3.3 lists nothing but HEAD differs from `origin/main`, it is a
      non-breaking update: ff-merge, npm install, re-run bootstrap, check
      cron-health. If HEAD already equals `origin/main`, say "already up to
      date" and stop.

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

A project can carry its OWN shared brain — a single `knowledge` category checked
into the repo so teammates who clone it inherit the knowledge — separate from
each developer's private brain. This is the `repo` layout template.

- **Detect an already-shared repo first.** Before offering to set one up, check
  whether the repo already has a committed shared brain:
  `test -f .llm-wiki-memory/wiki/.layout/layout.yaml && git ls-files --error-unmatch .llm-wiki-memory/wiki/.layout/layout.yaml`.
  If that layout.yaml is tracked AND declares `ownership: repo`, the repo is
  already shared — OFFER to ADOPT it (the MCP server + Claude Code hooks are
  registered GLOBALLY in your home config by bootstrap, never per-repo — so
  adopting only wires the mount git surfaces with
  `node .llm-wiki-memory/src/scripts/mount-init.mjs "$PWD"`), do NOT re-seed it.
- **Otherwise, per-repo opt-in.** Ask whether this repo's memory should be
  PERSONAL (private, gitignored — the `default` layout) or SHARED (committed —
  the `repo` layout). For SHARED, install with
  `./.llm-wiki-memory/src/bootstrap.sh --template repo --commit-memory`; bootstrap
  materialises the `repo` layout and `mount-init.mjs` wires the mount (a negated
  `.gitignore` tracking only `knowledge/`, a private personal git repo, and a
  chained sync-embeddings hook). The user commits the shared category; the
  engine never commits it for them. A shared repo carries ZERO
  machine-dependent files — no per-repo client configs and no `~/…` @-pointer
  files: it carries only the wiki data + yaml (`wiki/**`, `layout.yaml`,
  `layout.local.yaml`) + the mount `.gitignore`, PLUS exactly ONE
  machine-independent remote-read block in `AGENTS.md`/`CLAUDE.md` pointing at
  the discipline on
  `https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/templates/agents-memory-instructions.md`.
  The MCP server + hooks live in each developer's home config, so a teammate who
  clones just installs the engine globally and picks up the discipline from that
  remote-read block. (The PRIVATE brain install is unchanged — it still wires
  local `@~/.llm-wiki-memory/src/…` pointers into `.agents/rules`/`.claude/skills`/
  `.claude/rules`/`.cursor/rules`.)

## Uninstall

`./.llm-wiki-memory/src/bootstrap.sh --uninstall` reverses the machine-managed
surfaces: it removes the MCP server registration, the cron/launchd job, and the
chained sync-embeddings git-hook block, then PRINTS the manual reversals it
deliberately does NOT perform (revert the `.gitignore` edit, remove a per-mount
personal `.git`, and delete the mount / memory data). It NEVER deletes memory
data and is idempotent. Relay the printed manual steps to the user and let them
decide.

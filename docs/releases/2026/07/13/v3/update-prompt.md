# llm-wiki-memory: reference-only install — rules/skills are @-pointers, no copies (2026-07-13 v3)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past the
**2026-07-13 v3** release. This stacks on the same-day v1 (nested MCP wire) and v2
(deterministic `project_module` identity) — apply those first if you have not.

**WHO IS AFFECTED — everyone who re-runs `bootstrap.sh`.** This release replaces the
old install model (hard-copy rules/skills + OS symlinks + an inlined AGENTS/CLAUDE
prose block) with a **reference-only** model:

- **(breaking) Rules/skills are now `@`-pointer FILES, not copies or symlinks.** Each
  shipped rule/skill on each surface (`.agents/rules`, `.claude/rules`,
  `.claude/skills`, `.cursor/rules`) is a small file named
  `llm-wiki-memory-<name>.md` whose body is `@~/.llm-wiki-memory/src/<path>` plus a
  plain fallback line. There is ONE source of truth — `~/.llm-wiki-memory/src` — and
  every surface references it, so an engine update is picked up everywhere with no
  re-copy. The `llm-wiki-memory-` prefix marks every file the memory system owns.
  Being plain files (not OS symlinks), they are **cloud-sync-safe by construction**.
- **(breaking) AGENTS.md / CLAUDE.md get a marker-fenced `@`-include**, not an inlined
  prose block: one block containing
  `@~/.llm-wiki-memory/src/templates/agents-memory-instructions.md` (+ a fallback path
  line). Your own content in those files is preserved; an absent file is created with
  just the block.
- **(breaking) The MCP/hooks configs are home-based via `${HOME}`.** `.mcp.json` /
  `.agents/*` server args use `${HOME}/.llm-wiki-memory/src/mcp-server/index.mjs`
  (the MCP client interpolates `${HOME}`; a literal `~` is NOT expanded in JSON args);
  `.claude/settings.json` hook commands invoke `$HOME/.llm-wiki-memory/src/scripts/hooks/…`
  (dropping `$CLAUDE_PROJECT_DIR`). These are the ONLY things still written into the
  project; everything else is a reference.
- **Migration on re-bootstrap:** old unprefixed hard copies / symlinks of our rules are
  DELETED and replaced with the prefixed `@`-pointers; the inlined AGENTS/CLAUDE block is
  replaced by the `@`-include. Your project's OWN authored rules are left untouched. A
  re-run is byte-stable (idempotent).

`~/.llm-wiki-memory/src` is the single home install (never a hardcoded absolute machine
path in a committed config; `~`/`${HOME}` throughout). No wiki DATA migration.

## How to use this file

In a Claude Code (or any capable agent) session inside the target repo, do either:

- **Reference it:** "Fetch and follow the runbook at
  `https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/docs/releases/2026/07/13/v3/update-prompt.md`,
  applying it to this project."
- **Paste it:** copy everything inside the `--- PROMPT ---` fence below.

If you want it run unattended, add: "I am AFK; go to the end without interruptions, take
the safe default for each decision, and surface anything that blocks instead of stalling."

--- PROMPT ---

Update this project's vendored llm-wiki-memory runtime to the latest upstream. Work
autonomously; only stop for the genuine decisions listed at the end.

WHAT'S NEW UPSTREAM (why this matters):

The 2026-07-13 v3 release makes the install reference-only. Rules/skills become
`llm-wiki-memory-<name>.md` `@`-pointer files into `~/.llm-wiki-memory/src` (no copies,
no symlinks); AGENTS.md/CLAUDE.md get one marker-fenced `@`-include; the MCP/hooks
configs are `${HOME}`-based. A re-bootstrap migrates an old install (removes old copies,
writes pointers, swaps the inlined block for the `@`-include) and is idempotent.

PROCEDURE:

1. Update the runtime.
   ```
   git -C .llm-wiki-memory/src fetch origin
   git -C .llm-wiki-memory/src merge --ff-only origin/main
   ( cd .llm-wiki-memory/src && npm install --no-audit --no-fund ) ; echo "npm install exit=$?"
   ```
   Clean fast-forward AND `npm install exit=0`. Mode-only (`100755 → 100644`) `--ff-only`
   failures → `git -C .llm-wiki-memory/src config core.fileMode false` + `checkout -- .` +
   retry. A genuine CONTENT divergence → surface it; never force.

2. Re-run the bootstrap (idempotent; performs the migration: deletes old unprefixed
   rule/skill copies + symlinks, writes the prefixed `@`-pointers, swaps the AGENTS/CLAUDE
   block for the `@`-include, rewrites the MCP/hooks configs to `${HOME}`/`$HOME`).
   ```
   ./.llm-wiki-memory/src/bootstrap.sh
   ```

3. Run the test suite.
   ```
   ( cd .llm-wiki-memory/src && npm test )
   ```
   Expected: all tests pass.

4. RESTART so the new MCP path + hooks are live. The running server still points at the
   OLD server path and the OLD hook commands; a restart reloads `.mcp.json` +
   `.claude/settings.json`. On Claude Code, restart the session (or `/mcp` reconnect);
   other clients re-launch the server.

5. Confirm the server launches after restart (this is the one real risk — see DECISIONS):
   issue any read tool (e.g. `get_memory_config`) from your MCP client and confirm it
   responds. If it does not, the client did not expand `${HOME}` in `.mcp.json` args (see
   DECISIONS).

DECISIONS:

- **A client that does not interpolate `${HOME}` in `.mcp.json` args won't launch the
  server.** Claude Code IS confirmed to expand `${HOME}` (and `${VAR:-default}`) in
  command/args/env. If a DIFFERENT client (Cursor/Codex/generic) fails to start the
  server after restart, that client does not expand `${HOME}` there — SAFE DEFAULT: use
  that client's own env-var syntax, or paste the absolute snippet from
  `node .llm-wiki-memory/src/scripts/mcp-config.sh <client>` (the global snippets are
  print-time absolute for exactly this reason). Do NOT use a literal `~` in JSON args (it
  is never expanded).
- The migration only removes files the memory system owns (its shipped rule/skill
  basenames + `llm-wiki-memory-` prefixed pointers). Your project's OWN authored rules
  (e.g. planning-methodology, team conventions) are left untouched. If one of your own
  rules shares a basename with a shipped one, surface it rather than deleting.
- The `.mcp.json` merge preserves a customized `llm-wiki-memory` server entry: if its
  `command` differs from the shipped template (e.g. a company-mandated prompt_security
  wrapper prepended to the launcher), the whole entry is kept verbatim and NOT reset to
  the template on re-bootstrap. A non-customized entry (command === the template's
  `node`) is refreshed normally. If you wrapped the server AND the src path moved, verify
  the inner `index.mjs` arg by hand, since the wrapped entry is preserved as-is.

VERIFICATION:

The upgrade is successful if and only if:

- `( cd .llm-wiki-memory/src && npm test )` is fully green.
- Each surface holds prefixed pointers, not copies:
  `ls .claude/skills` shows `llm-wiki-memory-*.md`, and each is a thin file whose body is
  an `@~/.llm-wiki-memory/src/...` line (NOT the canonical rule's full text).
- No old unprefixed copies of our rules remain on any surface (e.g. no bare
  `.claude/skills/consolidate.md`).
- `AGENTS.md` and `CLAUDE.md` each contain exactly ONE `<!-- BEGIN llm-wiki-memory -->`
  block, that block `@`-includes `~/.llm-wiki-memory/src/templates/agents-memory-instructions.md`,
  and your own content is intact.
- `.mcp.json` server args use `${HOME}/.llm-wiki-memory/src/...` (no literal `~`, no
  hardcoded `/Users/…`); `.claude/settings.json` hooks use `$HOME/.llm-wiki-memory/src/scripts/hooks/…`
  (no `$CLAUDE_PROJECT_DIR`).
- After restart, an MCP read tool responds (the server launched).
- The project repo (`git status` at the workspace root) gained no commits or staged
  changes from the memory system.

When all of the above hold, the upgrade is complete. Do NOT auto-commit / push / open a
PR. Surface the change set to the user and let them gate the writes.

--- END PROMPT ---

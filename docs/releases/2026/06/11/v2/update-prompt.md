# llm-wiki-memory opt-in self-observability runbook (2026-06-11 v2)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past the
**2026-06-11 v2** release. (Apply the same-day base `2026/06/11/update-prompt.md` first —
runbooks apply oldest→newest.)

**WHO IS AFFECTED — read this first.** This release is **additive and opt-in**. It adds a
self-observability feature: a new `self-observability` rule, a `cli.mjs monitor` /
`cli.mjs monitoring-health` pair, a SessionStart line, a session-end-capture step, and two
bootstrap flags (`--enable-self-observability` / `--disable-self-observability`). **Nothing
changes for an existing install until the user explicitly opts in.** If you do nothing, the
feature stays dormant (no monitoring dir, no rule wired, no behaviour change). There is no data
migration.

**What it does when enabled:** the agent watches the memory system while you work; on a
confirmed llm-wiki-memory bug it records a redacted forensic capture under
`.llm-wiki-memory/monitoring/<yyyy>/<mm>/<dd>/<slug>-<ts>.md` (gitignored, never indexed, NOT
write-gated), and at session-end offers to review open captures and plan fixes for
`.llm-wiki-memory/src`. Consent is a sentinel file (`.llm-wiki-memory/settings/self-observability.enabled`)
that survives flag-less re-bootstraps; the rule is REFERENCED (via `@`-include pointers) into the
project's `.agents/rules`, `.claude/rules`, `.cursor/rules` so it tracks engine updates.

## How to use this file

In a Claude Code (or any capable agent) session inside the target repo, do either:

- **Reference it:** "Fetch and follow the runbook at
  `https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/docs/releases/2026/06/11/v2/update-prompt.md`,
  applying it to this project."
- **Paste it:** copy everything inside the `--- PROMPT ---` fence below.

If you want it run unattended, add: "I am AFK; go to the end without interruptions, take the safe
default for each decision, and surface anything that blocks instead of stalling." (The safe
default here is to LEAVE self-observability disabled unless the user asked for it.)

--- PROMPT ---

Update this project's vendored llm-wiki-memory runtime to the latest upstream. Work
autonomously; only stop for the genuine decisions listed at the end.

WHAT'S NEW UPSTREAM (why this matters):

The 2026-06-11 v2 release adds an OPT-IN self-observability loop: when enabled, the agent records
redacted captures of llm-wiki-memory bugs it notices interactively (under
`.llm-wiki-memory/monitoring/`) and offers to plan engine fixes at session-end. It is additive and
dormant until the user opts in with a new bootstrap flag. Nothing on disk migrates.

PROCEDURE:

1. Update the runtime.
   ```
   git -C .llm-wiki-memory/src fetch origin
   git -C .llm-wiki-memory/src merge --ff-only origin/main
   ( cd .llm-wiki-memory/src && npm install --no-audit --no-fund )
   ```
   Must be a clean fast-forward. If `--ff-only` fails because files changed mode
   `100755 → 100644` (a cloud-sync daemon stripped the executable bit), run
   `git -C .llm-wiki-memory/src config core.fileMode false`, then
   `git -C .llm-wiki-memory/src checkout -- .`, then retry. Otherwise surface the divergence.

2. Re-run the bootstrap (idempotent — preserves any existing self-observability consent).
   ```
   ./.llm-wiki-memory/src/bootstrap.sh
   ```

3. Run the test suite.
   ```
   ( cd .llm-wiki-memory/src && npm test )
   ```
   Expected: all tests pass (includes the new `monitoring` suite).

4. Ask the user about self-observability (opt-in). Check whether the consent sentinel exists:
   ```
   test -f .llm-wiki-memory/settings/self-observability.enabled && echo ENABLED || echo "not enabled"
   ```
   - If "not enabled": ASK the user once — "Enable llm-wiki-memory self-observability? The agent
     will record redacted anomaly captures under `.llm-wiki-memory/monitoring/` and offer to plan
     engine fixes at session-end. Opt-in; default off." If they say yes:
     ```
     ./.llm-wiki-memory/src/bootstrap.sh --enable-self-observability
     ```
     If they decline, do nothing — the feature stays dormant.
   - If "ENABLED": consent was given before; the re-run in step 2 already preserved it. Do not
     re-ask.

DECISIONS:

- `git merge --ff-only` fails on mode-only changes (`100755 → 100644`) → cloud-sync stripped the
  exec bit; safe fix is `git config core.fileMode false` + `git checkout -- .` + retry. A genuine
  CONTENT divergence → surface it; never force.
- The user is unsure about self-observability → default to NOT enabling it (it is opt-in and fully
  reversible later with `--enable-self-observability`). Do not enable on their behalf.
- You are running unattended / AFK → leave self-observability disabled (skip the enable in step 4).

VERIFICATION:

The upgrade is successful if and only if:

- `( cd .llm-wiki-memory/src && npm test )` is fully green.
- `node .llm-wiki-memory/src/scripts/cli.mjs monitoring-health` runs and prints
  `"healthy": true` (no captures yet) on a fresh upgrade.
- If the user opted in: `bootstrap.sh --enable-self-observability` logs
  `Self-observability ENABLED: rule referenced into .agents/rules, .claude/rules, .cursor/rules.`,
  the file `.llm-wiki-memory/settings/self-observability.enabled` exists, and a
  `self-observability.md` pointer exists in EACH of `.agents/rules/`, `.claude/rules/`,
  `.cursor/rules/` (each `@`-including `.llm-wiki-memory/src/.agents/rules/self-observability.md`).
- If the user did NOT opt in: no `self-observability.enabled` sentinel exists and no
  `self-observability.md` pointer was added to the project rule dirs.
- `node .llm-wiki-memory/src/scripts/cli.mjs monitor --title "verify install" --severity likely-bug`
  writes a file under `.llm-wiki-memory/monitoring/<today>/`; `monitoring-health` then reports
  `open: 1`; `monitor --resolve <that file>` returns `triaged` and `monitoring-health` returns to
  `open: 0`. (Delete the verification capture afterward if you like — it is gitignored either way.)
- The project repo (`git status` at the workspace root) gained no commits or staged changes from
  the memory system (`.llm-wiki-memory/monitoring/` and the consent sentinel are gitignored).

When all of the above hold, the upgrade is complete. Do NOT auto-commit / push / open a PR —
surface the change set to the user and let them gate the writes.

--- END PROMPT ---

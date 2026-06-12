# llm-wiki-memory write-gate audit trail + per-lesson consent runbook (2026-06-13)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past the
**2026-06-13** release.

**WHO IS AFFECTED, read this first.** This release tightens the **self_improvement**
write-gate and adds an audit ledger. It changes behaviour for **every** install that uses
the gate, but it never blocks a save and needs no on-disk migration:

- **(breaking, behaviour) Per-lesson consent is now the default.** Previously, one save
  phrase in a user turn (save / remember / record / store / persist / memorise) made the
  Claude Code L2 hook auto-allow EVERY gated self_improvement write that followed in that
  turn, so a session-end flush could persist many lessons under one bulk approval. Now the
  phrase auto-allows only the FIRST gated write of a turn; each subsequent one returns
  `ask` (a one-click prompt). Enforced on **Claude Code only** (the L2 hook); other clients
  keep L1 discipline + the new audit trail. Operators who want the old behaviour set
  `gate.perLessonConsent: false`. New installs and existing installs both pick this up from
  the structural default, no settings edit required.
- **(additive) A redacted audit ledger.** Every write to the gated self_improvement category
  is appended to `.llm-wiki-memory/state/.save-gate-audit.log` (JSONL, gitignored, created
  lazily), so the ledger shows how each lesson came to exist: the L3 server records each
  interactive `accepted` decision (with its consent basis `user-flag` / `system-maintenance` /
  `gate-disabled`) and each `refused` decision; the L2 hook records each `allow` / `ask` decision (`allow` records also
  carry the redacted trigger phrase); and the compile pipeline records each lesson it
  auto-distills from sessions
  (`layer: compile`, `consent: compile-distilled`). Read it with `cli.mjs gate-audit`.
  Best-effort: it never blocks or slows a write or compile, and creates no file until something
  is recorded. Toggle with `gate.auditTrailEnabled` (default true); bound size with
  `gate.auditKeep` (default 1000). Distillation behaviour is unchanged; this is observability only.
- **(additive) `cli.mjs gate-audit` reads the ledger (read-only). The L2 hook now narrows
  `write_memory` and `save_to_dataset` to writes that actually land in self_improvement
  (including the `path:`-into-self_improvement bypass), matching the L3 server's
  `targetsGatedCategory` exactly.** (Previously the hook gated EVERY `write_memory` call
  regardless of dataset; now a non-self_improvement `write_memory`, e.g. a knowledge write,
  flows through untouched, and a `dataset:"knowledge"` + `path:"self_improvement/..."` write
  is correctly gated.)

There is no on-disk migration. The three new `gate.*` keys take effect via their structural
defaults, so an install that keeps its existing `settings.yaml` is fully covered.

## How to use this file

In a Claude Code (or any capable agent) session inside the target repo, do either:

- **Reference it:** "Fetch and follow the runbook at
  `https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/docs/releases/2026/06/13/update-prompt.md`,
  applying it to this project."
- **Paste it:** copy everything inside the `--- PROMPT ---` fence below.

If you want it run unattended, add: "I am AFK; go to the end without interruptions, take the
safe default for each decision, and surface anything that blocks instead of stalling."

--- PROMPT ---

Update this project's vendored llm-wiki-memory runtime to the latest upstream. Work
autonomously; only stop for the genuine decisions listed at the end.

WHAT'S NEW UPSTREAM (why this matters):

The 2026-06-13 release makes self_improvement consent PER-LESSON instead of per-turn (one
save phrase no longer auto-allows a whole session-end flush on Claude Code) and adds a
redacted audit ledger of every gate decision (`state/.save-gate-audit.log`, read via
`cli.mjs gate-audit`). Both ride fail-closed `gate.*` config flags that default to the safe
posture. Nothing on disk migrates.

PROCEDURE:

1. Update the runtime.
   ```
   git -C .llm-wiki-memory/src fetch origin
   git -C .llm-wiki-memory/src merge --ff-only origin/main
   ( cd .llm-wiki-memory/src && npm install --no-audit --no-fund )
   ```
   Must be a clean fast-forward. If `--ff-only` fails because files changed mode
   `100755 → 100644` (a cloud-sync daemon stripped the exec bit), run
   `git -C .llm-wiki-memory/src config core.fileMode false`, then
   `git -C .llm-wiki-memory/src checkout -- .`, then retry. Otherwise surface the divergence.

2. Re-run the bootstrap (idempotent, re-renders the updated write-gate rule that now
   documents per-lesson consent + the audit trail into `.agents/rules`, `.claude/rules`,
   `.cursor/rules`).
   ```
   ./.llm-wiki-memory/src/bootstrap.sh
   ```
   Expected log line: `Rendered shipped process rules to .agents/rules, .claude/rules, and .cursor/rules.`

3. Run the test suite.
   ```
   ( cd .llm-wiki-memory/src && npm test )
   ```
   Expected: all tests pass (includes the new `save-gate-audit` suite and the extended
   `hardening-gate-server` / `hardening-pretooluse-gate-hook` / `hardening-discipline-write-gate`
   / `settings` suites).

4. Confirm the audit CLI is present (read-only; safe any time).
   ```
   node .llm-wiki-memory/src/scripts/cli.mjs gate-audit
   ```
   Expected: a JSON array (`[]` on an install where no gated write has happened yet).

5. RESTART so the new code is live. The running MCP server is still the OLD code, its L3
   audit only records after a reconnect. On Claude Code, restart the session (or `/mcp`
   reconnect); other clients re-launch the server. The L2 hook picks up the new code on its
   next invocation automatically.

DECISIONS:

- `git merge --ff-only` fails on mode-only changes (`100755 → 100644`) → cloud-sync stripped
  the exec bit; safe fix is `git config core.fileMode false` + `git checkout -- .` + retry. A
  genuine CONTENT divergence → surface it; never force.
- You want the OLD turn-level consent (one save phrase covers a whole flush) → set
  `gate.perLessonConsent: false` in `.llm-wiki-memory/settings/settings.yaml`. Default is
  per-lesson ON.
- You do not want the audit ledger → set `gate.auditTrailEnabled: false` (default true). The
  ledger is gitignored and best-effort; leaving it on is recommended.
- The audit ledger grows too large → lower `gate.auditKeep` (default 1000; older lines are
  front-truncated).

VERIFICATION:

The upgrade is successful if and only if:

- `( cd .llm-wiki-memory/src && npm test )` is fully green.
- `node .llm-wiki-memory/src/scripts/cli.mjs gate-audit` runs and prints a JSON array.
- After a reconnect, a `save_lesson` WITHOUT `userRequested:true` is still refused
  (`write-gate-refused`) AND appends one line to `.llm-wiki-memory/state/.save-gate-audit.log`
  with `"layer":"L3"` and `"status":"refused"` (the `consent` key appears ONLY on accepted
  records, never on refused ones); a `save_lesson` WITH the
  flag succeeds AND appends a line with `"status":"accepted"` and `"consent":"user-flag"`; a
  `save_to_dataset(dataset="knowledge", ...)` (no path override) appends NO audit line.
  `cli.mjs gate-audit`
  shows the two self_improvement records.
- On Claude Code: two `save_lesson` calls in the SAME user turn, the second is prompted
  (`ask`) rather than silently allowed (per-lesson consent).
- The rendered `.agents/rules/memory-write-gate.md` contains a "Per-lesson consent" section
  and an "Audit trail" section, and `gate.perLessonConsent` / `gate.auditTrailEnabled` /
  `gate.auditKeep` appear in `.llm-wiki-memory/src/templates/settings.yaml`.
- The project repo (`git status` at the workspace root) gained no commits or staged changes
  from the memory system (`state/.save-gate-audit.log` is gitignored).

When all of the above hold, the upgrade is complete. Do NOT auto-commit / push / open a PR.
Surface the change set to the user and let them gate the writes.

--- END PROMPT ---

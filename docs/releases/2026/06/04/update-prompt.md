# llm-wiki-memory wiki-auto-commit + entity-level self-healing runbook (2026-06-04)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install
(a project that already has `.llm-wiki-memory/src` cloned) past the
**2026-06-04** release.

**Target of this runbook:** bring an install up to the upstream `main` that contains:

- **Wiki auto-commit** (`wiki.autoCommit: true`, a NEW DEFAULT-ON behaviour):
  every wiki change commits itself to the wiki's OWN git repo, one commit per
  logical operation, with the touched leaves + reasons in the commit body.
  Bootstrap now `git init`s `<data>/wiki` when it has no repo (skipped under
  `--commit-memory`). The layer only ever commits when the wiki dir is its own
  repo toplevel, so your project repo can never receive a memory commit. The
  hourly cron also runs `git gc --auto` on the wiki repo so the object store
  from frequent auto-commits stays compact.
- **Entity-level self-healing**: the cron attempt log is now SLIM (no embedded
  stderr; last `consolidate.attemptsKeep` runs) and every run writes a FULL
  sharded record at `state/logs/<yyyy>/<mm>/cron-<ts>.json` (pruned after
  `consolidate.fullLogRetentionDays`). Entities that keep failing across runs
  escalate after `consolidate.escalateAfterAttempts` consecutive attempts into
  redacted skeleton issue reports at
  `issues/<yyyy>/<mm>/<dd>/<signature>.<version>.md`.
- **cron-health response shape change**: the JSON gains an `escalations` array
  and `healthy:false` now also fires when an escalation episode is open (not
  only when the most recent attempt failed). Anything parsing the old fat
  attempt entries (`compile.stderr` inside the log) must read the full sharded
  log instead.
- The L2 Claude Code write-gate hook gains an off-switch
  (`gate.claudeHookEnabled: true` by default).
- Capture hardening: chunk hard-cuts are UTF-16 surrogate-safe.

## How to use this file

In a Claude Code (or any capable agent) session inside the target repo, do either:

- **Reference it:** "Fetch and follow the runbook at
  `https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/docs/releases/2026/06/04/update-prompt.md`,
  applying it to this project."
- **Paste it:** copy everything inside the `--- PROMPT ---` fence below into the session.

If you want it run unattended, add: "I am AFK for several hours; go all the way to
the end without interruptions, take the safe default for each decision below, and
surface anything that blocks instead of stalling."

--- PROMPT ---

Update this project's vendored llm-wiki-memory runtime to the latest upstream.
Work autonomously; only stop for the genuine decisions listed at the end.

WHAT'S NEW UPSTREAM (why this matters):

The 2026-06-04 release makes the wiki self-committing (`wiki.autoCommit`
defaults to TRUE — a default flip: installs whose wiki dir has, or now gets,
its own git repo will start producing `memory(<op>): ...` commits), replaces
the fat cron attempt log with slim entries + full sharded per-run logs, and
adds entity-level escalation with on-disk issue reports. The cron-health JSON
response shape changed additively (`escalations` array; broader `healthy`
semantics). No data migrates; all new settings keys default-coerce when absent.

PROCEDURE:

1. Update the runtime.
   ```
   git -C .llm-wiki-memory/src fetch origin
   git -C .llm-wiki-memory/src merge --ff-only origin/main   # clean fast-forward
   ( cd .llm-wiki-memory/src && npm install --no-audit --no-fund )
   ```
   Must be a clean fast-forward. If not, surface the divergence to the user.

2. Re-run the bootstrap (idempotent).
   ```
   ./.llm-wiki-memory/src/bootstrap.sh
   ```
   Expected NEW log line on a default (gitignored) install whose wiki had no repo:
   - `Initialised git repo at <abs path>/wiki (auto-commit history; disable via settings wiki.autoCommit)`
   On a `--commit-memory` install this line does NOT appear (by design — the
   wiki rides inside the workspace repo and auto-commit stays a silent no-op).
   No one-shot migration command exists or is needed for this release: the new
   `consolidate.attemptsKeep` / `consolidate.fullLogRetentionDays` /
   `consolidate.escalateAfterAttempts` / `gate.claudeHookEnabled` /
   `wiki.autoCommit` keys default-coerce when missing from your settings.yaml,
   and the old fat attempt log self-trims to the slim format on the next run.

3. Run the test suite.
   ```
   ( cd .llm-wiki-memory/src && npm test )
   ```
   Expected: all tests pass. If any fail, surface the first failing test name.

4. Exercise the new pipeline once.
   ```
   node .llm-wiki-memory/src/scripts/cli.mjs cron-job
   node .llm-wiki-memory/src/scripts/cli.mjs cron-health
   ```

5. Sanity-check the wiki auto-commit (default installs only).
   ```
   # Make any memory save through your agent (or wait for the next flush),
   # then:
   git -C .llm-wiki-memory/wiki log --oneline -3
   ```
   Expected: `memory(<op>): ...` commits authored by
   `llm-wiki-memory <memory@llm-wiki-memory.local>`. Your PROJECT repo status
   must show no new commits from the memory system.

DECISIONS:

There are no genuine forks under normal operation. Stop and ask the user only if:

- `git merge --ff-only origin/main` fails (working tree divergence) →
  surface; do NOT force-merge.
- The user does NOT want self-committing memory → set `wiki.autoCommit: false`
  in `.llm-wiki-memory/settings/settings.yaml` (everything else still works).
- A tool of yours parsed the OLD fat attempt-log entries
  (`compile.stderr` / `consolidate.stderr` inside
  `state/.consolidate-attempts.log`) → point it at the full sharded logs
  (`state/logs/<yyyy>/<mm>/cron-<ts>.json`); the slim entries carry a
  `logPath` field to the right file.
- The migration-era stop rule still applies: a bootstrap log line
  `[migrate-settings] failed: <message>` means the settings migration failed —
  bootstrap aborts before the defaults fallback; surface it.

VERIFICATION:

The upgrade is successful if and only if ALL of the following hold:

- `( cd .llm-wiki-memory/src && npm test )` is fully green.
- `node .llm-wiki-memory/src/scripts/cli.mjs cron-health` returns JSON with an
  `escalations` array (normally `[]`) and `healthy: true`.
- After one `cron-job`: a file matching
  `.llm-wiki-memory/state/logs/<yyyy>/<mm>/cron-*.json` exists, and the newest
  line of `.llm-wiki-memory/state/.consolidate-attempts.log` contains
  `"logPath"` and does NOT contain `"stderr"`.
- Default install: `.llm-wiki-memory/wiki/.git` exists and (after one memory
  write) `git -C .llm-wiki-memory/wiki log -1` shows a `memory(` subject.
  `--commit-memory` install: no `.git` inside the wiki dir.
- The project repo (`git status` at the workspace root) gained no commits or
  staged changes from the memory system.
- `.llm-wiki-memory/issues/` does not exist yet (it is created only on a real
  escalation) — its later appearance is the escalation signal, not an error.

When all of the above hold, the upgrade is complete. Do NOT auto-commit / push /
open a PR — surface the change set to the user and let them gate the writes.

--- END PROMPT ---

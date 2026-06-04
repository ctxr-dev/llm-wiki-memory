# llm-wiki-memory cron PATH fix + provider-unavailable observability runbook (2026-06-04 v2)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install
(a project that already has `.llm-wiki-memory/src` cloned) past the
**2026-06-04 v2** release.

**Target of this runbook:** bring an install up to the upstream `main` that contains:

- **Scheduled-job PATH fix**: launchd/cron strip PATH down to
  `/usr/bin:/bin:/usr/sbin:/sbin`, which hid the LLM provider CLIs (`claude`,
  `codex`, `cursor-agent`) from the hourly job — compile silently skipped daily
  promotion while everything reported healthy. Bootstrap now bakes a hybrid
  PATH (your login PATH plus well-known CLI install dirs, built by
  `scripts/lib/cron-path.mjs`) into the launchd plist / cron wrapper, and
  provider spawns append the same dirs at runtime as defense in depth.
  **The plist/wrapper only gain the PATH when bootstrap re-runs with
  `--schedule daily` — that re-run is the load-bearing step of this upgrade.**
- **Compile exit-code contract change (BREAKING)**: when daily docs are
  pending but no LLM/bridge provider is reachable, `cli.mjs compile` now exits
  **69** (BSD `EX_UNAVAILABLE`) instead of 0. Exit 0 still means clean; other
  non-zero still means hard failure.
- **cron-health semantics change (BREAKING-ish)**: a provider-unavailable
  compile tick now records a FAILED attempt — `cron-health` reports
  `healthy:false` immediately (self-clearing on the next good tick) where the
  old release reported `healthy:true` forever. Persistent provider absence
  escalates after `consolidate.escalateAfterAttempts` consecutive ticks into
  an issue report via the synthetic entities `system:compile-llm-providers`
  (compile promote work) and `system:consolidate-llm-providers` (consolidate
  LLM passes silently skipped). The first healthy tick resolves the episode.
  The cron tick still runs consolidate's deterministic passes on exit 69.
- Slim attempt-log entries gain additive fields (`compile.exit` carries 69;
  `consolidate.llm` / `consolidate.llmRequested`). Old entries still parse.

## How to use this file

In a Claude Code (or any capable agent) session inside the target repo, do either:

- **Reference it:** "Fetch and follow the runbook at
  `https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/docs/releases/2026/06/04/v2/update-prompt.md`,
  applying it to this project."
- **Paste it:** copy everything inside the `--- PROMPT ---` fence below into the session.

If you want it run unattended, add: "I am AFK for several hours; go all the way to
the end without interruptions, take the safe default for each decision below, and
surface anything that blocks instead of stalling."

--- PROMPT ---

Update this project's vendored llm-wiki-memory runtime to the latest upstream.
Work autonomously; only stop for the genuine decisions listed at the end.

WHAT'S NEW UPSTREAM (why this matters):

The 2026-06-04 v2 release fixes the hourly cron job's PATH (launchd/cron's
minimal PATH hid the provider CLIs, so daily-doc promotion silently did
nothing while reporting healthy) and makes that failure mode observable:
`compile` exits 69 (EX_UNAVAILABLE) when work is pending but no provider is
reachable, the tick counts as a failed attempt (`cron-health` →
`healthy:false`, self-clearing), and persistent provider absence escalates
into an issue report through the existing self-healing machinery. No data
migrates. The scheduled job's PATH is only refreshed by re-running bootstrap
with `--schedule daily`.

PROCEDURE:

1. Update the runtime.
   ```
   git -C .llm-wiki-memory/src fetch origin
   git -C .llm-wiki-memory/src merge --ff-only origin/main   # clean fast-forward
   ( cd .llm-wiki-memory/src && npm install --no-audit --no-fund )
   ```
   Must be a clean fast-forward. If not, surface the divergence to the user.

2. Check whether this install has the hourly scheduled job.
   ```
   ls ~/Library/LaunchAgents/com.llm-wiki-memory.*.plist 2>/dev/null   # macOS
   crontab -l 2>/dev/null | grep "llm-wiki-memory"                     # Linux
   ```
   - A plist or crontab line exists → the job is installed; step 3 MUST use
     `--schedule daily` so it regenerates with the hybrid PATH.
   - Neither exists → this install never scheduled the cron job; run step 3
     WITHOUT the flag (do not silently add a scheduled job the user never had).

3. Re-run the bootstrap (idempotent).
   ```
   ./.llm-wiki-memory/src/bootstrap.sh --schedule daily   # job installed (step 2)
   # OR, when no scheduled job existed:
   ./.llm-wiki-memory/src/bootstrap.sh
   ```
   Expected log line with `--schedule daily` (exact strings from bootstrap.sh):
   - macOS: `Installed hourly cron-job (launchd, every hour at :00): <plist path>`
   - Linux: `Installed hourly cron-job (crontab, every hour at :00) via wrapper <wrapper path> tagged: <tag>`
   No one-shot migration command exists for this release: no settings keys
   were added or renamed.

4. Verify the scheduler gained the hybrid PATH (only when step 2 found a job).
   ```
   # macOS:
   grep -A1 '<key>PATH</key>' ~/Library/LaunchAgents/com.llm-wiki-memory.*.plist
   # Linux:
   grep '^export PATH=' .llm-wiki-memory/state/cron-daily.sh
   ```
   Expected: a `:`-joined PATH whose value contains the directory of your
   provider CLI — check with
   `dirname "$(command -v claude || command -v codex || command -v cursor-agent)"`.

5. Run the test suite.
   ```
   ( cd .llm-wiki-memory/src && npm test )
   ```
   Expected: all tests pass. If any fail, surface the first failing test name.

6. Exercise the pipeline once.
   ```
   node .llm-wiki-memory/src/scripts/cli.mjs cron-job
   node .llm-wiki-memory/src/scripts/cli.mjs cron-health
   ```

DECISIONS:

- `git merge --ff-only origin/main` fails (working tree divergence) →
  surface; do NOT force-merge.
- **`~/Library/LaunchAgents` is owned by root** (seen on managed macOS
  machines): bootstrap's plist write or `launchctl load` fails with
  permission denied. Safe default: surface to the user with the manual
  sequence — `sudo chown $(whoami):staff ~/Library/LaunchAgents`, re-run
  `./.llm-wiki-memory/src/bootstrap.sh --schedule daily`, then verify with
  `launchctl list | grep llm-wiki-memory`. Do NOT run sudo yourself
  unattended; STOP and surface if chown is refused.
- **`cron-health` now reports `healthy:false`** with a
  `system:compile-llm-providers` escalation → that is the new HONEST signal,
  not an install failure. It means daily docs are pending and the hourly job
  still cannot reach a provider CLI. Check that the directory from step 4's
  `dirname` command appears in the plist/wrapper PATH; if the CLI lives
  somewhere exotic, add that dir to your login PATH and re-run
  `bootstrap.sh --schedule daily` (bootstrap unions your live PATH). If no
  provider CLI is installed at all, STOP and surface: the memory system needs
  at least one of claude / codex / cursor-agent (or an API key provider in
  `providers.chain`).
- **A tool of yours parsed compile's exit code** and treated non-zero as a
  crash → teach it exit 69 = "providers unavailable, work pending, retry
  later". The stderr breadcrumb on that path is exactly
  `compile.mjs: aborting (LLMProviderUnavailable): <detail>` (a wiki-store /
  Dify-bridge outage prints `WikiStoreUnavailable` in the parens instead —
  the emitted name is the error class's own).
- New issue reports under `.llm-wiki-memory/issues/<yyyy>/<mm>/<dd>/` named
  `<signature>.<version>.md` whose body mentions `system:compile-llm-providers`
  or `system:consolidate-llm-providers` → the new escalation signal doing its
  job. Fix provider availability; the next healthy tick flips the report to
  `status: resolved` on its own.
- The migration-era stop rule still applies: a bootstrap log line
  `[migrate-settings] failed: <message>` means the settings migration failed —
  bootstrap aborts before the defaults fallback; surface it.

VERIFICATION:

The upgrade is successful if and only if ALL of the following hold:

- `( cd .llm-wiki-memory/src && npm test )` is fully green.
- When step 2 found a scheduled job: the plist contains a `<key>PATH</key>`
  entry (macOS) or the wrapper contains an `export PATH=` line (Linux), and
  that PATH includes your provider CLI's directory.
- After one `cron-job`: the newest line of
  `.llm-wiki-memory/state/.consolidate-attempts.log` is valid JSON whose
  `compile.exit` is `0` — or `69` with `"ok":false` if your box genuinely has
  pending dailies and no reachable provider (see the DECISIONS fork; that
  state is expected-unhealthy, not a broken upgrade).
- `node .llm-wiki-memory/src/scripts/cli.mjs cron-health` returns
  `healthy:true` on a box with a working provider. (Expected-unhealthy boxes:
  `healthy:false` plus an `escalations` array naming
  `system:compile-llm-providers` after enough consecutive ticks.)
- The project repo (`git status` at the workspace root) gained no commits or
  staged changes from the memory system.

When all of the above hold, the upgrade is complete. Do NOT auto-commit / push /
open a PR — surface the change set to the user and let them gate the writes.

--- END PROMPT ---

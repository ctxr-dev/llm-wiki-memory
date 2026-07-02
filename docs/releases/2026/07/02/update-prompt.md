# llm-wiki-memory: recall-touch removed + consolidation is opt-in runbook (2026-07-02)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past the
**2026-07-02** release.

**WHO IS AFFECTED, read this first.** This release ships **two breaking changes**:

- **(breaking, behaviour + on-disk shape) The "recall-touch" instrumentation is removed
  entirely.** Searching / recalling a leaf no longer writes to it. Previously
  `searchMemoryFiltered` / `recallLessons` stamped `memory.last_recalled_at` and bumped
  `memory.recall_count` on every returned leaf (a write on read). That whole feature — the
  write path AND every code path that read those two fields (frontmatter normalisation,
  consolidate's staleness / orphan-prune / refresh passes) — is gone. Consequences:
  - The config keys `recall.touchEnabled` and `recall.touchMinHours` no longer exist, and the
    env vars `MEMORY_RECALL_TOUCH` / `MEMORY_RECALL_TOUCH_MIN_HOURS` are no longer mapped. If
    they appear in your `settings.yaml` / `.env` they are silently ignored (harmless).
  - New leaves never receive `last_recalled_at` / `recall_count`. Existing leaves that already
    carry those fields are **left untouched on disk** (inert; no code reads them). No migration
    rewrites your wiki.
  - Consolidate's staleness signal now keys off `frontmatter.updated` alone (it used to prefer
    `last_recalled_at`), and orphan-prune no longer protects "recently recalled" leaves (that
    signal no longer exists).
- **(breaking, default flip) Consolidation (a.k.a. reconciliation) is now OPT-IN and OFF by
  default.** A new master switch `consolidate.enabled` (default `false`) gates ALL
  consolidation in EVERY path — the hourly cron, `cli.mjs consolidate`, the MCP
  `consolidate_memory` tool, and the hook-less `consolidate` skill. `force` does not override
  it. Because the hourly cron exists to run this maintenance, the whole cron (`compile` +
  `consolidate`) also no-ops while the switch is off; `cli.mjs compile` run by hand is
  unaffected. **An install that previously ran consolidation will stop running it after this
  upgrade until you set `consolidate.enabled: true`.**

There is no data migration. The removed recall keys become no-ops; the new `consolidate.enabled`
key takes effect via its structural default (`false`). An install that keeps its existing
`settings.yaml` is fully covered — but consolidation will be off until you opt in.

## How to use this file

In a Claude Code (or any capable agent) session inside the target repo, do either:

- **Reference it:** "Fetch and follow the runbook at
  `https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/docs/releases/2026/07/02/update-prompt.md`,
  applying it to this project."
- **Paste it:** copy everything inside the `--- PROMPT ---` fence below.

If you want it run unattended, add: "I am AFK; go to the end without interruptions, take the
safe default for each decision, and surface anything that blocks instead of stalling."

--- PROMPT ---

Update this project's vendored llm-wiki-memory runtime to the latest upstream. Work
autonomously; only stop for the genuine decisions listed at the end.

WHAT'S NEW UPSTREAM (why this matters):

The 2026-07-02 release (1) removes the recall-touch instrumentation entirely — searching a
leaf no longer writes `last_recalled_at` / `recall_count` to it, and the `recall.touchEnabled`
/ `recall.touchMinHours` config + `MEMORY_RECALL_TOUCH*` env vars are gone — and (2) makes
consolidation opt-in behind a new `consolidate.enabled` flag that defaults to `false`, which
also stops the hourly maintenance cron until you turn it on.

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
   `git -C .llm-wiki-memory/src checkout -- .`, then retry. A genuine CONTENT divergence →
   surface it; never force.

2. Re-run the bootstrap (idempotent; re-renders the updated rules that no longer mention
   recall-touch into `.agents/rules`, `.claude/rules`, `.cursor/rules`, and re-runs the
   settings migration).
   ```
   ./.llm-wiki-memory/src/bootstrap.sh
   ```
   Expected log line: `Rendered shipped process rules to .agents/rules, .claude/rules, and .cursor/rules.`

3. Decide whether you want automatic consolidation (see DECISIONS). If yes, add the switch to
   `.llm-wiki-memory/settings/settings.yaml` under the `consolidate:` block:
   ```
   consolidate:
     enabled: true
   ```
   If you do NOT run consolidation, do nothing — it is off by default now.

4. (Optional, cosmetic) Remove the now-dead `recall.touchEnabled` / `recall.touchMinHours`
   lines from `.llm-wiki-memory/settings/settings.yaml` if present. They are ignored either
   way; deleting them just avoids confusion.

5. Run the test suite.
   ```
   ( cd .llm-wiki-memory/src && npm test )
   ```
   Expected: all tests pass (includes the new `consolidate-enabled` suite and the updated
   `normaliseMeta-memory-passthrough` / `settings` / `migrate-settings` / `consolidate-*`
   suites).

6. RESTART so the new code is live. The running MCP server is still the OLD code (it still
   has recall-touch and the old consolidate gate). On Claude Code, restart the session (or
   `/mcp` reconnect); other clients re-launch the server. Note: `wiki-store.mjs`, `recall.mjs`,
   and `consolidate.mjs` hot-reload in place, but `settings.mjs` and the entry file do not — a
   restart is required to pick up this release fully.

DECISIONS:

- `git merge --ff-only` fails on mode-only changes (`100755 → 100644`) → cloud-sync stripped
  the exec bit; safe fix is `git config core.fileMode false` + `git checkout -- .` + retry. A
  genuine CONTENT divergence → surface it; never force.
- Do you want automatic memory consolidation (dedup / merge / staleness) to keep running?
  - SAFE DEFAULT: leave it OFF (`consolidate.enabled` absent or `false`). Nothing reconciles;
    your wiki is never auto-modified by the cron.
  - To RESTORE the pre-upgrade behaviour, set `consolidate.enabled: true` in
    `settings.yaml`. The hourly cron then resumes compile + consolidate.
- An open consolidation escalation was reported before the upgrade → with consolidation off it
  will not self-clear; `cron-health` reports `healthy:true` with a `disabled` summary that
  still shows the open count. Enable consolidation (and let a tick run) to clear it, or ignore.

VERIFICATION:

The upgrade is successful if and only if:

- `( cd .llm-wiki-memory/src && npm test )` is fully green.
- The recall-touch feature is gone from the code:
  `grep -rE "last_recalled_at|recall_count|touchEnabled" .llm-wiki-memory/src/scripts .llm-wiki-memory/src/mcp-server`
  returns nothing (matches only appear in tests/docs, if at all).
- Recall is side-effect-free: run a `search_memory` for any existing leaf twice, then
  `git -C .llm-wiki-memory/wiki status --short` shows no working-tree change from the search.
- Consolidation reflects the switch:
  - With `consolidate.enabled` off → `node .llm-wiki-memory/src/scripts/cli.mjs consolidate --json`
    prints `{ "ok": true, "skipped": "disabled", ... }`, and
    `node .llm-wiki-memory/src/scripts/cli.mjs cron-health` prints a summary containing
    `consolidation disabled (consolidate.enabled=false)` with `"healthy": true`.
  - With `consolidate.enabled: true` → the same `consolidate --json` runs (no
    `"skipped":"disabled"`).
- The rendered `.agents/rules/memory-write-gate.md` no longer contains a "recall-touch
  instrumentation" bullet, and `.llm-wiki-memory/src/templates/settings.yaml` has
  `consolidate.enabled` and no `recall.touchEnabled` / `recall.touchMinHours`.
- The project repo (`git status` at the workspace root) gained no commits or staged changes
  from the memory system.

When all of the above hold, the upgrade is complete. Do NOT auto-commit / push / open a PR.
Surface the change set to the user and let them gate the writes.

--- END PROMPT ---

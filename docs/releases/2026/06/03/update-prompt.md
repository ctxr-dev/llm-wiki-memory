# llm-wiki-memory update runbook (2026-06-03)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install (a project that
already has `.llm-wiki-memory/src` cloned) to the current upstream, aligning the project with
the new functionality, and running a one-time wiki reconciliation with full stats.

**Target of this runbook:** bring an install up to the upstream `main` that includes the
per-category `consolidate: refine|none` layout field, the memory write-gate, the hourly
maintenance cron + cron-health, the AutoDream `consolidate`, and the consolidate DUP-ID fix
(PR #16). As of this runbook that is commit `23f8a09` or later.

## How to use this file

In a Claude Code (or any capable agent) session inside the target repo, do either:

- **Reference it:** "Fetch and follow the runbook at
  `https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/docs/releases/2026/06/03/update-prompt.md`,
  applying it to this project." (any pinned release folder works), or
- **Paste it:** copy everything inside the `--- PROMPT ---` fence below into the session.

If you want it run unattended, add: "I am AFK for several hours; go all the way to the end
without interruptions, take the safe default for each decision below, and surface anything
that blocks instead of stalling."

--- PROMPT ---

Update this project's vendored llm-wiki-memory runtime to the latest upstream and bring the
project fully in line with the new functionality, then run a one-time wiki reconciliation and
report full stats. Work autonomously; only stop for the genuine decisions listed at the end.

WHAT'S NEW UPSTREAM (why this matters): YAML-driven layout with a required per-category
`consolidate: refine|none` field, a memory write-gate (self_improvement saves need explicit
user confirmation), an hourly maintenance cron (compile + `consolidate --if-due`) with
cron-health logging, and the AutoDream `consolidate` (LLM dedup/merge/staleness-refresh/
archive). The current upstream main also contains a fix to a consolidate DUP-ID bug, so it is
safe to run consolidate AFTER updating. Do NOT run consolidate on the old runtime first.

KEY FACTS: `.llm-wiki-memory/src` is a gitignored, per-machine git clone of
github.com/ctxr-dev/llm-wiki-memory. It updates via `git pull` + re-running `bootstrap.sh`
(idempotent; it does NOT auto-commit, only edits .gitignore). Because src/ is gitignored, the
runtime update itself produces no parent-repo commit; only `.llm-wiki-memory/wiki/**` (if your
project commits it) and the wired config files commit. Use the gh CLI for any GitHub work, not
MCP github tools.

PROCEDURE:

0. Orient. Read `.agents/rules/` (memory discipline) and any project methodology. Run
   `git -C .llm-wiki-memory/src remote -v` and `... rev-parse HEAD`. Check whether
   `.llm-wiki-memory/wiki` is tracked (`git ls-files .llm-wiki-memory/wiki | head`) and that
   `.gitignore` already ignores src/, state/, index/, settings/.env.

1. Checkpoint. If the tree has pre-existing uncommitted wiki churn, stage ONLY the wiki
   (`git add .llm-wiki-memory/wiki`), review, and commit it as a baseline so later steps stay
   isolated. Keep stray top-level untracked files OUT: scope every `git add` to the wiki and
   named config files, never `git add -A`.

2. Update the runtime.
   git -C .llm-wiki-memory/src fetch origin
   git -C .llm-wiki-memory/src merge --ff-only origin/main   # must be a clean fast-forward
   ( cd .llm-wiki-memory/src && npm install --no-audit --no-fund )
   Verify @ctxr/skill-llm-wiki resolves. If the clone is too old to fast-forward, re-clone
   fresh into .llm-wiki-memory/src, then bootstrap.

3. Re-wire via bootstrap (idempotent).
   .llm-wiki-memory/src/bootstrap.sh --commit-memory --provider [auto] --schedule daily
   - Use --commit-memory ONLY if the wiki was already tracked (it keeps it tracked); omit it if
     your project intentionally gitignores the whole .llm-wiki-memory tree.
   - --schedule daily installs the new HOURLY maintenance cron (launchd on macOS, crontab on
     Linux); --schedule off removes it; omit --schedule to leave crons alone.
   - Provider auto-detects (claude CLI, codex, API keys, ollama); pass --provider to force.
   THEN diff-check what it touched: .gitignore must NOT gain a bare `/.llm-wiki-memory` line
   (that would untrack your wiki); confirm .claude/settings.json gained the new PreToolUse
   hooks with no duplicates; confirm it did NOT clobber a customized .layout/layout.yaml.

4. Align the layout (the one likely hand-edit). The new runtime requires every category in
   `.llm-wiki-memory/wiki/.layout/layout.yaml` to declare `consolidate: refine|none`. If your
   layout is the default template, bootstrap already added them. If it is a customized/diverged
   variant (bootstrap preserves it untouched), add the field yourself:
     knowledge -> refine, self_improvement -> refine,
     plans -> none, investigations -> none, daily -> none, any custom/issues category -> none.
   validate_layout does NOT enforce this, but consolidate refuses with
   `layout-missing-consolidate-field` if any category lacks it (the dry-run is the real gate).

5. Validate (use the CLI = fresh process = new code; the in-session MCP server is the OLD build
   until you restart the client).
   MEMORY_DATA_DIR=<abs>/.llm-wiki-memory  (set it for the commands below)
   ( cd .llm-wiki-memory/src && node scripts/cli.mjs validate-layout
     && node scripts/cli.mjs validate-topology && node scripts/cli.mjs validate )
   All must report 0 errors. If anything is off, run `node scripts/cli.mjs heal` to classify the
   state and name the next command.

6. One-time reconciliation: validate -> audit -> consolidate, done safely.
   a. MCP audit_memory({classes:["duplicate-error-pattern","missing-metadata"]}) and capture the
      list (no mutation).
   b. Capture BEFORE per-category file counts + bytes (find/wc over each category dir) on a clean
      tree.
   c. Commit the runtime-alignment changes (config + layout) as an isolated checkpoint, so the
      consolidate diff is pure.
   d. Dry-run: node scripts/cli.mjs consolidate --dry-run --force --json
      Confirm ok:true and NO `layout-missing-consolidate-field`. Inspect projected totals.
   e. Real run: node scripts/cli.mjs consolidate --force --json   # SAVE this JSON
   f. Capture AFTER counts, then run `node scripts/cli.mjs validate` again: it MUST be 0 errors.
      If it reports a DUP-ID or anything structural, STOP and surface it; do not commit a broken
      wiki. (Consolidate merges are lossy by design: keeper bodies are truncated to
      MEMORY_ATOM_BODY_MAX_CHARS; the full originals survive as `status: archived` superseded
      siblings.)
   g. Commit the consolidate result as its own isolated commit, scoped to .llm-wiki-memory/wiki.

7. Full stats report. Present: runtime provenance (old -> new commit), per-category
   before/after/delta, the consolidate totals (archived/merged/refreshed/flagged/touched/errors/
   freedBytes), per-pass breakdown, LLM health (llm vs llmRequested), the git diffstat of the
   isolated consolidate commit, and `cli.mjs cron-health`.

8. Verify end to end: src at the new commit; validate-layout/topology/validate clean; the cron
   job is installed and loaded (launchctl list | grep llm-wiki, or crontab -l); the write-gate +
   deny-path hooks are present in .claude/settings.json. Then restart the client so the new MCP
   server build + hooks load.

DECISIONS to confirm with the user (do not guess):
- Whether to commit the wiki/config changes, and where (straight to main vs branch + PR). In
  some projects the wiki git is local-only, so there is nothing to push.
- The cron schedule (hourly vs none).
- Whether consolidate should mutate now, or only dry-run + report first.

Stop and surface any structural validation failure (e.g. a DUP-ID) rather than committing a
broken wiki; the consolidate DUP-ID bug is fixed in the current upstream, so updating BEFORE
consolidating avoids it.

--- END PROMPT ---

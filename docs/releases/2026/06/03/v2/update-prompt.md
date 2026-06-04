# llm-wiki-memory settings-restructure runbook (2026-06-03 v2)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install (a project
that already has `.llm-wiki-memory/src` cloned) past the **breaking 2026-06-03 v2**
release that moved nearly every `MEMORY_*` env var into a new canonical
`<data>/settings/settings.yaml`.

**Target of this runbook:** bring an install up to the upstream `main` that contains:

- Strict `.env` (secrets + provider switches + paths + test seams only) +
  canonical `settings/settings.yaml` (consolidate / flush / hook / embed /
  recall / compile / gc / gate / providers).
- **Breaking change:** every `MEMORY_*` env var that is NOT on the strict
  allow-list is now SILENTLY IGNORED. The list of removed env vars is below.
- A new shipped rule `releases-docs.md` enforcing that every breaking release
  ship a runbook (this very file is the canonical example).
- Workspace-canonical `planning-methodology.md` — the package no longer ships
  its own copy; the workspace's `.agents/rules/planning-methodology.md` is the
  single source of truth, with `.claude/rules/` and `.cursor/rules/` as symlinks.

## How to use this file

In a Claude Code (or any capable agent) session inside the target repo, do either:

- **Reference it:** "Fetch and follow the runbook at
  `https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/docs/releases/2026/06/03/v2/update-prompt.md`,
  applying it to this project."
- **Paste it:** copy everything inside the `--- PROMPT ---` fence below into the session.

If you want it run unattended, add: "I am AFK for several hours; go all the way to
the end without interruptions, take the safe default for each decision below, and
surface anything that blocks instead of stalling."

--- PROMPT ---

Update this project's vendored llm-wiki-memory runtime to the latest upstream and
migrate the install onto the new `settings.yaml` layout. Work autonomously; only
stop for the genuine decisions listed at the end.

WHAT'S NEW UPSTREAM (why this matters):

The 2026-06-03 v2 release introduces a strict `.env` / canonical `settings.yaml`
split. Every application-config knob that used to be a `MEMORY_*` env var is now
a YAML key under `<data>/settings/settings.yaml`. **Setting the removed env vars
at the shell is now a SILENT no-op.** The strict subset that REMAINS in `.env`:
API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), provider switches
(`MEMORY_LLM_PROVIDER`, `MEMORY_LLM_MODEL`, `MEMORY_LLM_BASE_URL`,
`MEMORY_LLM_TIMEOUT_MS`, `ANTHROPIC_MODEL`, `OPENAI_MODEL`), deployment paths
(`MEMORY_DATA_DIR`, `LLM_WIKI_MEMORY_ROOT`, `MEMORY_SETTINGS_PATH`,
`MEMORY_EMBED_CACHE`, `MEMORY_EMBED_CACHE_DIR`), workspace identity
(`MEMORY_DEFAULT_PROJECT_MODULE`, `LLM_WIKI_MEMORY_PROJECT`), test seams
(`MEMORY_LLM_MOCK_*`), and MCP server identity (`MEMORY_MCP_SERVER_NAME`).

The migration is automatic on `bootstrap.sh` re-run: it backs up the old `.env`
to `.env.bak`, writes the new `settings.yaml` with every removed env var's value
carried forward, and shrinks `.env` to the strict subset. It also merges the old
`<data>/settings/llm.yaml` (provider/model chain from the previous release) into
the new `settings.yaml` and removes the stale file.

**Caveat — comments are not carried forward.** The rewritten `.env` keeps only
strict-subset `KEY=VALUE` pairs under a fresh header; any inline comments or
annotations you added next to REMOVED keys in the old `.env` are not migrated to
either `.env` or `settings.yaml`. They survive only in `.env.bak` (a
byte-identical copy of the original). If you keep documented `.env` files, copy
any notes you still want into `settings.yaml` (which is YAML — comment freely).

Removed `MEMORY_*` env vars (any of these in YOUR shell rc / CI config / Dockerfile
will need to move into `<data>/settings/settings.yaml` under the matching section):

- consolidate.*: `MEMORY_CONSOLIDATE_INTERVAL_DAYS`, `_COSINE_THRESHOLD`,
  `_COSINE_LEXICAL_THRESHOLD`, `_CLUSTER_TOP_K`, `_CLUSTER_SCORE_THRESHOLD`,
  `_ORPHAN_TTL_DAYS`, `_STALE_AFTER_MONTHS`, `_ARCHIVE_BODY_MAX`,
  `_ARCHIVE_AGE_DAYS`, `_PASSES`, `_LLM_PASSES`, `_LLM_MAX_RETRIES`,
  `_REFRESH_MAX_PER_RUN`.
- flush.*: `MEMORY_FLUSH_SLOT`, `_DISTILL_ATTEMPTS`, `_DISTILL_RETRY_MS`,
  `_LOCK_STALE_MS`, `_CHUNK_TARGET_K`, `_CHUNK_PARALLELISM`,
  `_REDUCE_MAX_CHARS`, `_RAW_FALLBACK_CHARS`.
- hook.*: `MEMORY_HOOK_MAX_TURNS`, `_MAX_CHARS`, `_SESSION_END_MIN_TURNS`,
  `_PRECOMPACT_MIN_TURNS`, `_EXITPLANMODE_DISABLE`, `_EXITPLANMODE_MAX_BYTES`.
- embed.*: `MEMORY_EMBED_BACKEND`, `MEMORY_EMBED_MODEL`.
- recall.*: `MEMORY_RECALL_TOUCH`, `MEMORY_RECALL_TOUCH_MIN_HOURS`,
  `MEMORY_RECALL_SCORE_THRESHOLD`.
- compile.*: `MEMORY_COMPILE_SLOT`, `_SEARCH_LIMIT`, `_QUALITY_STRICT`,
  `_LOCK_STALE_MS`, `_METADATA_RETRY_LIMIT`, `MEMORY_ATOM_BODY_MAX_CHARS`.
- gc.*: `MEMORY_GC_INTERVAL_DAYS`.
- gate.*: `MEMORY_WRITE_GATE_SELF_IMPROVEMENT`.
- workspace-wide: `MEMORY_CROSS_CUTTING_AREAS`.
- renamed: `MEMORY_LLM_CONFIG_PATH` → `MEMORY_SETTINGS_PATH`.

Two related changes ship in the same release:

- `templates/llm.yaml` is gone (its content is now part of `settings.yaml`).
  `<data>/settings/llm.yaml` is removed by the migrator on re-run.
- `planning-methodology.md` is no longer shipped by the package (it's
  workspace-specific). Future installs of llm-wiki-memory won't render this
  file. Existing installs keep their workspace copy at `.agents/rules/` and the
  bootstrap converts the `.claude/rules/` and `.cursor/rules/` clones to
  symlinks pointing at the canonical workspace file (Linux/Darwin only;
  Windows shells keep hard copies and get a stderr warning).

PROCEDURE:

0. Orient. Read `.agents/rules/` (memory + release discipline) and any project
   methodology. Run `git -C .llm-wiki-memory/src remote -v` and
   `... rev-parse HEAD`. Check `.gitignore` already ignores
   `.llm-wiki-memory/src/`, `.llm-wiki-memory/state/`, `.llm-wiki-memory/index/`,
   `.llm-wiki-memory/settings/.env` (and now `.llm-wiki-memory/settings/.env.bak`).

1. Checkpoint. If the tree has uncommitted wiki churn, stage ONLY the wiki
   (`git add .llm-wiki-memory/wiki`) and commit it as a baseline before the
   upgrade so later steps stay isolated. Scope every `git add` to the wiki and
   named config files; never `git add -A`.

2. Update the runtime.
   ```
   git -C .llm-wiki-memory/src fetch origin
   git -C .llm-wiki-memory/src merge --ff-only origin/main   # clean fast-forward
   ( cd .llm-wiki-memory/src && npm install --no-audit --no-fund )
   ```
   Must be a clean fast-forward. If not, surface the divergence to the user.

3. Run the bootstrap (auto-migrates `.env` + `llm.yaml` → `settings.yaml`).
   ```
   .llm-wiki-memory/src/bootstrap.sh
   ```
   Expected log lines (exact strings, for `grep`-ing the bootstrap output):
   - `[migrate-settings] migrated MEMORY_FOO → settings.yaml: section.key` per
     removed env var that was set in the OLD `.env`.
   - `[migrate-settings] wrote <abs path>/settings.yaml; .env shrunk to N strict
     key(s); backup at <abs path>/.env.bak` (the migrator writes the canonical
     file; on an upgrade bootstrap then logs `Kept existing ...settings.yaml`
     because the migrator already created it).
   - `Wired workspace-canonical rules into .claude/rules and .cursor/rules
     (symlinks; N updated).` (Linux/Darwin only.)

4. Verify the migration.
   ```
   # The strict subset only.
   cat .llm-wiki-memory/settings/.env

   # The new canonical config.
   cat .llm-wiki-memory/settings/settings.yaml | head -40

   # Backup of the original .env (audit trail).
   ls -la .llm-wiki-memory/settings/.env.bak

   # The old llm.yaml is gone.
   ls .llm-wiki-memory/settings/llm.yaml 2>/dev/null || echo "old llm.yaml removed (expected)"

   # cron-health: still green.
   node .llm-wiki-memory/src/scripts/cli.mjs cron-health

   # where: the LLM provider is still detected.
   node .llm-wiki-memory/src/scripts/cli.mjs where | head -20
   ```
   `.env` must contain ONLY the strict-subset keys. `settings.yaml` must contain
   every value from the OLD `.env`'s removed keys under its matching section.
   `.env.bak` must be byte-identical to the pre-bootstrap `.env`.

5. Run the test suite to confirm the in-process runtime is healthy.
   ```
   ( cd .llm-wiki-memory/src && npm test )
   ```
   Expected: all tests pass. If any fail, the migration is incomplete; surface
   the failure to the user before continuing.

6. Sweep the project's own configuration for stale env var references.
   Search for any of the removed `MEMORY_*` env vars in CI/CD pipelines,
   Dockerfiles, shell rc files, deployment scripts, and project documentation.
   Move each one into `.llm-wiki-memory/settings/settings.yaml` at its matching
   section. Leave the strict-subset env vars alone (they STILL work).

   ```
   git grep -nE 'MEMORY_(CONSOLIDATE|FLUSH|HOOK|EMBED_(BACKEND|MODEL)|RECALL|COMPILE|GC|ATOM_BODY|WRITE_GATE|CROSS_CUTTING|LLM_CONFIG_PATH)' || echo "no stale references"
   ```

DECISIONS:

The migration is automatic and idempotent — there are no genuine forks under
normal operation. If you encounter ANY of these, stop and ask the user:

- `git merge --ff-only origin/main` fails (working tree has divergence) →
  surface; do NOT force-merge.
- The migration logs `[migrate-settings] failed: <message>` → the YAML write
  failed. Bootstrap now aborts non-zero before the `settings.yaml` defaults
  fallback, so you never silently run on default config; your OLD `.env` is
  left intact (the `.env.bak` backup is written first). Surface the message,
  fix the cause, and re-run bootstrap — do NOT hand-create `settings.yaml`.
- `cron-health` reports `healthy:false` after the upgrade → surface; do NOT
  swallow.
- `npm test` reports failures → surface with the first failing test name. Do
  NOT continue to verification step 6.

VERIFICATION:

The migration is successful if and only if ALL of the following hold:

- `.llm-wiki-memory/settings/.env` contains ONLY strict-subset keys
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_MODEL`, `OPENAI_MODEL`,
  `MEMORY_LLM_PROVIDER`, `MEMORY_LLM_MODEL`, `MEMORY_LLM_BASE_URL`,
  `MEMORY_LLM_TIMEOUT_MS`, `MEMORY_DATA_DIR`, `LLM_WIKI_MEMORY_ROOT`,
  `MEMORY_SETTINGS_PATH`, `MEMORY_EMBED_CACHE`, `MEMORY_EMBED_CACHE_DIR`,
  `MEMORY_DEFAULT_PROJECT_MODULE`, `LLM_WIKI_MEMORY_PROJECT`,
  `MEMORY_LLM_MOCK_*`, `MEMORY_MCP_SERVER_NAME`).
- `.llm-wiki-memory/settings/settings.yaml` exists with the nine nested config
  sections (`consolidate`, `flush`, `hook`, `embed`, `recall`, `compile`,
  `gc`, `gate`, `providers`) plus the top-level `crossCuttingAreas` list.
- `.llm-wiki-memory/settings/.env.bak` exists and matches the pre-bootstrap
  `.env` byte-for-byte.
- `.llm-wiki-memory/settings/llm.yaml` does NOT exist.
- `.agents/rules/releases-docs.md`, `.claude/rules/releases-docs.md`, and
  `.cursor/rules/releases-docs.md` all exist (new shipped rule).
- On Linux/Darwin: `.claude/rules/planning-methodology.md` and
  `.cursor/rules/planning-methodology.md` are symlinks pointing at
  `../../.agents/rules/planning-methodology.md` (use `ls -la` to verify).
- `node .llm-wiki-memory/src/scripts/cli.mjs cron-health` reports
  `healthy:true`.
- `( cd .llm-wiki-memory/src && npm test )` is fully green.

When all of the above hold, the migration is complete. Commit the wiki churn
(if any), the modified config files, and any project-side updates from step 6.
Do NOT auto-commit / push / open a PR — surface the change set to the user and
let them gate the writes (per the standing `feedback_no_auto_commit_push_pr`
rule).

--- END PROMPT ---

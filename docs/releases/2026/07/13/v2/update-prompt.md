# llm-wiki-memory: project_module is now a deterministic identity (org/repo or file://) (2026-07-13 v2)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past the
**2026-07-13 v2** release. This stacks on top of the same-day v1 (the nested MCP wire) — apply
v1 first if you have not.

**WHO IS AFFECTED, read this first.** This release changes how the workspace identifier
`project_module` is DERIVED. It is a **behavioural break for installs WITHOUT an explicit
`MEMORY_DEFAULT_PROJECT_MODULE` (or `LLM_WIKI_MEMORY_PROJECT`) override**:

- **(breaking, default flip) `project_module` is no longer the directory basename.** It is now a
  stable, deterministic identity:
  - a git repo → its canonical **`<org>/<repo>`** (host- and protocol-agnostic: `git@host:org/repo.git`
    and `https://host/org/repo.git` fold to the same `org/repo`, so ssh/https clones of the same
    repo collapse to ONE identity and centralise);
  - a non-repo folder → **`file://<absolute-path>`** (so two folders sharing a basename stay distinct).
  - Nested repo mounts stamp the full ordered chain `outer//inner` (e.g. `acme/parent//acme2/child`);
    recall suffix-matches on the innermost segment, so clones still gather while nesting stays queryable.
- **Why this matters for recall.** Default-scoped recall/search inject this workspace identity as
  the `project_module` filter. Existing leaves were stamped with the OLD basename, so on an install
  where the identity NOW resolves differently (a git repo whose basename ≠ `org/repo`, or a folder
  now rendered as `file://…`), **default recall will miss pre-existing memory until the leaves are
  re-stamped.** A one-shot migration (`migrate-identity`) fixes this; it is the required step below.
- **NOT affected:** an install that sets `MEMORY_DEFAULT_PROJECT_MODULE` (or `LLM_WIKI_MEMORY_PROJECT`)
  — the explicit override STILL wins, so its `project_module` value is unchanged and no migration is
  needed (the migration self-detects this and no-ops with `reason:"identity-unchanged"`).
- **On-disk shape:** only the VALUE of `project_module` in leaf frontmatter changes; it remains a
  frontmatter-only field (never a placement path segment), so no leaf relocates.

**Shared-repo writes.** A write TARGETED at a repo-owned level now stamps that repo's chain identity
(`org/repo`, or `file://` fallback) instead of the brain default — so a shared-repo leaf carries the
repo's portable identity. A brain write is unchanged (keeps the workspace default). A caller's
explicit `project_module_override` still wins.

## How to use this file

In a Claude Code (or any capable agent) session inside the target repo, do either:

- **Reference it:** "Fetch and follow the runbook at
  `https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/docs/releases/2026/07/13/v2/update-prompt.md`,
  applying it to this project."
- **Paste it:** copy everything inside the `--- PROMPT ---` fence below.

If you want it run unattended, add: "I am AFK; go to the end without interruptions, take the
safe default for each decision, and surface anything that blocks instead of stalling."

--- PROMPT ---

Update this project's vendored llm-wiki-memory runtime to the latest upstream. Work
autonomously; only stop for the genuine decisions listed at the end.

WHAT'S NEW UPSTREAM (why this matters):

The 2026-07-13 v2 release makes `project_module` a deterministic identity: a git repo →
canonical `org/repo`; a non-repo folder → `file://<abs-path>`; nested repos → an `outer//inner`
chain. Default recall/search scope by this identity. If your install did NOT set
`MEMORY_DEFAULT_PROJECT_MODULE`, existing leaves carry the OLD basename identity and default
recall will miss them until you re-stamp them with the one-shot `migrate-identity`. If you DID
set the env override, nothing changes (the override wins) and the migration no-ops.

PROCEDURE:

1. Update the runtime (same triplet as v1; skip if v1 already fast-forwarded to a ref that
   includes v2).
   ```
   git -C .llm-wiki-memory/src fetch origin
   git -C .llm-wiki-memory/src merge --ff-only origin/main
   ( cd .llm-wiki-memory/src && npm install --no-audit --no-fund ) ; echo "npm install exit=$?"
   ```
   Clean fast-forward AND `npm install exit=0`. Mode-only (`100755 → 100644`) `--ff-only`
   failures → `git -C .llm-wiki-memory/src config core.fileMode false` + `checkout -- .` + retry.
   A genuine CONTENT divergence → surface it; never force.

2. Re-run the bootstrap (idempotent).
   ```
   ./.llm-wiki-memory/src/bootstrap.sh
   ```

3. See what your identity resolves to now, and whether any leaf is on the legacy id.
   ```
   node .llm-wiki-memory/src/scripts/cli.mjs where
   node .llm-wiki-memory/src/scripts/cli.mjs migrate-identity --check ; echo "check exit=$?"
   ```
   - `check exit=0` with `pending:0` (or `reason:"identity-unchanged"`) → nothing to migrate
     (you have an env override, or every leaf already carries the new id). Skip step 4.
   - `check exit=3` with `pending>0` → some leaves still carry the legacy basename id; do step 4.

4. Preview, then run the one-shot re-stamp (idempotent; a re-run is a clean no-op).
   ```
   node .llm-wiki-memory/src/scripts/cli.mjs migrate-identity --dry-run
   node .llm-wiki-memory/src/scripts/cli.mjs migrate-identity ; echo "migrate exit=$?"
   ```
   The re-stamp preserves every other frontmatter field (priority/area/subject); it only rewrites
   `project_module`, pinned in place (no relocation). One wiki commit (a no-op outside a git wiki).

5. Run the test suite.
   ```
   ( cd .llm-wiki-memory/src && npm test )
   ```
   Expected: all tests pass.

DECISIONS:

- Do I need the migration at all? Run `migrate-identity --check`. `pending:0` /
  `identity-unchanged` → NO (env override, or already migrated). `pending>0` → YES. SAFE DEFAULT:
  run it — it is idempotent and only touches leaves still on the legacy basename id.
- A deliberate cross-project leaf (its `project_module` is neither the old basename nor the new
  identity) is LEFT ALONE by the migration — this is intended. If you want it re-homed, re-save it
  explicitly; the migration will not touch it.
- A repo mount with no git origin and no `project_id` resolves to `file://<abs-path>` (machine-local)
  and is SURFACED as a non-portable identity. To give such a mount a portable, shareable id, declare
  `project_id: <org>/<repo>` at the top of its `.layout/layout.yaml` (it wins over git/file).

VERIFICATION:

The upgrade is successful if and only if:

- `( cd .llm-wiki-memory/src && npm test )` is fully green.
- `node .llm-wiki-memory/src/scripts/cli.mjs migrate-identity --check` exits 0 (`pending:0` or
  `reason:"identity-unchanged"`) — no leaf remains on the legacy basename identity.
- A default-scoped recall for a topic you know is in memory returns its pre-existing leaves (they
  match the new default identity filter after the re-stamp).
- The project repo (`git status` at the workspace root) gained no commits or staged changes from
  the memory system.

When all of the above hold, the upgrade is complete. Do NOT auto-commit / push / open a PR.
Surface the change set to the user and let them gate the writes.

--- END PROMPT ---

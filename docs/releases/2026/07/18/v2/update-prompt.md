# llm-wiki-memory: durable sync-queue + post-git index rebuild (2026-07-18 v2)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past the
**2026-07-18 v2** release. Apply the 2026-07-18 (v1) release first if you have not.

**WHO IS AFFECTED — anyone using a SHARED (`ownership: repo`) team wiki.** The git
sync hook now also rebuilds the `index.md` navigation tree (not just embeddings),
and both run through a durable job queue. It stays fully detached — it never blocks
your git operations. There is a **new native dependency** (`better-sqlite3`), so
the update rebuilds it at `npm install`.

## WHAT'S NEW

- **(hooks) the post-git sync now rebuilds the `index.md` tree too.** On
  `git pull` / checkout / rebase, the sync-embeddings hook warms the shared-category
  vectors AND (re)builds the gitignored `index.md` nav tree — creating the missing
  files on a fresh clone (`indexRebuildAll` refreshes existing indexes; `ensureIndexes`
  creates the gaps). This keeps the browsable/tree-walkable structure current when
  leaves arrive by git rather than by a local write.
- **(infra) a durable, coalescing job queue** backs that work
  (`<data>/state/sync-queue.sqlite`, better-sqlite3). Jobs are detail-less per wiki:
  at most one PENDING per wiki (rapid branch-switching coalesces) plus at most one
  PROCESSING. The firing hook self-drains under row-level leasing, so a run killed
  mid-way is reclaimed and retried on the next fire — nothing is lost, nothing piles
  up. Still **detached + best-effort**: it never blocks or fails a git op.
- **(dependency) `better-sqlite3`** is a new runtime dependency — the tool's first
  DIRECT native addon (it already pulled in `sharp` transitively via the embedder).
  `npm install` fetches its prebuilt binary (or builds it).
- **(fallback) graceful degradation.** If `better-sqlite3` can't load on a platform,
  the hook runs the refresh **directly** (no queue) instead of failing. Lazy-embed at
  search + next-write index rebuild remain the correctness net.
- **(escape hatch) `LWM_SYNC_NO_QUEUE=1`** disables the queue (direct runs);
  `LWM_SYNC_QUEUE_PATH` overrides the DB location. Neither is normally needed.

## PROCEDURE

1. Standard update against the runtime clone (this rebuilds the native module):
   ```
   cd ~/.llm-wiki-memory/src
   git fetch origin && git merge --ff-only origin/main && npm install
   ```
   Watch for a `better-sqlite3` build/prebuild line during `npm install`.
2. **RESTART your MCP client** so the server + hooks reload.
3. **No data migration.** The queue DB self-creates on first use; `index.md` is
   gitignored and regenerated locally, so nothing to migrate. On your next pull into
   a shared repo, the hook builds any missing indexes.

## DECISIONS

- **`better-sqlite3` won't build on this platform?** The hook auto-falls-back to a
  direct (no-queue) run — the feature degrades, it does not break. If you want to
  force that, set `LWM_SYNC_NO_QUEUE=1`. To confirm it built:
  `node -e "new (require('better-sqlite3'))(':memory:').close(); console.log('ok')"`.
- **Don't want the index rebuild on pull?** It's part of the same detached hook and
  never blocks git; there is no separate toggle beyond disabling the whole hook
  (`LWM_SYNC_NO_QUEUE=1` still warms/indexes directly — it only bypasses the queue).

## VERIFICATION

- `npm test` (in the src clone) is green, including `test/sync-queue.test.mjs`,
  `test/sync-embeddings.test.mjs`, and `test/e2e/federation-sync-queue.e2e.test.mjs`.
- After a `git pull` into a shared mount, the shared category has a `.embeddings/`
  cache AND an `index.md` at each dir (create-missing on a fresh clone).
- `<data>/state/sync-queue.sqlite` exists after a hook fire and drains to empty
  (no orphaned jobs): the job completed.
- Git operations are not slowed — the hook is detached and returns instantly.
- `node scripts/cli.mjs doctor` is clean; `npm run gates` is green.

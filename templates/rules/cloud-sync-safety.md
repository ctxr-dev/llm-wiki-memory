# Cloud-sync safety (Drive / Dropbox / iCloud / OneDrive)

Applies when this workspace (or its `.llm-wiki-memory/` runtime) lives on a
**cloud-synced mount**. A sync daemon can asynchronously **relocate, revert, or
half-replicate files mid-session**, and it rewrites file metadata the engine and
git depend on. The wiki's own **git repo is the source of truth**, not the live
filesystem — every leaf write is an atomic write-new-then-remove-old precisely so
a partially-replicated move can't lose data.

Observed failure modes (each cost a real recovery):

| Symptom | Cause | Guard |
|---|---|---|
| Notes from sub-folders reappear at a category root | daemon "flattens" a move it replicated out of order | commit per step; `git checkout HEAD -- <nested>` + remove the stray |
| `git merge --ff-only` fails on files that changed mode `100755 → 100644` | daemon strips the executable bit from `.sh` / hook scripts | `git config core.fileMode false`, then `git checkout -- .` and retry |
| `.claude/` rules became plain copies that drift from `.agents/rules/` | daemon turned the rule symlinks into independent files | edit all surfaces, or re-run `bootstrap.sh` to re-render |
| A leaf is truncated or NUL-padded | a write replicated mid-flight | recover from git (`git reset --hard HEAD`) |

## Rules

- **Pause sync before any structural change** (moving/renaming notes,
  sub-foldering, bulk edits, migrations, a `bootstrap.sh` re-run). Re-enable
  after, so the daemon syncs the *final* state instead of fighting an
  in-progress one.
- **Commit after each step.** A committed state is the anchor; recovery from a
  scramble is then `git reset --hard HEAD` (or `git checkout .`). Without a
  commit, the correct state may exist nowhere.
- **Re-audit before committing:** `git status --short --no-renames` and
  reconcile every add/delete against your intended change — the daemon's moves
  masquerade as renames under default `git status`. An add at a category root
  paired with a delete from a nested folder is a sync stray: confirm it's
  byte-identical to HEAD (only engine recall-touch frontmatter should differ),
  restore with `git checkout HEAD -- <nested>`, and remove the stray.
- **Run the health scan after any suspected sync event:**
  `node .llm-wiki-memory/src/scripts/cli.mjs doctor` (read-only; exits non-zero
  and lists broken index refs / stray leaves / orphans).
- **Keep the executable bit honest.** Cloud daemons drop it from shell scripts,
  which breaks `--ff-only` merges and hook execution. Set
  `git config core.fileMode false` in the `src/` clone so mode-only changes stop
  blocking updates; if a hook silently stops firing, check `ls -l` for a lost
  `+x`.
- **Symlinks break.** The rule mirrors (`.agents/rules/` canonical →
  `.claude/`/`.cursor/` symlinks) are turned into independent copies. Edit every
  copy, or re-run `bootstrap.sh` to re-sync.
- **Never trust the daemon's file moves.** The engine's atomic write path
  survives a partial replication; a manual `mv` during active sync does not.

## Why the wiki repo has no remote

`<workspace>/.llm-wiki-memory/wiki` is private memory data: its git repo has **no
remote by design** (never add one). Recovery is always *local* — the commit
history in that repo, plus `git reset --hard HEAD`. The cloud mount is a
convenience for the human's notes, not a backup of record; the git history is.

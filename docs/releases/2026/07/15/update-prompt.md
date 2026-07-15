# llm-wiki-memory: the engine NEVER runs git on a shared (repo-owned) wiki (2026-07-15)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past the
**2026-07-15** release. Apply the 2026-07-13 (v1 nested wire, v2 identity, v3
reference-only install) and 2026-07-14 (required `target`) releases first if you
have not.

**WHO IS AFFECTED — anyone running a SHARED (repo-owned) team wiki, or a
mis-installed one that accidentally has a `.git` at its wiki root.** This release
makes "the engine never uses git on a shared wiki" a HARD, deterministic guarantee.

- **(breaking, safety) `gitUsable()` now hard-refuses any wiki whose layout
  declares an `ownership: repo` category.** Such a wiki IS a shared/team mount, and
  the engine must never `git add` / `commit` / `gc` it — the human commits the
  shared knowledge with their own git. This sits above the old structural probe, so
  even a **stray `.git` accidentally sitting at a shared wiki root** (e.g. a `repo`
  template that was installed WITHOUT `--commit-memory`, or a private wiki later
  shared) can no longer make the engine commit it. The previously-emergent
  behaviour (a mixed wiki auto-committing its `ownership: wiki` categories while
  dropping the shared ones) is gone — a wiki that declares ANY shared category is
  now committed by nobody but you.
- **(install) `bootstrap.sh` auto-detects a shared wiki** (its layout declares an
  `ownership: repo` category): it never seeds a standalone `wiki/.git` for one,
  removes any stray one it finds, and keeps the wiki git-tracked on EVERY re-run
  (with or without `--commit-memory`) — so a bare re-run can never silently
  un-track a shared team wiki.
- **`--commit-memory` un-ignores the wiki so the host repo can TRACK it** (you
  commit it). It never committed anything itself; the name is about tracking, not
  committing. It is only needed the first time you turn a wiki into a shared one;
  a shared layout is auto-detected on every later run.
- **No wiki DATA migration.** The private brain is unaffected (it declares no
  `ownership: repo` category, so it still auto-commits normally). No on-disk leaf
  format changes.

## How to use this file

In a Claude Code (or any capable agent) session inside the target repo, do either:
run the standard update (fetch → ff-merge → npm install → re-run bootstrap), then
follow the PROCEDURE below to reconcile any shared repo.

## PROCEDURE

1. Standard update of the runtime clone: `git -C .llm-wiki-memory/src fetch origin`,
   read any newer `docs/releases/**/update-prompt.md` oldest-first, `merge --ff-only`,
   `( cd .llm-wiki-memory/src && npm install --no-audit --no-fund )`.
2. **A SHARED team wiki is auto-detected** (its layout declares an `ownership:
   repo` category) on ANY `bootstrap.sh` re-run: it stays git-tracked, gets no
   standalone `wiki/.git`, and its sync hooks are re-provisioned. A bare re-run is
   safe — it does NOT revert a shared wiki to private, and you do not need to
   re-pass `--commit-memory`. (`--commit-memory` is only for the first conversion
   of a private wiki to shared.)
3. **A private brain** re-runs with a bare `./.llm-wiki-memory/src/bootstrap.sh`,
   unchanged.

## DECISIONS

- **A stray `wiki/.git` was silently making the engine auto-commit a shared wiki?**
  It no longer can (the guard refuses regardless), and bootstrap removes it. The
  standalone auto-commit history in that stray repo is dropped; the wiki DATA is
  preserved. This is the intended, safe end state.
- **A mixed wiki (both `ownership: repo` and `ownership: wiki` categories)?** The
  engine now commits NONE of it. Put personal notes in the mount's separate
  `personal/` git (which is untouched by this change); commit shared knowledge to the
  host repo yourself.
- **Want the old behaviour back?** There is no opt-out — "the engine never touches a
  shared repo's git" is a safety invariant, not a tunable.

## VERIFICATION

- A shared save leaves its leaf **untracked** in the host repo (`git status` shows
  `?? .llm-wiki-memory/…`); the engine created no commit and no `wiki/.git`.
- `find .llm-wiki-memory/wiki -name .git` returns nothing for a shared wiki.
- Your private brain still auto-commits (its own `~/.llm-wiki-memory/wiki/.git`
  advances on a brain save) — the guard is specific to shared/repo-owned wikis.
- The engine's git-safety e2e passes:
  `( cd .llm-wiki-memory/src && node --test test/e2e/federation-git-safety.e2e.test.mjs )`.

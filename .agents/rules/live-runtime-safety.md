# Live-runtime safety — the tree you are editing IS the running system

`.llm-wiki-memory/src` is not a checkout that gets built and deployed. Nothing copies it, nothing
pins a version: the MCP server, every Claude Code hook worker, and the hourly cron load modules
straight out of this working tree at the moment they run. An edit ships the instant it hits disk,
into processes nobody started and nobody can see.

**Severity: P0 — a hard constraint, not a default.** The most severe rule in this repo, and it
GOVERNS ON CONFLICT: where another rule's convenience — iterate faster, verify against the real
thing, ship the edit now — collides with this one, this one wins. Every other invariant here
protects data from a bug; this one protects it from the act of editing.

## Do this — the whole rule in six lines

1. BEFORE editing anything hooks or cron execute: capture the baseline for what it can touch
   (table below; `.agents/skills/verify-live-change.md` step 1).
2. Sequence edits so every intermediate state stays importable — a hook may start mid-edit.
3. AFTER: re-capture the baseline and diff it; then `node scripts/cli.mjs warm` (expect
   `"embedded": 0`) and `node scripts/cli.mjs doctor` (expect `"ok": true`).
4. Anything drifted → full re-warm. Never verify against the real brain when a temp workspace
   answers the same question.

The rest of this file is why each step exists, and what to do when one fails.

## What is live right now

- **MCP server** — `node <src>/mcp-server/index.mjs`, long-running, one process per client. It
  holds parsed module state across every tool call (the embed backend state machine, the cache
  memo), so it can be running last week's semantics against today's files.
- **Hook workers** — SessionStart / SessionEnd / PreCompact / PostCompact / PostToolUse /
  PreToolUse all shell into `<src>/scripts/hooks/*.sh`, which `node` a module in this same tree.
  They spawn on the USER's activity, not yours; mid-edit is a normal time for one to start.
- **Scheduler** — the installed job runs `<src>/scripts/cli.mjs cron-job` hourly (compile /
  consolidate / warm), building a fresh module graph from whatever is on disk at that tick.

## The incident that grounds this rule (2026-08-02)

- Embedding-path modules were edited in place while hooks kept firing. A worker that spawned
  mid-edit imported a transiently inconsistent module graph and resolved the lexical backend
  although `embed.backend: transformers` was configured.
- The magnitude of the loss, and the deleted-guard half of the story, are recorded once in
  `.agents/rules/defensive-invariants.md`. What belongs HERE is the mechanism below.
- The loss mechanism is ordinary correct code acting on a false premise: `loadCache` rejects a
  stamp-mismatched cache and returns an EMPTY map; the caller then embeds only the leaves that
  one read happened to touch (a search cold-embeds at most `embed.maxColdPerRead`, default 32);
  `saveCache` writes back exactly those. Everything untouched is gone; a category with no touched
  leaf persists `{}`.
- It was caught ONLY because a stamp+count snapshot predated the work. Nothing else would have
  reported it: recall keeps answering, just worse.
- The check that would have refused the overwrite had been deleted as provably-dead code — see
  `.agents/rules/defensive-invariants.md` for that half of the lesson.

## Know which artefact you are risking — ceremony scales with recoverability

- **IRREPLACEABLE — wiki leaves** (`<data>/wiki`). Git-backed with NO REMOTE by design: that
  repo's local history is the only backup there is. Engine writes auto-commit
  (`wiki.autoCommit`, via `withWikiCommit`); anything YOU move, rewrite, or delete by hand does
  NOT — `git -C <data>/wiki add -A && git -C <data>/wiki commit -m "<why>"` before AND after, and
  reconcile `git -C <data>/wiki status --short` against intent.
- **EXPENSIVE BUT RECOMPUTABLE — embedding caches** (`<wiki>/<cat>/.embeddings/embeddings.json`).
  A pure function of leaf text + model, so a re-warm always restores them — at the price of a
  cold pass over the whole corpus. Recomputable is not the same as cheap.
- **IRREPLACEABLE — the failed-distill stash** (`<data>/state/failed-distill-*.json`,
  `failed-flush-*.md`). Capture that could not be distilled, held as the COMPLETE redacted body
  so `cli.mjs redistill` can retry it. Nothing regenerates it. Note the trap: `state/*.json`
  matches ONLY these — every genuine state file is a DOTFILE — so `rm state/*.json` deletes the
  stash and nothing else.
- **CHEAP — derived state** (the dotfiles: `state/.compile-state.json`, `.consolidate.json`,
  `.consolidate-entities.json`, `.embed-warm.json`, `.embed-gc.json`, `.issues-index.json`, plus
  `state/logs/`). Losing one costs an extra run of something; spend no ceremony here.
- **USER-OWNED — `<data>/settings/`**. Not recomputable and not yours; never rewrite it.

## Snapshot the cheap invariant BEFORE editing what hooks and cron execute

For the embedding path the invariant is the per-category stamp plus entry count, and capturing it
is the only reason the incident above was detectable at all. The command lives with the procedure
that uses it: `.agents/skills/verify-live-change.md` step 1.

Generalise the habit, not the command: for whatever the change can touch, record the smallest
reading that would CHANGE if it went wrong, BEFORE it can. A baseline cannot be taken afterwards.

| Artefact | Baseline to capture |
| --- | --- |
| embedding caches | the per-category stamp + entry count (skill step 1) |
| wiki leaves | `git -C <data>/wiki log -1` and `git -C <data>/wiki status --short` |
| derived state, or anything unfamiliar | `node scripts/cli.mjs doctor` — the default fallback baseline |

## Re-verify with the same invariant afterwards

- Re-run the snapshot. Every category must still carry the same backend/model/dtype/dim and a
  count no lower than before.
- `node scripts/cli.mjs warm` — expect `"embedded": 0, "paused": 0` on an already-warm wiki. A
  NON-ZERO `embedded` means something invalidated entries: investigate before moving on, because
  the warm repairs the symptom rather than the cause.
- `node scripts/cli.mjs doctor` — expect `"ok": true` with `"cacheMismatches": []` and
  `"cacheDimMixes": []`. It exits 3
  on findings, so it also works as a scripted preflight.

## Multi-file edits are not atomic

- Between two writes the tree is a state nobody designed, and a hook starting there imports
  module A new alongside module B old. That window is the incident's proximate cause.
- Sequence edits so every intermediate state stays importable: add the new export before its
  caller, keep the old name alive until the last reader moves, delete last.
- When an inconsistent window is genuinely unavoidable (a signature change spanning modules), say
  so in your reply to the user BEFORE starting, keep the window short, and run the full
  after-verification. Silent windows cost vectors.

## Recovery is self-healing — use it

- **Any cache doubt → re-warm.** `node scripts/cli.mjs warm` is idempotent, touches no leaf, and
  rebuilds every missing vector from leaf text. Guessing never beats running it.
- **A leaf changed that should not have** → restore from `<data>/wiki`'s own history
  (`git -C <data>/wiki log --oneline`, then `git -C <data>/wiki checkout <commit> -- <path>`).
  There is no remote to pull from; what is not in that history is gone. Re-run `doctor` after —
  a leaf restored without its index entry surfaces as a broken ref or an orphan.

## Never make the real brain a test fixture

- Do NOT "just check" a behaviour by running the engine against `<data>` when a temp workspace
  answers the same question. There is no read-only way to exercise it: search persists the
  vectors it embedded.
- Tests must never resolve `MEMORY_DATA_DIR` to the real brain. `test/setup-guard.mjs` (the
  `--import` preload) arms `LWM_FORBID_REAL_BRAIN=1` and redirects an unset or aliasing data dir
  to a temp dir; `env.mjs` then THROWS instead of corrupting real memory — a past incident
  hard-deleted ~590 real leaves this way. That preload is wired into the `test` / `test:e2e` /
  `test:llm-live` npm scripts ONLY. A bare `node --test test/<file>.test.mjs` skips the preload
  and relies on the weaker `NODE_TEST_CONTEXT` backstop, which some runner modes do not set.
  ALWAYS iterate as `node --import ./test/setup-guard.mjs --test test/<file>.test.mjs`
  (`.agents/rules/testing.md` owns this). Setting `MEMORY_DATA_DIR` by hand is NOT a substitute:
  it redirects one path and arms nothing, so a module resolving the real brain another way still
  corrupts silently instead of throwing.
- Nothing here licenses disarming the guard to "test against the real thing".

## `pwd -P` in the shell wrappers is load-bearing — do not "simplify" it

Every hook wrapper and `bootstrap.sh` resolves its own location with
`SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"`. The `-P` is not stylistic: it
prints the PHYSICAL path, so the `.mjs` it launches receives an already-resolved `argv[1]`.

For the whole life of the old path-comparison entrypoint guard, that `-P` was the ONLY reason
POSIX hooks were not silently no-opping — the guard compared `argv[1]` against the realpath-
resolved `import.meta.url`, so an unresolved launch path made it decline to run while exiting 0.
Dropping `-P` would have broken every hook with no error message anywhere. (`bootstrap.ps1` uses
the unresolved `$PSScriptRoot` and had no such protection, which is why Windows was broken.)

The guard is now `if (import.meta.main)`, which does not compare paths at all, so `-P` is no
longer load-bearing for THAT reason. Keep it anyway — it still makes `SCRIPT_DIR` stable for
everything else derived from it — but the lesson generalises: **when a protection is only
implicit, a later "cleanup" removes it silently.** If you find yourself relying on a launch path
being pre-resolved, assert it or document it where the reliance lives.

## Keeping this rule current

When a new durable artefact or a new live entrypoint (a hook, a scheduler job, a long-running
server) is added, its snapshot command and its verification command belong in this file, in the
same change. A rule listing yesterday's live surfaces buys false confidence about today's.

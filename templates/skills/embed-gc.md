---
name: embed-gc
description: At session end, run the throttled embedding-cache garbage collector so the local LLM wiki's vector cache (index/embeddings.json) doesn't accumulate orphaned entries over time. In Claude Code a SessionEnd hook does this automatically; in hook-less agents (Codex, Cursor, custom) YOU must run it. It self-throttles (default weekly), so it's safe — and cheap — to invoke at the end of every session: when not yet due it no-ops instantly.
---

# Embedding-cache GC (session-end maintenance)

The wiki keeps one embedding vector per leaf in `index/embeddings.json`. The
write path prunes entries for leaves deleted/moved **through the MCP tools**,
but a leaf removed **out of band** (manual `rm`, a `git` checkout, a wiki
wipe + re-migrate, the skill's own balance/flatten moves) strands its vector
forever — dead weight that bloats the cache file.

`gc-embeddings` sweeps those orphans (entries whose leaf no longer exists on
disk). To avoid running it every session, the **`--if-due`** form throttles to
`gc.intervalDays` in `<data>/settings/settings.yaml` (default **7** — weekly; `0` disables), tracking
the last run in `state/.embed-gc.json`.

## When to run

At **session end / wrap-up** — the same moment you'd run
[`session-end-capture`](./session-end-capture.md). It's idempotent and self-
throttling, so invoking it every session is correct: it sweeps only when due
and otherwise returns `{ "skipped": "not-due" }` instantly.

**Claude Code** runs this automatically via the `embed-gc-session-end.sh`
SessionEnd hook — you do NOT need to invoke it there. This rule exists for
**hook-less agents** (Codex, Cursor, custom), which must run it themselves.

## How to run

```bash
node .llm-wiki-memory/src/scripts/cli.mjs gc-embeddings --if-due
```

Best-effort and non-blocking: ignore the result, never let it fail the
session. (Drop `--if-due` to force an unconditional sweep on demand;
add `--dry-run` to preview without writing.)

## Do NOT

- Run it mid-task or in a loop — it's a once-in-a-while maintenance sweep.
- Re-implement the throttle — `--if-due` already owns the interval + state.
- Worry about correctness impact — orphans are never scored by search; this
  is purely housekeeping (disk + write-amplification at scale).

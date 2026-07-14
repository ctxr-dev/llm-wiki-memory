---
name: consolidate
description: At session end (after embed-gc), run the deterministic + LLM memory consolidation orchestrator. Search-driven; refines self_improvement + knowledge over time without touching daily/plans/investigations. Opt-in via `consolidate.enabled` (default false, off): a no-op in every path until enabled; when on, self-throttled (default daily) so it no-ops cheaply when not due. Claude Code runs it on the daily cron; hook-less agents (Codex, Cursor) invoke it once at session end via this rule.
---

# Consolidate (memory refinement)

The `consolidate_memory` MCP tool / `consolidate` CLI subcommand runs the search-driven AutoDream consolidator: for every active leaf in `self_improvement` + `knowledge`, it finds the similarity cluster via internal vector search and applies a deterministic dedup + cleanup pipeline. With an LLM provider available it also merges near-duplicate bodies and refreshes stale leaves. No hard deletes — every loser is archived (recoverable via `enable_document`).

Claude Code runs this on the daily cron (chained after `compile` in `bootstrap.sh --schedule daily`). Hook-less agents (Codex, Cursor, generic MCP clients) won't fire that cron — invoke it manually at session end, mirroring the `embed-gc` rule.

## When to run

- **Only when enabled.** `consolidate.enabled` in `<data>/settings/settings.yaml` defaults to `false` (opt-in). While off, `consolidate_memory` / `cli.mjs consolidate` return `{ skipped: "disabled" }` and this rule is a no-op — `force` does NOT override it. Enable it only if the user asks.
- **At session end**, after `embed-gc`. Self-throttled to `consolidate.intervalDays` in `<data>/settings/settings.yaml` (default `1`), so a too-frequent call is a no-op.
- **Never mid-task.** Acquires the compile lock — if compile is running, the call returns `{ skipped: "locked-by", ... }`.
- **Never inside a propose-then-confirm save flow.** Consolidate is system maintenance; user-driven saves go through `save_lesson` / `save_to_dataset` and are subject to the L3 write-gate.

## How to invoke

```
node .llm-wiki-memory/src/scripts/cli.mjs consolidate --if-due
```

or via the MCP tool:

```
consolidate_memory({ scopes: ["."], consolidate: { ifDue: true } })
```

Both return a JSON report shaped `{ ok, dryRun, llm, passes: { ... per-pass stats ... }, totals: { archived, touched, merged, refreshed, ... } }`. Surface the totals to the user only if they ASKED about consolidation; otherwise stay silent.

## Do NOT

- Do NOT pass `--force` or `force: true` unless the user explicitly asks for an off-schedule run.
- Do NOT pass `--no-llm` to silently skip LLM passes — if the provider is unavailable the orchestrator already skips them and logs once. Use `--no-llm` only when the user asks for "deterministic only" output. Persistent involuntary skips (provider requested but unavailable) are tracked by the cron self-healing layer as `system:consolidate-llm-providers` and escalate into an issue report surfaced by `cron-health`.
- Do NOT override `--cosine-threshold` casually. The default (`0.97` on bge-large, auto-bumped to `0.995` on the lexical fallback) is calibrated to a near-paraphrase floor. Lower thresholds = more false-positive archives.
- Do NOT loop the call. Once per session, end of session. The daily cron does the rest.
- Do NOT invoke this tool as a workaround for failing to propose a self_improvement save (rule 2 of the discipline). Consolidate refines what's already there; it does NOT capture new content.

## What it produces

Per pass, in the returned `passes` block (each key is a pass name):

| Field | Meaning |
|---|---|
| `archived` | leaves disabled (loser of a dedup pair, orphan archive, or LLM-archive action) |
| `touched` | metadata writes (stale flag toggled, compress-archived, etc.) |
| `merged` | keepers whose body was LLM-rewritten by 3A merge-near-duplicates |
| `refreshed` | leaves rewritten by 3B llm-semantic-refresh |
| `flagged` | dedup candidates surfaced; equal to or greater than archived (some get skipped if cross-category, locked, or LLM rejects) |
| `freedBytes` | bytes reclaimed by `compress-archived` (archived-body truncation) |
| `errors` | per-pass failures; consolidate continues after any single-pass error |

Top-level `totals` is the sum across passes. `skipped: "not-due"` or `skipped: "locked-by"` mean the orchestrator never ran (no state file written, no mutations). `dryRun: true` reports what WOULD change without touching the wiki.

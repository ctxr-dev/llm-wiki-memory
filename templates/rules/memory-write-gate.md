---
name: memory-write-gate
description: Memory is read-freely, write-gated. Never call save_lesson or save_to_dataset(dataset="self_improvement") on your own initiative. PROPOSE the lesson and wait for explicit user yes in the same turn, then call with userRequested:true. The MCP server REFUSES self_improvement writes without that flag.
---

<!-- CANONICAL SOURCE: .llm-wiki-memory/src/templates/rules/memory-write-gate.md
     bootstrap.sh renders this to .agents/rules/, .claude/rules/, and .cursor/rules/.
     Edit the template and re-render; do NOT hand-edit a rendered copy. -->

# Memory write-gate (self_improvement is propose-then-confirm)

This rule applies to every AI agent connected to the local LLM wiki memory through the `llm-wiki-memory` MCP server (Claude Code, Cursor, Codex, Claude Desktop, generic MCP clients). It governs writes to the **self_improvement** category only.

## The invariant

> Memory is **read-freely, write-gated**. Recall as needed (`recall_lessons`, `search_memory`). NEVER call `save_lesson` or `save_to_dataset(dataset="self_improvement", ...)` on your own initiative — even when the user clearly corrected you, even when the lesson seems obvious, even when prior versions of this discipline told you to "save BEFORE replying".
>
> When you think a lesson is worth saving, PROPOSE it to the user in **one short sentence**:
>
> > "Want me to save this as a lesson? Title: `<imperative summary>`, error_pattern: `<kebab-slug>`."
>
> Then:
>
> - **User says yes in this turn** → call the tool with `userRequested: true`.
> - **User says no, ignores, redirects, or asks something else** → do NOT save. Continue helping. Bringing it up again later is fine; saving without the in-turn yes is a discipline violation.

## Why this exists (the trade-off)

The earlier discipline told the model to autosave on every correction. In practice that produces a noisy corpus: many low-signal lessons, duplicates with slightly different wording, and entries the user didn't actually endorse. The new rule trades passive learning volume for **user-curated quality**.

The consolidate orchestrator (search-driven, runs on the daily cron) backfills the value of bulk capture another way: it merges near-duplicates, refreshes stale entries, and archives leaves that no longer match current reality. So a sparse, user-approved set still grows into a useful corpus over time — without the noise.

## Enforcement (deterministic, cross-client)

Three layers, belt-and-suspenders:

1. **L1 — discipline (instructions).** Every connecting client receives the discipline at `initialize`; every client also ships this rule in `.agents/rules/`, `.claude/rules/`, and `.cursor/rules/`.
2. **L2 — Claude Code `PreToolUse` hook** (`pretooluse-gate-memory-writes.sh`). Inspects the latest user turn for explicit save phrases. Matches → `permissionDecision: "allow"`; otherwise → `permissionDecision: "ask"` (user gets a one-click yes/no prompt). Claude Code only — Cursor/Codex don't fire hooks.
3. **L3 — MCP server-side guard.** Required `userRequested: boolean` argument on `save_lesson`; required when `dataset === "self_improvement"` on `save_to_dataset`. Server returns `{ ok: false, error: "write-gate-refused", message: ... }` when missing/false. This layer covers ALL clients.

L4 (folded into L2) blocks `Write`/`Edit`/`NotebookEdit` to Claude Code's per-client memory directory (`~/.claude/projects/<workspace>/memory/...`) — that path is per-session and per-client; use the wiki instead.

## Things the gate does NOT apply to

- **Other categories** (`knowledge`, `plans`, `investigations`, `daily`, `issues`). Their routing rules in `self-improvement.md` / `investigation-capture.md` / `plan-capture.md` still apply directly — no `userRequested` flag needed.
- **System-maintenance writes.** The consolidate orchestrator runs every internal write under `withSystemMaintenance(...)` (AsyncLocalStorage frame). The MCP server detects the flag and exempts these from the gate. The model has no way to enter that frame from outside the orchestrator process.
- **The recall-touch instrumentation** (`searchMemoryFiltered` / `recallLessons` writing `memory.last_recalled_at` + `memory.recall_count` on returned leaves). Same maintenance frame, same exemption.

## Operator override

Set `gate.selfImprovementEnabled: false` in `.llm-wiki-memory/settings/settings.yaml` to disable the L3 server-side check. L1 instructions and L2 hooks still apply. This is an escape hatch for rare bulk-import / migration runs; keep it on in normal operation.

Set `gate.claudeHookEnabled: false` (same file) to disable the L2 Claude Code hook: it then exits 0 with no decision, so Claude Code's normal permission flow applies. The hook is enabled by default; L1 instructions and the L3 server-side gate still apply.

## Quick reference

| You observed | You do | Server outcome |
|---|---|---|
| User explicitly says "save this as a lesson" | call `save_lesson({ ..., userRequested: true })` | Saved |
| User said yes to your propose-then-confirm | call `save_lesson({ ..., userRequested: true })` | Saved |
| You think a lesson is warranted but the user hasn't asked | propose one line; wait for yes; do NOT call the tool until then | (no call made) |
| Tool called without `userRequested:true` | (don't do this) | Refused with `error: "write-gate-refused"` |
| Saving a `knowledge` / `plans` / `investigations` artefact | call `save_to_dataset` with the appropriate dataset; no flag needed | Saved |

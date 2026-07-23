---
name: memory-write-gate
description: Memory is read-freely, write-gated. Never call save_lesson or save_to_dataset(dataset="self_improvement") on your own initiative. PROPOSE the lesson and wait for explicit user yes in the same turn, then call with userRequested:true. The MCP server REFUSES self_improvement writes without that flag.
---

<!-- CANONICAL SOURCE: .llm-wiki-memory/src/templates/rules/memory-write-gate.md
     bootstrap.sh wires an @-pointer to this file into .agents/rules/, .claude/rules/,
     and .cursor/rules/ (reference-only — no copies, no symlinks). Edit this canonical
     template; do NOT hand-edit a pointer. -->

# Memory write-gate (self_improvement is propose-then-confirm)

This rule applies to every AI agent connected to the local LLM wiki memory through the `llm-wiki-memory` MCP server (Claude Code, Cursor, Codex, Claude Desktop, generic MCP clients). It governs writes to the **self_improvement** category only.

## The invariant

> Memory is **read-freely, write-gated**. Recall as needed (`recall_lessons`, `search_memory`). NEVER call `save_lesson` or `save_to_dataset(dataset="self_improvement", ...)` on your own initiative — even when the user clearly corrected you, even when the lesson seems obvious, even when prior versions of this discipline told you to "save BEFORE replying".
>
> When you think a lesson is worth saving, PROPOSE it and get the user's explicit yes in the same turn. **On Claude Code, propose via the `AskUserQuestion` tool — one call, one question PER LESSON** (batch up to 4 lessons; more → successive calls), options:
>
> > `Save (P1)` · `Save as guardrail (P0)` · `Save as contextual (P2)` · `Skip`
> >
> > the question text stating NEW vs UPDATE (from the rule-16 dedup) + the proposed title.
>
> On a client WITHOUT AskUserQuestion, use its equivalent structured prompt, else propose in **one short sentence** and wait for the yes. Then:
>
> - **User marks a lesson Save (P1/P0/P2)** → call the tool for THAT lesson with `userRequested: true` and the chosen priority.
> - **User marks Skip / says no / ignores / redirects** → do NOT save that lesson. Continue helping. Bringing it up again later is fine; saving without the in-turn yes is a discipline violation.
>
> **One approval = one lesson.** Each lesson is its own question and its own decision; a single "save it" does NOT authorise a batch flush of several lessons. (On Claude Code the L2 hook enforces this: it allows only as many self_improvement writes as the user marked Save this turn — any beyond that re-prompts.)

## Why this exists (the trade-off)

The earlier discipline told the model to autosave on every correction. In practice that produces a noisy corpus: many low-signal lessons, duplicates with slightly different wording, and entries the user didn't actually endorse. The new rule trades passive learning volume for **user-curated quality**.

The consolidate orchestrator (search-driven, runs on the hourly maintenance cron) backfills the value of bulk capture another way: it merges near-duplicates, refreshes stale entries, and archives leaves that no longer match current reality. So a sparse, user-approved set still grows into a useful corpus over time — without the noise.

## Enforcement (deterministic, cross-client)

Three layers, belt-and-suspenders:

1. **L1 — discipline (instructions).** Every connecting client receives the discipline at `initialize`; every client also ships this rule in `.agents/rules/`, `.claude/rules/`, and `.cursor/rules/`.
2. **L2 — Claude Code `PreToolUse` hook** (`pretooluse-gate-memory-writes.sh`). Recognises consent from the current turn: an **answered `AskUserQuestion` whose selections marked N lessons Save**, or (fallback) an explicit save phrase in typed prose. Matches → `permissionDecision: "allow"` for up to that many gated writes; otherwise → `permissionDecision: "ask"` (one-click yes/no). **Per-lesson consent:** the hook allows only as many self_improvement writes as the user actually approved this turn; any beyond that re-prompts (`ask`), so a batch flush cannot ride one approval. Claude Code only — Cursor/Codex don't fire hooks.
3. **L3 — MCP server-side guard.** Required `userRequested: boolean` argument on `save_lesson`; required when `dataset === "self_improvement"` (or a `path` landing there) on `save_to_dataset` / `write_memory`. Server returns `{ ok: false, error: "write-gate-refused", message: ... }` when missing/false. This layer covers ALL clients.

L4 (folded into L2) blocks `Write`/`Edit`/`NotebookEdit` to Claude Code's per-client memory directory (`~/.claude/projects/<workspace>/memory/...`) — that path is per-session and per-client; use the wiki instead.

## Per-lesson consent (why one save word is not enough)

A single loose save word (save / remember / record / store / persist / memorise) in the user's turn used to auto-allow *every* gated write that followed in that turn, so a session-end flush could persist many lessons under one bulk approval. With `gate.perLessonConsent` on (default), the L2 hook counts how many lessons the user actually approved this turn — the **Save** selections of an answered `AskUserQuestion`, or (fallback) a save phrase authorising the first write — and allows exactly that many gated self_improvement writes; the next one gets a one-click `ask`. **This is enforced on Claude Code only**: for Cursor / Codex / generic clients there is no L2 hook, so per-lesson discipline rests on L1 (this rule) plus the audit trail below, which makes any batch save visible after the fact. Set `gate.perLessonConsent: false` to restore the legacy turn-level behaviour.

## Audit trail

Every write to the gated self_improvement category is appended (redacted) to `.llm-wiki-memory/state/.save-gate-audit.log` (JSONL, gitignored), so the ledger is a complete record of how each lesson came to exist:

- **Interactive (gate-decided).** The L3 server records each `accepted` decision (with its `consent` basis: `user-flag` / `system-maintenance` / `gate-disabled`) and each `refused` decision, and the L2 hook records each `allow` / `ask` decision (`allow` records also carry the redacted trigger phrase that authorised them).
- **Pipeline (auto-distilled).** The compile pipeline records each lesson it distills from your sessions (`layer: compile`, `consent: compile-distilled`, `action: create | update`). Compile bypasses the gate by design (it is the auto-learn path, not an interactive save); the entry is purely observability and never gates or slows distillation.

Inspect it with `node .llm-wiki-memory/src/scripts/cli.mjs gate-audit [--limit N]`. The whole ledger is observability only (best-effort, never blocks a write, and creates no file until something is recorded). Disable with `gate.auditTrailEnabled: false`; cap its size with `gate.auditKeep`.

## Things the gate does NOT apply to

- **Other categories** (`knowledge`, `plans`, `investigations`, `daily`, `issues`) — BY DEFAULT. Their routing rules in `self-improvement.md` / `investigation-capture.md` / `plan-capture.md` still apply directly — no `userRequested` flag needed. BUT gating is now **layout-declared per-wiki**: a wiki may opt a category IN with `gated: true` in its `.layout/layout.yaml`, and `self_improvement` is gated by a name-keyed default (not a hardcoded rule). So do not assume the gated set — CHECK the target wiki's layout via `get_memory_config` (each `levels[]` entry reports its `gated` category names); propose via AskUserQuestion for ANY gated category, and pass `userRequested:true` on the save.
- **System-maintenance writes.** The consolidate orchestrator runs every internal write under `withSystemMaintenance(...)` (AsyncLocalStorage frame). The MCP server detects the flag and exempts these from the gate. The model has no way to enter that frame from outside the orchestrator process.

## Quality judge (interactive saves into knowledge / self_improvement)

Separately from the consent gate, a save into an **atomic curated category** (`knowledge` or `self_improvement`) is checked by a **quality judge** — a second LLM call that scores the leaf against the durability + content-quality + de-personalization rubric (`content-quality.md`; for `self_improvement` also: conceptual, behavioural, validated). Plans / investigations / issues (structured lifecycle docs) and `daily` / `absorb` (raw / verbatim) are EXEMPT.

- **On pass:** the write proceeds normally.
- **On reject:** the tool returns `{ ok: false, error: "quality-judge-rejected", verdict, recommendation }` and DOES NOT write. Revise the leaf per `recommendation` and resubmit — up to 3 attempts. To store your best attempt anyway, resubmit with `write.acceptQuality: true`; it is written and stamped `memory.quality: "unverified"` — a durable marker recorded so consolidate/recall can treat it cautiously (a reserved affordance for the read side; the flag is always preserved on the leaf).
- **Fail-closed:** if the judge LLM cannot run, the tool returns `{ ok: false, error: "quality-judge-unavailable" }` — retry when a provider is reachable (never a silent drop). The engine paths (compile / consolidate) run the same judge in-process with the generate→judge→revise loop.

## Operator override

Set `gate.selfImprovementEnabled: false` in `.llm-wiki-memory/settings/settings.yaml` to disable the L3 server-side check. L1 instructions and L2 hooks still apply. This is an escape hatch for rare bulk-import / migration runs; keep it on in normal operation.

Set `gate.claudeHookEnabled: false` (same file) to disable the L2 Claude Code hook: it then exits 0 with no decision, so Claude Code's normal permission flow applies. The hook is enabled by default; L1 instructions and the L3 server-side gate still apply.

Set `gate.perLessonConsent: false` to restore turn-level consent (one save phrase auto-allows the whole turn). Set `gate.auditTrailEnabled: false` to stop recording the audit ledger. Set `gate.auditKeep: <N>` to bound the ledger size. All default to the safe posture (per-lesson ON, audit ON, keep 1000).

Set `quality.judgeEnabled: false` to disable the quality judge (interactive + compile + consolidate) for offline / CI / bulk-import runs; `quality.maxRounds: <N>` bounds the generate→judge→revise loop (default 3). The judge is ON by default and fails closed — a persistently-unreachable provider halts generation rather than saving unverified leaves.

## Quick reference

| You observed | You do | Server outcome |
|---|---|---|
| User picks `Save (P1/P0/P2)` in the AskUserQuestion (or says "save this as a lesson") | call `save_lesson({ scopes, target, write:{...}, gate:{ userRequested: true } })` with the chosen priority | Saved |
| You think a lesson is warranted but the user hasn't approved | ask via AskUserQuestion (one question per lesson); save only the ones marked Save | (only approved ones saved) |
| You have several lessons to save | ONE AskUserQuestion, one question per lesson (batch ≤4) | each saved on its own Save; the hook allows exactly as many as marked Save (L2) |
| Tool called without `userRequested:true` | (don't do this) | Refused with `error: "write-gate-refused"` |
| Saving a `knowledge` / `plans` / `investigations` artefact | call `save_to_dataset` with the appropriate dataset; no flag needed | Saved |

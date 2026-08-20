# Memory write-gate (read-freely, write-gated)

Self-improvement lessons are **propose-then-confirm**: the agent NEVER calls `save_lesson` (or `save_to_dataset` / `write_memory` into `self_improvement`) on its own. It proposes the save in chat, waits for an explicit user yes in the same turn, then calls the tool with `gate.userRequested: true`. The server refuses gated writes without the flag.

Knowledge, plans, investigations, daily, and tracker-issue writes are **not** gated — their routing rules apply directly.

## Three enforcement layers (defence-in-depth)

Any one layer can refuse a save:

| Layer | Where | What it does |
| --- | --- | --- |
| **Instructions** (probabilistic) | MCP `initialize` + the rule files bundled at install | Tells the model the rule, the exact wording to propose, and the consent contract. Reaches *every* MCP client — but not airtight alone, which is why the next two exist. |
| **Claude Code hook** (deterministic, Claude Code only) | `PreToolUse` on the three gated writers (`gate.claudeHookEnabled`, default on) | Inspects the latest user turn for a save phrase → `allow`; no match → `ask` (one-click yes/no). Per-lesson consent: one save phrase auto-allows only the FIRST gated write of a turn, so a batch can't ride one yes. |
| **MCP server gate** (deterministic, every client) | The `save_lesson` / `save_to_dataset` / `write_memory` handlers | Refuses any call without `userRequested: true`, and refuses a `path:` that lands under `self_improvement/…` from a non-gated `dataset:`. The airtight bottom layer for hook-less clients (Cursor, Codex, generic). |

## Reconciliation, escape hatches & the audit ledger

**Wire shape.** Tool inputs are a single nested context object: writes send `write:{...}` plus (for `self_improvement`) `gate:{userRequested}`; mutates send `select:{...}`. Every schema is strict, so a typo'd or misplaced key is rejected rather than silently dropped.

**Reconciliation.** The layers are independent and additive. The model can NOT bypass them: it can't suppress the discipline (sent at `initialize`), can't disable the Claude Code hook from inside a tool call, and can't forge `userRequested` (the only legitimate-bypass path is the internal `withSystemMaintenance` async frame that consolidate uses for its own bookkeeping — entered only by the orchestrator's own code, never by a client request).

**Escape hatches.** `gate.selfImprovementEnabled: false` disables the server-side check; `gate.claudeHookEnabled: false` disables the Claude Code hook (both other layers still apply). `gate.perLessonConsent: false` restores legacy turn-level consent.

**Not a consent gate: the inline-body size bound.** `runWriteGates` also enforces `gate.maxInlineBodyBytes` (default 32768) on the inline `text` of `save_lesson` / `save_to_dataset` / `write_memory`, refusing an oversized body with `inline-body-too-large`. It runs AFTER the consent gate (so a gated no-consent write is still reported as a consent violation, whatever its size) and BEFORE the quality judge (so a doomed body never costs an LLM round-trip). It is **independent of `gate.enabled`** — that flag governs user consent, this is a token/latency bound: an agent re-emitting a 46KB document spends ~12k output tokens and tens of seconds to do what `cli.mjs save-leaf --file` does in under a second. It is **not** a fix for the client-side `input JSON failed to parse — <n> bytes` error; an MCP client refuses a far-oversized argument before the server sees it, so this can only fire on payloads the client accepted. `absorb_document` is exempt by design (whole documents, stored verbatim, bypass these gates). `0` = unlimited; a malformed value falls back to the default rather than to unlimited.

**Audit trail.** Every gated write is appended (redacted, gitignored) to `state/.save-gate-audit.log`: the server records each `accepted` decision (with its consent basis: `user-flag` / `system-maintenance` / `gate-disabled`) and each `refused` decision; the Claude Code hook records each `allow` / `ask` (with the redacted trigger phrase); and compile records each lesson it auto-distills (`layer: compile`, `consent: compile-distilled`). Inspect it with `cli.mjs gate-audit [--limit N]`. Best-effort — never blocks a write, creates no file until something is recorded. Bound its size with `gate.auditKeep` (default 1000); disable with `gate.auditTrailEnabled: false`.

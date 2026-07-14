---
name: recall-delegation
description: Delegate the context-heavy memory READS (recall_lessons, search_memory) to a subagent that returns a DISTILLED digest, so the user-facing chat's context window stays lean. Cheap/structural calls (get_memory_config, list_datasets, reload_*, validate_*) and gated SAVES (save_lesson, self_improvement save_to_dataset — consent stays with the user in the main chat) are NOT delegated. On a client without subagents, call the reads directly but keep the payload tight.
---

<!-- CANONICAL SOURCE: .llm-wiki-memory/src/templates/rules/recall-delegation.md
     bootstrap.sh wires an @-pointer to this file into .agents/rules/, .claude/rules/,
     and .cursor/rules/ (reference-only — no copies, no symlinks). Edit this canonical
     template; do NOT hand-edit a pointer. -->

# Delegate the context-heavy memory reads to a subagent

The two memory READS return large payloads — `recall_lessons` (lesson bodies +
knowledge cross-refs) and `search_memory` (hit bodies). Running them directly in
the chat the user is talking to floods that conversation's context window with
raw memory I/O the user never needs to see. So, **when your client supports
subagents / task-delegation, delegate those two reads to a subagent** and bring
back only what you'll act on.

## The rule

> The user-facing (main) chat should not carry the raw output of `recall_lessons`
> or `search_memory`. Spawn a subagent to run the read; the subagent returns a
> **distilled digest** — the handful of rules/facts that actually apply to the
> task at hand — and the main agent applies that digest **silently** (per the
> `self-improvement` recall rule). The verbose bodies stay in the subagent's
> context, not yours.

## What to delegate — and what NOT to

| Operation | Where it runs | Why |
|---|---|---|
| `recall_lessons`, `search_memory` | **Subagent** (when available) | Large payloads; delegating keeps the main chat lean. |
| `get_memory_config`, `list_datasets`, `reload_provider`, `reload_layout`, `validate_layout`, `validate_topology`, `test_path_compiler` | **Main chat** | Small, structural responses — no context cost worth delegating. `get_memory_config` also feeds your `scopes`/`target` choices, which you need in the main chat. |
| `save_lesson`; a `self_improvement` `save_to_dataset` (any GATED save) | **Main chat — never a subagent** | The propose-then-confirm consent (`memory-write-gate`) must happen with the user, in this turn; the server refuses without `userRequested:true` and the Claude Code L2 hook reads the USER's turn. A subagent cannot witness your yes. The write itself stays in the main chat too. |
| non-gated `save_to_dataset` / `write_memory` (knowledge / plans / investigations) | **Main chat** | Small input; keep writes together with their (main-chat) decision. |

## The digest contract (what the subagent returns)

Give the subagent the `query`, the `scopes`, and any `filters`, and ask it to
return a COMPACT, actionable digest — not the raw records:

- Only the rules/facts relevant to the current task (drop the rest).
- Each line tagged with its **source leaf name** and **priority** (so the main
  agent can apply the highest-priority items first and cite them).
- No full leaf bodies unless the main agent explicitly needs one; if a body is
  essential, the subagent quotes just the needed lines.
- If nothing relevant surfaced, the subagent says so in one line (absence is a
  valid, cheap answer — do not pad).

The main agent then applies the digest silently and, if it applied a specific
lesson, adds one line: `applied lesson: <title>`.

## Provider-agnostic fallback (no subagents)

Not every MCP client has a subagent / task-delegation mechanism. On such a
client, call `recall_lessons` / `search_memory` **directly**, but keep the
payload tight so the main context isn't flooded:

- `sections: ["frontmatter"]` for a glance view (brief + type + priority + tags,
  no bodies) when you only need to know WHICH lessons exist.
- a `scoreThreshold` and a small `maxResults` to cap the result set.
- pull a full body only for the one or two hits you will actually act on.

This is guidance, not a hard gate: the goal is a lean main-chat context, achieved
by delegation where possible and payload-minimization where not. It never changes
WHAT is recalled or saved — only WHERE the verbose read runs.

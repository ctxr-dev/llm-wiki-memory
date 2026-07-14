---
name: session-end-capture
description: When the user signals the session is wrapping up ("ok, that's it for today", "let's stop here", "I'm done"), OR you observe meaningful work was completed (issue investigated, plan executed, decision reached), capture the durable parts into the local LLM wiki via the MCP tools — issue knowledge updates, new plans if any, lessons learned. Fallback for non-Claude-Code agents where the PostToolUse / SessionEnd hooks don't fire; in Claude Code these auto-trigger but this skill lets you ALSO capture content the hooks can't (since hooks are mechanical and don't decide what's worth saving).
---

# Session-end capture

Hooks (PostToolUse + SessionEnd on `plan-frontmatter-sync.sh`) keep plan
files' frontmatter and lifecycle folders in sync mechanically. But they
DON'T decide what's worth recording as durable knowledge — that's content
generation, and only you (the agent) can do it well.

This skill is your "wrap-up" routine. It complements the mechanical hooks
in Claude Code; in **non-Claude agents (Codex, Cursor, custom)** where
those hooks don't fire, it's the **only** path that records session work.

## When to invoke

Run this skill — without waiting for the user to explicitly request it —
when any of these are true:

- **The user signals end-of-session.** "I'm done for today", "let's stop
  here", "ok that's it", or any cue the conversation is ending.
- **A meaningful unit of work just finished.** You investigated an issue
  to root cause, completed a plan, made an architectural decision, or
  learned something you don't already see in the wiki.
- **The user asks to "save" or "memorise"** something specific. Follow
  [`self-improvement`](./self-improvement.md) for the routing rules; this
  skill covers the broader "end-of-session sweep".
- **You're about to be context-compacted.** PreCompact / PostCompact
  hooks handle the raw-atom layer; this skill saves the curated layer
  the LLM is uniquely positioned to author.

Do NOT invoke when:

- The session is mid-task and the user is still actively driving — let
  the user signal "we're stopping" or finish the unit of work first.
- Nothing durable happened. Asking a clarifying question, running one
  test, fixing one typo: skip.
- The wiki is not initialised.

## Steps

1. **Identify the active issue(s).** If the session worked on a specific
   tracker issue (Jira / Linear / etc.) — look at the git branch, recent
   file edits, or transcript references — note the key(s). Multiple
   issues OK.

2. **For each active issue, decide what to record.** Open the issue's
   wiki knowledge file (use `search_memory` with the issue key as the
   query, or compute the path if you know the topology) and read it.
   Ask yourself:
   - Is there a finding from this session that isn't already in the
     issue's body?
   - Did the plan's `## Reasons` section gain new entries that should be
     surfaced as findings?
   - Did we resolve something previously open?
   If yes, prepare a delta to add to the knowledge file's
   `## Investigation Notes` section, timestamped.

3. **Save the delta via the MCP tool.** Use `save_to_dataset`:
   ```json
   {
     "scopes": ["."],
     "target": "brain",
     "write": {
       "dataset": "issues",
       "name": "<KEY>.md",
       "text": "<the full UPDATED knowledge file body — preserve everything
                that was there, append your new notes>",
       "metadata": {
         "atom_type": "jira_issue",
         "area": "<repo-or-area-the-issue-relates-to>",
         "tags": "<comma-sep tags including the issue key lowercased>"
       },
       "path": "<the topology-computed dir, no trailing slash; e.g.
                issues/JIRA/DEV/129/95/7>"
     }
   }
   ```
   `save_to_dataset` overwrites in place when `path` + `name` resolve to
   an existing leaf. Idempotent: re-running with the same content yields
   no changes.

   `issues` is a TOPOLOGY category: the `path` above is MANDATORY and must
   match the layout's topology for the leaf's file_kind (here `<KEY>.md` is a
   tracker-`knowledge` leaf, so the path has NO `<lifecycle>` segment; a
   `<KEY>-<slug>.plan.md` leaf would). Compute it from `.layout/layout.yaml`
   (see the `topology-path-routing` rule). A missing or topology-mismatched
   `path` is refused by the server — it would otherwise land flat at the
   category root.

4. **Lessons learned are WRITE-GATED — propose, don't save.** If the
   session produced a generalisable lesson (not specific to this one
   issue), PROPOSE it to the user in one short line (e.g. *"Want me to
   save this as a lesson? Title: ..., error_pattern: ..."*) and only
   call `save_lesson` with `userRequested:true` after explicit yes in
   this turn. See [`self-improvement`](./self-improvement.md) for the
   propose-then-confirm contract and the lesson schema. The server
   REFUSES self_improvement writes without `userRequested:true`; the
   Claude Code PreToolUse hook returns `permissionDecision:"ask"` to
   the user as a defence-in-depth layer.
   **PER-LESSON CONSENT (this matters most at session-end).** When you
   have several candidate lessons, propose and confirm them ONE AT A
   TIME; a single "yes, save them" does NOT license a batch flush. On
   Claude Code, after the first gated write of the turn every additional
   self_improvement write re-prompts, and the whole gate decision trail
   is recorded to a redacted audit ledger (`cli.mjs gate-audit`).
   (Knowledge / issue / plan writes are NOT gated, so batch those freely.)

5. **DO NOT re-write plan files.** The mechanical hook
   (`plan-frontmatter-sync`) keeps plan frontmatter / lifecycle folders
   current. Your job here is the *content* layer (issue narrative,
   lessons), not the *mechanical* layer (status fields, folder moves).

6. **Offer to triage llm-wiki-memory anomalies (self-observability).** If
   this project opted into self-observability, check
   `node .llm-wiki-memory/src/scripts/cli.mjs monitoring-health`; when
   `open > 0`, OFFER the user — in ONE line — to review the captured
   llm-wiki-memory anomalies and plan fixes for `.llm-wiki-memory/src`.
   Surface the count + signatures; do NOT auto-open or auto-fix. On yes,
   read the captures and follow the `self-observability` rule (plan via
   ExitPlanMode → `plans/`, or the `issues` tree if tracker-bound), then mark
   each handled capture with `cli.mjs monitor --resolve <path>`. This is a
   no-op on installs that did not opt in (no captures exist).

7. **Don't fabricate.** If you didn't actually learn or do anything
   durable, skip the capture. False positives pollute the wiki and make
   future recall noisier.

## Output to the user

Tell the user briefly what you captured:

```markdown
Captured to wiki:
- Issue: `DEV-129957` — appended 2 investigation notes (Cassandra timeout, rc22 bisect)
- Lesson: `cats-effect resource leak detection via heap dump` (self_improvement)
- Self-observability: 2 open llm-wiki-memory anomalies — offered to plan src fixes
```

Or, if nothing was captured:

```markdown
Nothing durable to capture from this session.
```

Then continue with whatever the user asked, or close out cleanly.

## Why this is also a skill, not just a hook

The plan-frontmatter hook is mechanical: it follows checkbox state.
This skill is content-generation: deciding which parts of a session
deserve persistence is a judgment call only an LLM can make sensibly.
Together they cover both layers — the hook keeps plans' machine-readable
state honest; the skill keeps the wiki's human-readable narrative growing.

In **Claude Code**, the mechanical hook fires automatically on writes
and at session end; this skill runs alongside it for the content layer.
In **non-Claude agents** where the hook doesn't fire, this skill is
the entire mechanism — and that's why it's important the skill knows
how to invoke `save_to_dataset` and `save_lesson` directly.

## Reference

- MCP tools: `save_to_dataset`, `save_lesson`, `search_memory`,
  `disable_document`, `delete_document`
- Companion skills:
  - [`current-work-context`](./current-work-context.md) — the
    session-start counterpart (fetch context, don't save it)
  - [`plan-capture`](./plan-capture.md) — auto-capture on ExitPlanMode
  - [`investigation-capture`](./investigation-capture.md) — when to save
    a forensic narrative
  - [`self-improvement`](./self-improvement.md) — memory routing
- Topology helper (if you need to compute paths):
  `import { loadTopology, pathFor } from "llm-wiki-memory/topology-runtime"`

# Recall before you scan — a file search is not a substitute for memory

The wiki is the FIRST place to answer *"have we hit this before / why is it this way / what did we
decide / what is already in flight"*. `grep` answers **where the code is**. It cannot answer **what
we learned**, because that was never in the code.

## The rule

> Before non-trivial work, and before answering any question about prior decisions, past incidents,
> conventions, or in-flight plans, call `recall_lessons` (or `search_memory`). Reading and searching
> source code is unaffected and always allowed — this rule is about WHICH QUESTION goes where, not
> about restricting tools.
>
> **Answering from a file scan a question the wiki already answers is the violation — even when the
> answer turns out to be right.** Being correct by grep is not compliance; it means the corpus was
> never consulted, so every lesson in it was skipped and any contradiction went unnoticed.

## Why this is enforced rather than merely stated

This rule exists because the instruction alone did not work. Discipline rule 1 has always said to
call `recall_lessons` before a non-trivial task. In a long session spent entirely on this memory
system, an agent called `recall_lessons` and `search_memory` **zero times** and answered every
question by grepping — with the instruction loaded the whole time.

So a `PreToolUse` hook (`pretooluse-recall-first.sh`) now asks, ONCE per session, at the first
search-or-edit made without consulting memory. It is deliberately weak:

- the decision is **`ask`** — a one-click prompt — never `deny`, so nothing is ever blocked;
- it fires **once per session**, at the first `Grep`/`Glob`/`Write`/`Edit`, never once per call;
- it **fails open**: an unreadable transcript, a parse failure, or a missing MCP server produces no
  decision at all. A nudge that misfires would be worse than one that occasionally misses.

Turn it off with `gate.recallFirstEnabled: false` in `settings.yaml`. That is separate from
`gate.claudeHookEnabled` on purpose: silencing this nudge must not also disable the write gate,
which is the safety-critical hook.

## What good looks like

- **Do:** `recall_lessons` at the start of a task, then read the code the lessons point at.
- **Do:** `search_memory` before concluding "there is no prior decision about X".
- **Don't:** grep the tree for a convention, find one instance, and treat that as the convention —
  the wiki may record why it is being moved away from.
- **Don't:** treat a save (`save_lesson`) as consulting memory. Writing is not recalling.

## Relationship to other rules

- **`self-improvement`** covers what to SAVE and the consent gate around it. This rule covers what
  to READ, and has no gate — reads are free.
- **`recall-validation`** takes over once a leaf is in hand: a recalled fact about code is a prior
  to verify, not an oracle. Recall first, then verify against reality.
- **`recall-delegation`** covers WHERE the read runs (a subagent, to keep the main context lean).
  It never excuses skipping the read.

---
name: recall-validation
description: Recalled memory is a PRIOR to verify, not ground truth. Before acting on a recalled fact that references code or system behaviour, validate it against the current reality; on a mismatch act on reality and reconcile the memory BY CATEGORY (self_improvement → propose via the write-gate; knowledge/plans/investigations → update in place and report), always surfacing what was validated or changed. A strong default (P1), applied whenever a recalled fact is load-bearing — not a hard blocker.
---

<!-- CANONICAL SOURCE: .llm-wiki-memory/src/templates/rules/recall-validation.md
     bootstrap.sh wires an @-pointer to this file into .agents/rules/, .claude/rules/,
     and .cursor/rules/ (reference-only — no copies, no symlinks). Edit this canonical
     template; do NOT hand-edit a pointer. -->

# Validate recalled memory against reality before you rely on it

Memory goes stale: the code a leaf describes gets refactored, a decision is superseded, a fact
that was true when saved no longer holds. Acting on a recalled leaf as if it were ground truth
propagates the falsehood into new work. So treat a recalled leaf as a **prior to verify**, not an
oracle — especially anything that points at code, which changes constantly (see the durability
section of `content-quality`).

## When and what to validate

- Before you RELY on a recalled fact that references **code or system behaviour** (a file, a
  function, a data shape, a config, "X does Y") to make a decision or an edit, VERIFY it against
  the current reality — read the actual code / working tree / config now. Do this for the facts
  you are about to ACT on; you need NOT eagerly re-check every hit a recall returns.
- **Behavioural lessons / preferences** (self_improvement): apply them as guidance, but re-judge
  their FIT to the current situation rather than assuming they transfer verbatim.
- **Project lore / references:** trust unless the task surfaces a contradiction.

## On a mismatch — act on reality, reconcile the memory BY CATEGORY

When reality disagrees with a recalled leaf, base your work on REALITY, and reconcile the leaf
according to its category and that category's discipline:

- **`self_improvement` (gated):** do NOT auto-write. PROPOSE the correction through the
  propose-then-confirm path (the per-lesson `AskUserQuestion`), stating what is now wrong and the
  fix; save only on the user's in-turn yes (`userRequested:true`). See `memory-write-gate`.
- **`knowledge` / `plans` / `investigations` / `issues` (non-gated):** UPDATE the leaf in place —
  search-then-upsert by the same `name` (rule 16), or `write_memory` with `supersedes` — carrying
  its identity forward, and REPORT what you changed. An `issues` update keeps its topology `path`
  (see `topology-path-routing`). Match the door to the correction: when only the FRONTMATTER is
  stale (a facet, a tag, the priority) use `update_document_metadata`, which sends no body at all;
  when the BODY is stale, edit the leaf file and re-save by path (`cli.mjs save-leaf --file`)
  rather than re-emitting the whole document through a tool argument.
- If you cannot tell whether the divergence is genuine staleness or a local exception that should
  NOT rewrite the leaf, ASK the user rather than guessing.

## Always surface it; strong default, not a blocker

Tell the user what you validated, what diverged, and what you updated (or propose to update) —
never fix or flag silently. This is a **strong default (P1)** you apply whenever a recalled fact
is load-bearing for the work. It is NOT a hard gate that halts on every trivial drift, and it
NEVER licenses an un-consented write to the gated `self_improvement` category.

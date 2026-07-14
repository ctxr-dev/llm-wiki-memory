---
name: priority
description: Every memory atom carries memory.priority (P0 hard-constraint / P1 strong-default / P2 contextual). Optional on save (the engine fills a rubric default by atom_type); NEVER self-assign P0 (scarce, user/explicit only). At recall, relevance ranks first and priority breaks near-ties + decides which bodies survive the budget; apply higher priority first, P0 governs contradictions.
---

<!-- CANONICAL SOURCE: .llm-wiki-memory/src/templates/rules/priority.md
     bootstrap.sh wires an @-pointer to this file into .agents/rules/, .claude/rules/,
     and .cursor/rules/ (reference-only — no copies, no symlinks). Edit this canonical
     template; do NOT hand-edit a pointer. -->

# Priority (apply-strength) on every atom

Every wiki leaf carries a `memory.priority` field. It expresses **how strongly the
atom must be applied**, and it drives priority-aware recall. The three tiers, in
plain terms:

- **P0 — hard constraint.** A guardrail or invariant you must honour ("never do
  X", a locked policy/decision). When a P0 atom surfaces it is binding, and on a
  contradiction with a lower tier the **P0 governs**. P0 is deliberately SCARCE.
- **P1 — strong default.** Apply whenever it's relevant: decisions, confirmed
  lessons, traps/gotchas, active plans, investigations.
- **P2 — contextual.** Apply if relevant and there's room: reference material,
  project lore, raw daily capture, finished/archived plans.

## Assigning priority on save

- **It is OPTIONAL.** Omit it and the engine fills a **deterministic rubric**
  default by `atom_type`: `feedback-rule` / `decision` / `bug-root-cause` /
  `pattern-gotcha` / `investigation` → **P1**; `reference` / `project-lore` /
  `daily-capture` → **P2**; a plan → P1 while active, P2 when done/archived. So in
  normal flow you pass nothing.
- **NEVER self-assign P0.** P0 is reserved for an explicit user/human designation.
  The rubric never emits P0, and a non-gated write that requests `priority:"P0"`
  is **coerced to P1** by the server (it tells you so in `priorityNote`). Only set
  P0 when the user explicitly asks for it.
- **Gated lessons (self_improvement):** the priority value comes from the USER.
  When you propose the lesson in the propose-then-confirm, also offer a priority —
  default **P1**, and let the user pick **P0** (a guardrail) or **P2**
  (contextual). Pass `metadata.priority` with their choice; P0 is allowed here
  because it is user-confirmed.

## How priority affects recall

Relevance is still the gate. `search_memory` / `recall_lessons` rank by embedding
similarity first; priority only:

1. **breaks ties within a small cosine band** — among near-equally-relevant hits a
   P0/P1 is ordered above a P2, but a clearly-more-relevant hit keeps its rank
   (a low-relevance P0 is NOT promoted over a strong match); and
2. **decides which bodies survive the response budget** — when the budget is
   tight, the **lowest-priority bodies are trimmed first**, so a relevant hit is
   never dropped, just shortened.

Every returned hit is annotated with its `priority`. **Read and apply
higher-priority atoms first**, and when two retrieved atoms conflict, the
**higher priority governs (P0 overrides all)** — surface the trade-off rather than
silently following the lower one.

## Maintenance

- Existing leaves without a priority read as their rubric default; persist it with
  `node .llm-wiki-memory/src/scripts/cli.mjs backfill-priority` (deterministic, no
  LLM; `--dry-run` previews).
- Consolidate merges take the **highest** priority of the merged group, so a
  merge never demotes a P0/P1.
- The tie-break width is `recall.priorityBand` in `settings.yaml` (default 0.05).

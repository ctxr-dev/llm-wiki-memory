---
name: planning-methodology
description: How to write EVERY non-trivial implementation plan in this workspace — learning-first, diagram-rich, grilled, options-with-recommendation, and checkbox/state disciplined. Authored once in the llm-wiki-memory package (templates/rules/) and rendered to .agents/rules, .claude/rules, and .cursor/rules so Claude Code, Cursor, and Codex share one methodology.
---

<!-- CANONICAL SOURCE: .llm-wiki-memory/src/templates/rules/planning-methodology.md
     bootstrap.sh renders this to .agents/rules/, .claude/rules/, and .cursor/rules/.
     Edit the template and re-render; do NOT hand-edit a rendered copy. -->

# Planning methodology

This rule governs **every non-trivial implementation plan** in this workspace. A plan is not a to-do list — it is a *teaching artifact* that proves you understand the system before you change it. Skip it only for truly trivial work (a typo, a one-line rename); everything else gets a plan that satisfies the principles below.

## Five non-negotiable principles

1. **Learning-first.** Write for a reader who has never seen this part of the system. Explain the full workflow: how data flows, how services interact, what triggers what, and where the change fits. The plan should teach the architecture, not just enumerate edits.
2. **Diagrams required.** Include Mermaid diagrams that *explain the system* (not restate the task steps). At minimum a **sequence** diagram for the main flow, plus whichever fit: **component/architecture**, **data-flow**, **state**, and **ER** (for data models).
3. **Grill-me by default.** Interrogate the plan until every decision branch is resolved. Verify in code — never assume an access path, signature, or contract. Surface genuine unknowns as explicit questions before finalizing.
4. **Options with a recommendation.** For each meaningful decision, present 2–4 viable approaches with pros / cons / risks, then state your recommended choice and why. Record settled choices under "Locked decisions" with the reason each was chosen.
5. **Plan hygiene — checkboxes + state.** Max-granularity checkboxes for every actionable step; track the plan's lifecycle state. Details below.

## Mandatory plan structure (in this order)

1. **Context** — what is changing and *why*; the problem/need; current state; constraints.
2. **Locked decisions** — settled choices, each with its reason.
3. **Phased, max-granularity checkboxes** — `- [ ]` at maximum granularity with nested sub-items. Every file change, every test, every verification step is its own checkbox.
4. **Edge cases** — empty/missing inputs, error conditions, boundary values, null handling, concurrency, no-regression.
5. **Review cycle** — the standard closing phases (below).
6. **Critical files** — the files in scope; name reused functions/utilities to avoid reinventing.
7. **Verification** — how to prove it works end-to-end (run it, tests, tooling).

**Standard closing phases — every plan ends with these:**
1. **Full test suite** in the target project.
2. **Edge-case analysis** — find missing/outdated tests; add them.
3. **Code-review cycle** — after implementation + tests pass, review all changed files. Fix EVERY issue (blocking, minor, *or* observation), re-think edge cases, fix tests, re-review. Repeat until the review is completely clean.

## Diagrams (Mermaid) — explain the system, not the task

Use ` ```mermaid ` fenced blocks; label nodes with real names from the code. Pick the diagrams that teach this change:

- **Sequence** (required): the main runtime flow — who calls whom, in what order, with the branch/skip logic.
- **Component / architecture**: services/modules/topics/datastores and how they connect; mark where this change lands.
- **Data-flow**: how a payload is read, transformed, and emitted; field provenance for data models.
- **State**: lifecycles or state machines (e.g. a record's status, the plan's own lifecycle).
- **ER**: entities/schemas and their relationships, for data-model work.

A diagram that merely restates the checkbox steps does not count — it must reveal structure the prose can't.

## Grill-me

- Use the `grill-me` discipline: stress-test the plan, resolving each branch of the decision tree.
- **Verify, don't assume.** Read the actual source for every contract, access path, and method signature. If two sources disagree, that's a signal something is unknown — resolve it.
- **Fetch fresh first.** `git fetch` the relevant repos and base claims on the merged ref, not a possibly-stale working tree. Pin cross-repo contracts from real code.
- Put genuine unknowns to the user as explicit questions (e.g. AskUserQuestion) BEFORE finalizing — don't bury an assumption in a checkbox.

## Options with a recommendation

For each meaningful decision, list the viable approaches with **pros / cons / risks**, then give the **recommended** choice and the reason. Fold the resolved ones into "Locked decisions" as `option → choice → why`.

## Checkboxes & plan-state (cross-tool summary)

- **Max-granularity checkboxes:** every file change, every test, every verification is its own `- [ ]`, with nested sub-items. No gaps.
- **Lifecycle states:** `pending → in-progress → done`, or `archived`. Transition by re-saving the plan with the new state.
- **Tick as you go:** mark `- [x]` only when an item is done *and* verified. If a checkbox state flips, add a nested dated log entry explaining why; the log accumulates.
- **`done` only after** every box is checked, all tests pass, the review cycle is clean (zero issues of any severity), AND the user explicitly confirms.
- **Plans never include auto-commit/push/PR steps** — the user gates all git writes. Hand off; let the user commit.

> **Claude Code:** the authoritative rules are `.claude/rules/plans-lifecycle.md` (states + checkboxes), `.claude/rules/implementation-review-loop.md` (review cycle), and `.claude/rules/testing.md` (coverage). This section is the cross-tool summary so Cursor/Codex — which don't auto-load `.claude/rules/` — follow the same discipline.

## Where plans live

- The plan-mode scratch file (e.g. `~/.claude/plans/<slug>.md`) is **ephemeral and per-client**.
- The **durable home is the local wiki**:
  - **No tracker** → the `plans` category via `save_to_dataset(dataset="plans", …)`; state lives in frontmatter `status:`. (Always available.)
  - **Tracker-bound** (a Jira/Linear/GitHub issue exists) → the `issues` tree via `save_to_dataset(dataset="issues", …)` with the `plan` file_kind and a `lifecycle` facet (`pending|in-progress|done|archived`) — **only if this project's wiki layout declares `issues` support.**
- **Validate `issues` support before relying on it** — it is layout-dependent and is NOT guaranteed in every project:
  1. `list_datasets` includes `issues`; **and**
  2. `test_path_compiler` (or `validate_topology`) resolves the tracker plan path with **no unresolved placeholders and no warnings**.
- If `issues` is **not** supported in this project's `<wiki>/.layout/layout.yaml`, do **not** improvise a path or materialize an orphan tree. **Prompt the user to integrate `issues` support** (add the `issues` category + tracker topology to the layout), and fall back to the `plans` category in the meantime.
- **Routing precedence (universal capture + promote):** the ExitPlanMode hook universally captures EVERY approved plan to the `plans` category as `<slug>.plan.md`, seeding lifecycle frontmatter (`status` + `progress`) from its checkboxes. For a **tracker-bound** plan, the agent then promotes it to the `issues` tree (`save_to_dataset(dataset="issues", …)`) and **disables/deletes the `plans/` fallback copy** (`disable_document` / `delete_document`). Net end state: custom plans live in `plans/`, tracker plans in `issues/`, and no approved plan is ever lost. Every plan follows the full lifecycle (`status: pending|in-progress|done|archived`, max-granularity checkboxes, dated change-logs).
- See the `plan-capture` skill / `plans-lifecycle` rule for the full contract.

## Before you finalize — checklist

- [ ] Fetched fresh; every contract/signature verified in code (no guesses).
- [ ] `recall_lessons` consulted; relevant lessons applied.
- [ ] Required diagrams present and genuinely explanatory.
- [ ] Each meaningful decision has options + a recommendation; settled ones in "Locked decisions".
- [ ] Checkboxes at max granularity; edge cases enumerated.
- [ ] Standard closing phases (test run → edge-case pass → review-until-clean) included.
- [ ] Open questions resolved, or explicitly surfaced to the user.

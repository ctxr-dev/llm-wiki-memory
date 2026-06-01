---
name: scala-review-gate
description: Mandatory gate for ALL Scala work in this workspace — every changed or new .scala file (source AND tests), however small, must pass a scala-essentials compliance review before the change is considered done. Authored once in the llm-wiki-memory package and rendered to .agents/rules, .claude/rules, and .cursor/rules so Claude Code, Cursor, and Codex enforce it uniformly.
---

<!-- CANONICAL SOURCE: .llm-wiki-memory/src/templates/rules/scala-review-gate.md
     bootstrap.sh renders this to .agents/rules/, .claude/rules/, and .cursor/rules/.
     Edit the template and re-render; do NOT hand-edit a rendered copy. -->

# Scala review gate

**Every Scala change in this workspace — source *and* tests, however small — must pass a `scala-essentials` compliance review before it is "done."** This is a hard gate and a required part of the standard review cycle (see `implementation-review-loop.md`).

## How to apply

1. **While writing:** load and follow the workspace `scala-essentials` skill (idiomatic Scala 2.13: immutability, `Option`/`Either`/`Try` safety, pattern matching, companion-object factories, small single-purpose functions, SOLID, clean naming). If that skill is not installed in a given workspace, apply the checklist below directly.
2. **In the review cycle:** one reviewer's explicit job is `scala-essentials` compliance over every changed/new `.scala` file. Treat any violation as a review issue to fix. If a rule genuinely makes the code worse in a specific case, **raise it with the user** — never deviate silently.

## Non-negotiable checklist (the common violations)

- No `.get` / `.head` / `.tail` / `.reduce` on `Option`/collections; no `.asInstanceOf`, `@unchecked`, `return`, or `var`.
- `Option` for absence, `Either[E, A]` for typed domain errors, `Try` only at the impure/Java boundary (convert to `Either`/`Option` immediately).
- Exhaustive pattern matches; flat `match` over nested `if/else`.
- Companion-object factories — `def resource(...)` / smart constructors, **not** `apply` — for resource or validated construction (team convention).
- For-comprehensions use `=` bindings; no `val`s inside the `yield` block.
- Functions do one thing (≈≤10 lines, ≤2 params → else extract a case class); one abstraction level; no flag (`Boolean`) parameters.
- Intent-revealing names (no `data`/`info`/`tmp`/`manager`/`utils`); Scala naming (UpperCamelCase types, lowerCamelCase vals, UpperCamelCase constants). Externally-defined contract names (Avro/proto/bin keys) are exempt — they are not ours to rename.
- Public method return types annotated; imports grouped (java → scala → third-party → project) and specific.
- Immutability by default (`case class` + `.copy`); value classes / sealed ADTs over primitive obsession where they add safety.
- **Tests:** follow the repo's EXISTING test conventions (framework, base specs, fakes/mocks). Where they conflict with the skill's "hand-written fakes, no mocking frameworks" preference, **consistency with the repo wins** — note the deviation rather than introducing a one-off style.

## Scope

Applies to every `.scala` change in this workspace (all repos under it), in any agent or tool. The gate is satisfied only when the review finds **zero** `scala-essentials` violations — or the user has explicitly accepted a documented deviation.

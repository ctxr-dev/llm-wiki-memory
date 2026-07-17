# Specs — historical implementation plans

This directory is an in-repo archive of the **plans** that drove past
`llm-wiki-memory` work, kept as specs so the *what* and *why* of each change
survive alongside the code (not only in the local memory wiki, which is
per-machine and not committed here).

Each file is a plan captured verbatim at the time it was written — its Section 0
(plain-language summary), context, locked decisions, diagrams, and phased
checkboxes. They are a **point-in-time record**, not living documentation: where
a plan and the current code disagree, the code wins. Treat these as "why we did
it this way", then verify against the source.

New plans for non-trivial work should be added here (copied from the wiki
`plans` category or the plan-mode scratch file) when the work lands, so this
archive stays complete.

## Index

| Spec | Topic |
|---|---|
| [configurable-full-leaves-and-absorb.md](./configurable-full-leaves-and-absorb.md) | Configurable `full` leaves (whole-document, embedded whole) + `absorb` — importing existing markdown into a wiki as full leaves (MCP tool + CLI batch); the shared `repo` template as a full-doc team wiki. |
| [remove-recall-touch-consolidation-opt-in-hot-reload.md](./remove-recall-touch-consolidation-opt-in-hot-reload.md) | Remove the recall-touch write, make consolidation opt-in per category, widen MCP hot-reload. |
| [memory-write-gate-hardening-and-consolidation.md](./memory-write-gate-hardening-and-consolidation.md) | Propose-then-confirm write-gate hardening + search-driven consolidation orchestrator. |
| [dot-layout-rename-and-subject-hardening.md](./dot-layout-rename-and-subject-hardening.md) | Rename the layout dir to `.layout`; harden the `subject` placement axis. |
| [memory-quality-remediation.md](./memory-quality-remediation.md) | Corpus quality remediation + consolidation/dedup upgrades. |
| [cron-path-provider-escalation.md](./cron-path-provider-escalation.md) | Cron `PATH` fix + provider-unavailable observability / escalation. |
| [agentic-config-canonicalization-refactor.md](./agentic-config-canonicalization-refactor.md) | Single-source the `.agents`/`.claude`/`.cursor` rule + skill pointer files via `bootstrap.sh`. |
| [migrate-to-llm-wiki-memory.md](./migrate-to-llm-wiki-memory.md) | Migrate the workspace's memory system onto `llm-wiki-memory`. |

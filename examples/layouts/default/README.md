# `default` layout

The baseline topology that ships with llm-wiki-memory.

## When to use

A fresh install on a workspace that doesn't need custom topologies. This is
also the right starting point if you plan to layer additional categories on
later — every other template in `examples/layouts/` extends this one.

## What you get

Five categories, nested by frontmatter facets so the on-disk tree mirrors
the search filter shape:

| Category | Nesting | Purpose |
|---|---|---|
| `knowledge/` | `area/atom_type/` | Long-lived facts, decisions, lore, and gotchas |
| `self_improvement/` | `area/task_type/` | Self-improvement lessons (dedup by `error_pattern`) |
| `plans/` | `area/` | Approved and in-flight plans |
| `investigations/` | `area/` | Investigation and analysis artefacts |
| `daily/` | `yyyy/mm/dd/` | Raw captured memory atoms by date |

Missing-facet sentinels keep the tree predictable:
`area → unscoped`, `task_type → unknown`, `atom_type → untyped`.

## Caller contract

Writers pass `metadata.area`, `metadata.atom_type` (for knowledge),
`metadata.task_type` (for self_improvement) on the MCP `write_memory` /
`save_to_dataset` calls. The skill computes placement from these; no `path`
override is needed.

## Path examples

```
knowledge/billing/decision/billing-2026-q2-strategy.md
self_improvement/auth/migration/oauth-rotation-pitfall.md
plans/checkout/redesign-checkout-flow.md
investigations/payments/stripe-3ds2-failures.md
daily/2026/05/26/daily-20260526-093955.md
```

## When NOT to use

If you need:

- Per-issue trees (Jira/GitHub/Linear) — use `tracker-issues/` instead.
- Anything where the path depends on caller-computed values that aren't
  frontmatter facets — declare a custom topology with `strategy: caller_path`
  and a helper module (see `tracker-issues/` for a reference).

## Install

```bash
cp examples/layouts/default/.llmwiki.layout.yaml <wiki-root>/.llmwiki.layout.yaml
node scripts/cli.mjs validate-layout <wiki-root>/.llmwiki.layout.yaml
```

Then `node scripts/cli.mjs init` (or `bootstrap.sh`) to materialise the wiki.

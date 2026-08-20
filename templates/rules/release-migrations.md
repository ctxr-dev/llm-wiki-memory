---
name: release-migrations
description: A BREAKING change to llm-wiki-memory ITSELF must ship an idempotent, state-detecting migration under scripts/migrations/ — not an upgrade runbook. Prose only for what code cannot do, capped at 8 lines. Applies to the llm-wiki-memory engine repository ONLY, never to a consuming project.
---

# Breaking changes ship a MIGRATION, not a runbook

## Scope — read this first

This rule governs **the llm-wiki-memory engine repository itself**. It describes
that repo's own internal release machinery.

**It does NOT apply to any other project, repository, or workspace — ever.** If you
are working in a consuming project (any repo that merely *uses* the memory system),
this rule gives you nothing to do: never create `scripts/migrations/`, never create
a `docs/releases/` tree, never write an upgrade runbook there. Those are the
engine's internals, not a convention to spread.

## The gate

> Every breaking change to the engine MUST ship an **idempotent, state-detecting
> migration**. A change that only *documents* a manual upgrade step fails this rule.

Why: an install may be any number of versions behind. If upgrading means reading and
performing N runbooks, the cost grows without bound and eventually exceeds what any
operator — or any model's context — can carry. A migration that detects its own
necessity costs the reader nothing, however far behind they are.

Upgrading, from any version, is therefore always just:

```
git pull && npm install && ./bootstrap.sh
```

## Writing one

`scripts/migrations/<yyyy>/<mm>/<dd>/<NNN>-<slug>.mjs`, registered in
`scripts/migrations/migrations.json` — that array is the **order**, and the `id` is
both the module path and the ledger key.

```js
export const id = "2026/06/03/001-settings-yaml";
export const title = "settings.yaml replaces .env application config";
export function detect(ctx) {} // does THIS install still need it?
export function apply(ctx) {}  // idempotent; safe to run twice
export const decision = "…";   // OPTIONAL, one line — see below
```

- **`phase`**: `settings` runs before the wiki exists, `data` after.
- **Prefer an adapter.** If the logic already exists, the migration declares
  `detect`/`apply` and delegates — the behaviour and its tests stay where they are.
- **A failure ABORTS the install.** Half-migrated-and-quiet is the worst outcome. If
  something is genuinely optional, it is not a migration.
- **Never hand-edit the ledger** (`state/.migrations.json`) or anything else under
  `state/` — it is engine-written, and a PreToolUse hook denies agent writes to it.
  Use `cli.mjs migrations --explain` / `--remigrate`.

## When prose is allowed

Only when code genuinely cannot decide: a **human choice**, a **credential**, or an
**external action**. Everything else belongs in the migration.

Even then, the migration MUST still apply a safe default automatically, so an
operator who reads nothing ends up correct. Export a one-line `decision` naming what
was chosen; the runner prints it after the upgrade, so nobody opens a file.

If more is genuinely needed, add `README.md` beside the migration — **capped at 8
lines, enforced by a test**. It exists for the decision alone; explanation belongs in
the migration's own comments.

## Retiring old migrations

Periodically fold settled migrations into a baseline: declare a minimum supported
version, delete the migrations below it, and have an older install reinstall rather
than upgrade. This bounds the tree permanently instead of letting it grow forever.

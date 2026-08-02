---
name: write-migration
description: Author an idempotent, state-detecting migration under scripts/migrations/ for a breaking llm-wiki-memory change. Use when shipping a breaking change to the engine, or when asked to write a migration / upgrade path. Replaces the retired release-runbook flow.
---

# Skill: write a release migration

Applies to **the llm-wiki-memory engine repo only** — never a consuming project.

A breaking change ships a migration, not a runbook. Full criteria:
`.agents/rules/release-migrations-authoring.md`.

## Procedure

1. **Pick the slot.** `date -u +%Y/%m/%d`, then the next free `NNN` in that day's
   folder: `scripts/migrations/<yyyy>/<mm>/<dd>/<NNN>-<slug>.mjs`.
2. **Pick the phase.** Does it need the wiki to exist? `data`. Does it fix config the
   rest of bootstrap reads? `settings`.
3. **Write `detect(ctx)` FIRST** — read-only, answers "does this install still need
   it?". This is the whole design: it is what makes reading a runbook unnecessary.
4. **Write `apply(ctx)`** — idempotent. Where the logic already exists, delegate to
   it (see `2026/06/03/001-settings-yaml.mjs`, an adapter over `migrate-settings.mjs`).
5. **Apply a safe default** for anything a human might otherwise choose, and export a
   one-line `decision` saying what was chosen. The runner prints it; nobody opens a file.
6. **Register it** in `scripts/migrations/migrations.json` — append to the array.
7. **Test it**: fresh install (detect false), stale install (detect true → apply),
   re-run (idempotent). Use a tmp dataDir, never the real brain.
8. **Only if code genuinely cannot decide**, add `README.md` beside it — ≤8 lines,
   enforced by `test/migrations-tree.test.mjs`.

## Verify

```
node scripts/cli.mjs migrations --explain      # lists it, settled state
node scripts/cli.mjs migrations --remigrate    # forces a full re-detect
npm test                                       # includes the tree gates
```

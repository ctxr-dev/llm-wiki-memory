# Authoring a release migration (llm-wiki-memory itself)

This rule governs **developing llm-wiki-memory itself**. (`templates/rules/release-migrations.md`
is the SHIPPED companion that consuming installs receive; it deliberately says the
same gate in fewer words and states that it applies to no other project.)

## The gate

A breaking change ships an **idempotent, state-detecting migration** — never an
upgrade runbook. If you find yourself writing "then the operator runs X", automate X.

## Checklist

- [ ] `scripts/migrations/<yyyy>/<mm>/<dd>/<NNN>-<slug>.mjs`, id === its path.
- [ ] Registered in `scripts/migrations/migrations.json`. **That array is the order**
      — append, never reorder, since the id is the ledger key.
- [ ] `phase`: `settings` (before the wiki exists) or `data` (after).
- [ ] Exports `id`, `title`, `detect(ctx)`, `apply(ctx)`; optional one-line `decision`.
- [ ] `detect()` is READ-ONLY and answers "does THIS install still need it?".
- [ ] `apply()` is idempotent — running it twice is harmless.
- [ ] Delegates to existing logic where possible (an ADAPTER), so behaviour and its
      tests stay put. `2026/06/03/001-settings-yaml.mjs` is the reference shape.
- [ ] A safe default is applied automatically, so an operator who reads nothing is
      still correct.
- [ ] Tests: a fresh install (detect false), a stale install (detect true → apply),
      and a re-run (idempotent). Drive them through a tmp dataDir.
- [ ] Prose ONLY for a human choice / credential / external action — `README.md`
      beside the migration, **≤8 lines** (enforced by `test/migrations-tree.test.mjs`).

## Never

- Never write `docs/releases/**` or an `update-prompt.md`. That mechanism is retired.
- Never hand-edit `state/.migrations.json` — engine-written; a PreToolUse hook denies
  it. Use `cli.mjs migrations --explain` / `--remigrate`.
- Never gate a migration behind a flag. Every migration self-detects, so a flag can
  only ever cause an install to silently skip one.
- Never apply this structure to a CONSUMING repository. It is the engine's own.

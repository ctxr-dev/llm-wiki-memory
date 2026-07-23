# llm-wiki-memory: judge-gated durable distillation + layout-driven gating (2026-07-22)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past the
**2026-07-22** release. This is a **LIGHT advisory**, not a heavy migration: there is
**no default-behaviour flip** — knowledge stays auto-distilled and ungated, and
`self_improvement` stays gated. Everything below is backward-compatible; you mainly
need to know three things changed.

**WHO IS AFFECTED — everyone.** The change tightens the QUALITY of memory the engine
writes automatically (compile + consolidate) and interactively, and makes "which
categories need consent" a per-wiki layout policy. Nothing you must do to keep
working; a few knobs and one settings key were renamed (the old name still works).

## WHAT'S NEW

- **(quality) a mandatory judge-in-the-loop after ANY machine-generated leaf.** Compile
  auto-distill and consolidate refresh/merge now run each produced leaf through a second
  LLM "judge" against the durability + content-quality rubric, up to `quality.maxRounds`
  (default 3) generate→judge→revise cycles; after the last failed round the best attempt
  is kept and stamped `memory.quality: "unverified"` (never lost). Interactive saves into
  `knowledge` / `self_improvement` are judged too: on a fail the tool returns
  `{ok:false, error:"quality-judge-rejected", recommendation}` WITHOUT writing — revise
  and resubmit (≤3×), or resubmit with `write.acceptQuality:true` to store the best
  attempt flagged. **FAIL-CLOSED:** if the judge LLM can't run, generation is blocked
  (compile atom stays in daily; consolidate skips; interactive returns a retry error) —
  never a silent unjudged write.
- **(durability) compile now enforces the durability rules on the auto-distill path.** The
  flush/compile prompts + a deterministic `scoreAtomQuality` backstop reject leaves
  dominated by volatile code locators (line numbers, `file.ext:NN`, `Lnn`) with no
  conceptual framing; consolidate-refresh de-volatilizes drifted locators instead of
  re-pointing them. Result: higher-signal, refactor-proof auto-knowledge.
- **(gating) write-gating is now LAYOUT-DRIVEN + opt-in.** Two optional per-category
  layout flags: `gated: true` (require the consent gate) and `auto_distill: false` (keep a
  category human-only). Name-keyed code defaults preserve today's behaviour with NO YAML
  edit: `self_improvement` is gated, everything else is not; every category auto-distills.
  `get_memory_config` now reports each level's `gated` + `autoDistillOff` category names.
- **(settings, RENAMED — old name still works) `gate.selfImprovementEnabled` → `gate.enabled`.**
  It now governs EVERY layout-gated category, not just self_improvement. The old key is a
  permanent alias (the YAML overlay maps it onto `gate.enabled`), so existing settings.yaml
  files keep working unchanged. New: `quality.judgeEnabled` (default true) + `quality.maxRounds`
  (default 3) to tune / disable the judge.

## PROCEDURE

1. Update the runtime clone:
   ```
   cd ~/.llm-wiki-memory/src && git fetch && git merge --ff-only && npm install
   ```
2. Re-run bootstrap (idempotent — it rewrites the rule/skill `@`-pointers byte-stably and
   is a no-op if already current):
   ```
   bash ~/.llm-wiki-memory/src/bootstrap.sh
   ```
3. No data migration is required. OPTIONAL, only if you want consolidate to clean existing
   volatile "bumblebee-style" leaves over time: ensure your wiki's `.layout/layout.yaml`
   declares `consolidate: refine` on `knowledge`/`self_improvement` (this release adds those
   keys to the default/example layouts and to the private brain layout), then enable
   consolidation with `consolidate.enabled: true` in settings.yaml — it is opt-in and OFF by
   default.

## DECISIONS

- **Do NOT rename `gate.selfImprovementEnabled` in your settings.yaml** unless you want to —
  the alias is permanent. If you do rename it to `gate.enabled`, behaviour is identical.
- **Judge cost.** The judge adds up to ~6 LLM calls per compiled leaf and +≤3 round-trips per
  interactive save into a curated category. If you run offline / in CI / do a bulk import, set
  `quality.judgeEnabled: false` (it fails closed otherwise — a persistently-down provider halts
  distillation by design).
- **Opting a category in/out is per-wiki and optional.** Set `gated: true` / `auto_distill: false`
  on a category in that wiki's `.layout/layout.yaml`. `save_lesson` stays gated regardless.

## VERIFICATION

- `node ~/.llm-wiki-memory/src/scripts/cli.mjs where` — provider + wiki resolve as before.
- `get_memory_config` → each `levels[]` entry carries `gated` (self_improvement by default) and
  `autoDistillOff` (empty by default). `categories` is still a flat string[].
- A settings.yaml with the OLD `gate.selfImprovementEnabled: false` still disables the L3 gate
  (alias) — confirm a self_improvement save without `userRequested:true` is refused when the key
  is true, allowed when false.
- Full engine suite green: `cd ~/.llm-wiki-memory/src && npm test`. The live judge confidence
  gate is opt-in: `MEMORY_LLM_LIVE=1 npm run test:llm-live` (needs the `claude` CLI on PATH).

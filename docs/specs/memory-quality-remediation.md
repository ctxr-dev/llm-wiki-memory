---
id: memory-quality-remediation.plan
type: primary
depth_role: leaf
focus: 'Memory-quality remediation: corpus fixes + consolidation upgrades'
parents:
  - index.md
covers:
  - 'Memory-quality remediation: corpus fixes + consolidation upgrades'
  - '---'
  - covers memory-quality
  - covers consolidation
  - covers dedup
  - covers facets
tags:
  - memory-quality
  - consolidation
  - dedup
  - facets
source:
  origin: inline
  hash: 'sha256:e75634156156a1d0d88557e405e8d153dc0f5b96288d1ecc6e143ca3f0b1c541'
updated: '2026-06-04'
memory:
  atom_type: plan
  project_module: repos
  area: memory-system
  task_type: planning
  status: active
  tags: 'memory-quality,consolidation,dedup,facets'
  last_recalled_at: '2026-07-02T09:10:49.924Z'
  recall_count: 4
  priority: P2
status: done
progress:
  total: 8
  done: 8
  label: 8/8
last_updated: '2026-07-17'
---

---
status: in-progress
---

# Memory-quality remediation: corpus fixes + consolidation upgrades

## Context

Corpus audit (2026-06-04) found 9+ true-duplicate pairs stranded below the 0.97 merge floor, facet drift, 11 mid-word truncations, 10 recall-invisible legacy lessons, contradictory lifecycle records, and that consolidate's LLM passes had never run (launchd PATH bug, fixed separately). All 18 remediation decisions individually grilled and approved (16 in the planning grill + live-run scope + band floor 0.93).

## Outcome — all phases executed 2026-06-04/05

- [x] P1 area normalization: 18 leaves relocated (memory micro-areas → memory-system / llm-wiki-memory; unknown → conventions / version-control); profanity evidence paraphrased
- [x] P2 truncation repairs: 3 bodies completed (editorial — the source dailies carried the same cut, confirming flush-time truncation), 5 titles re-cut at word boundaries, 1 archived leaf skipped (superseded), 1 folded into P3
- [x] P3 manual merges: git-gate 5→2 (knowledge + lesson keepers enriched), wrapper 2→1, recursion lessons 2→1 (throw-vs-fallback contradiction resolved toward dev-principles)
- [x] P4 legacy lessons: 8 backfilled with error_pattern/evidence/tags + relocated to canonical tree; 2 archived (stub + retired plans-folder convention)
- [x] P5 lifecycle records: dot-layout → done, memory-hardening → done (shipped-elsewhere note), DEV-129957 single frontmatter (verified-in-prod), cron-path plan → done
- [x] P6 duplicate merge: dry-run at cluster 0.88 exposed that cluster scores run ~0.05 below raw cosine AND that the LLM judge would merge 3 user-locked COMPLEMENTARY pairs → user re-approved scope: live run at 0.93 (5 pairs merged, 0 errors) + manual rest (3 pairs incl. judged prefer-deterministic merge) + the slipped svg-dividers pair folded after the final scan. Found+fixed: cli.mjs silently ignored space-form --cosine-threshold (both early dry-runs ran at 0.97)
- [x] P7 code (uncommitted in src, 905/905 tests): D1 truncateAtWordBoundary (slug.mjs + 4 cap sites, surrogate-safe incl. lone-high); D4 anti-fragmentation flush-prompt rule; D3 facet-vocab collector + {{KNOWN_AREAS}}/{{KNOWN_ERROR_PATTERNS}} prompt injection + preserve-keeper-facets lines; D2 consolidate.cosineBandFloor (default-off; band pairs are LLM-only — unreachable LLM = keep both; >=threshold fallback unchanged; "(band)" report reasons; cli aborts loudly on bare/invalid flags). Review loop: 1 round, all findings fixed (lone-surrogate, band-skip observability via recordEntity, invalid-value abort, CLI guard test)
- [x] P8 band enabled in this install at floor 0.93 (user-chosen over 0.90 after the complementary-pair evidence); sanity dry-run: 0 candidates (corpus clean, band armed for future drift)

## End state

- Active-pair scan ≥0.90 raw: 20 → 4, all four deliberate keeps (complementary or cross-category by design)
- validate ok, 0 errors; every merge/archive carries supersedes trails in the wiki git history
- Remaining for user: commit+push the src delta (16 modified + 3 new files); confirm plan done

## Critical files

src (uncommitted): scripts/lib/{slug,facet-vocab,settings,wiki-store}.mjs, scripts/{consolidate,compile,cli}.mjs, scripts/hooks/flush.mjs, prompts/{flush,compile,consolidate-merge,consolidate-refresh}.md, templates/settings.yaml, test/{slug,settings,facet-vocab,consolidate-band,consolidate-cli-mcp}.test.mjs, README.md (count 905). Install: .llm-wiki-memory/settings/settings.yaml (cosineBandFloor 0.93).

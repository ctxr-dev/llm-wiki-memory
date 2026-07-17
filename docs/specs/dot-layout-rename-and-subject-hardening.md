---
id: dot-layout-rename-and-subject-hardening.plan
type: primary
depth_role: leaf
focus: .layout rename + subject-axis hardening
parents:
  - index.md
covers:
  - .layout rename + subject-axis hardening
  - '---'
  - recall context for plan (3)
source:
  origin: inline
  hash: 'sha256:1850b9e7a5c664a2880587e495fb90f01a1ddf6dafe440925ef661f75704e3aa'
updated: '2026-06-04'
memory:
  atom_type: plan
  project_module: repos
  area: llm-wiki-memory
  task_type: planning
  status: active
  last_recalled_at: '2026-07-02T09:10:49.924Z'
  recall_count: 4
  priority: P2
status: done
progress:
  total: 57
  done: 57
  label: 57/57
last_updated: '2026-07-17'
---

---
status: done
---

# .layout rename + subject-axis hardening

> No Jira issue. Suggested filename: `dot_layout_rename_and_subject_hardening.md` — rename if you prefer.
> Status: **IMPLEMENTED — awaiting user confirmation to move to done/**. Created 2026-05-26.
>
> All phases (0-10) complete. Verification: 333 unit + 10 e2e (llm-wiki-memory)
> + 748 (skill-llm-wiki) green; validate / validate-layout / validate-topology
> clean on the live wiki; mandatory parallel review loop run twice → zero
> outstanding issues; final stale-path sweep clean. Commits on
> `feat/yaml-driven-layout-and-path-override` (llm-wiki-memory),
> `feat/layout-subfolder-and-topology` (skill, v1.4.0), and `main` (live wiki).

## Status log

- 2026-06-04: reconciled — phases were complete per plan prose; checkboxes ticked retroactively, status set done (user-approved audit fix).

## Context

Two user requests, bundled into one plan (user chose a single bundled plan):

1. **Rename the installed wiki's layout-contract folder** `<wiki>/layout/` → `<wiki>/.layout/`
   so special wiki folders (`.layout`, `.llmwiki`) are visually grouped and EXCLUDED from
   content indexing. Only the **install target** dir name changes; the repo's
   template-source files (`examples/layouts/<name>/`, `templates/llmwiki.layout.yaml`
   filename) keep their names. This is a **breaking** change for already-installed wikis
   and spans BOTH repos (`skill-llm-wiki` + `llm-wiki-memory`, lockstep `file:` dep).

2. **Harden** the subject-axis + install work shipped this session (parallel agents found
   1 confirmed bug + several gaps).

### Why `.layout` is safe (verified by agents)
- Every content walker in `skill-llm-wiki` skips `.`-prefixed entries
  (`indices/balance/validate/chunk/operators/soft-dag/join/shape-check/quality-metric/ingest`),
  so `.layout` becomes invisible to indexing exactly like `.llmwiki/` — no `index.md`
  generated, never flagged stray, and (unlike today's `layout/`) excluded from `build` ingest.
- The contract is resolved by EXPLICIT path (`paths.mjs::resolveLayoutContractPath`), not by
  walking, so changing the one path constant is sufficient for resolution.
- `balance.mjs` dotEntries cleanup only runs inside flatten-eligible passthrough subdirs;
  `.layout` lives only at the wiki ROOT, so it is never touched. (Add a guard test.)

### Why depth is currently safe + the flag decision
- `skill-llm-wiki` enforces `max_depth` ONLY during an explicit balance pass with
  `--max-depth` (`orchestrator.mjs:624` ← `plan.flags.max_depth`); `validate.mjs` only
  checks `depth_role` consistency, not a limit.
- `llm-wiki-memory` NEVER passes `--max-depth` (`buildHosted`→`build`, `rebuild`,
  `index-rebuild*`), which is why the deep retro subjects survived.
- User decision: instead of enforcing `max_depth` at write, add a **YAML flag to ignore
  depth**, set `true` for all llm-wiki-memory layouts, honored skill-side.

## Locked decisions

- **D1.** Folder rename is install-target only: `<wiki>/layout/` → `<wiki>/.layout/`.
  Template-source folder/file names unchanged.
- **D2.** Introduce a skill constant `LAYOUT_CONTRACT_DIR = ".layout"` (single source of
  truth) used by `paths.mjs`, `init.mjs`, testkit.
- **D3.** Depth: add a top-level layout flag **`ignore_max_depth: true`** (default
  false/absent = today's behavior). Set `true` in every llm-wiki-memory layout (examples +
  install template + live wiki). Honored skill-side (balance never flags overage when set).
  **ALSO** (user refinement): `max_depth` is already optional in our Zod schema and the skill
  never requires it from the contract — so REMOVE `max_depth` from every llm-wiki-memory
  layout (examples + template + live wiki). The `ignore_max_depth` flag is the single,
  self-documenting depth signal; `max_depth` becomes pure dead config we drop.
- **D4.** Bundled plan; one review-loop at the end.
- **D5.** The confirmed empty-segment bug is fixed FIRST (Phase 0) as it is a live
  correctness defect.
- **D6.** No backwards-compat shim for the old `layout/` path — instead, migrate the live
  wiki in-place (`git mv`). The skill drops the old path entirely (it had no legacy
  fallback implemented).

## Phases

### Phase 0 — Fix confirmed bug: empty/whitespace subject segments leak `untitled/`
- [x] In `wiki-store.mjs::pathFacetSegments`: drop segments whose slug is empty BEFORE the
      `untitled` sentinel applies (e.g. filter on a raw-normalize that yields "" for
      empty/punctuation input, not `slugify`'s `"untitled"`).
- [x] In `wiki-store.mjs::normaliseMeta` subject handling: same fix (shared helper to avoid
      divergence between the two call sites).
- [x] Decide shared helper: add `slugSegments(value)` (array|string → clean slug array,
      empties dropped) used by both; keep `slugify` untouched elsewhere.
- [x] Test: `subject: ["", "  ", "!!!", "kamon"]` → `["kamon"]` (no `untitled`).
- [x] Test: `subject: ["", ""]` → falls back to the `general` sentinel (empty after filter).
- [x] Test: `normaliseMeta` drops empty subject segments identically.
- [x] Run `test/subject-axis.test.mjs`; green.

### Phase 1 — `ignore_max_depth` flag + drop `max_depth`
- [x] `layout-validator.mjs`: add top-level `ignore_max_depth: z.boolean().optional()` to
      `LayoutYamlSchema`. Confirm `max_depth` stays optional on `LayoutEntrySchema`.
- [x] `wiki-store.mjs`: parse the flag in `ensureLayoutLoaded` (store in module state) — only
      needed if our layer ever consults it; otherwise document why it's a no-op for placement.
- [x] Confirm + comment that `buildHosted`/`rebuild`/`index-rebuild*` pass no `--max-depth`
      (so nothing flattens deep subjects today).
- [x] ~~skill-llm-wiki honors the contract flag in orchestrator balance~~ — **DROPPED after
      investigation.** The skill NEVER reads the layout-contract body (`resolveLayoutContractPath`
      is used only for wiki recognition in paths.mjs + testkit; the orchestrator parses no YAML).
      All `layout[]` fields incl. `max_depth` are consumed by llm-wiki-memory ONLY. The skill's
      depth enforcement is a separate `--max-depth` CLI flag that our build/rebuild/index-rebuild
      never pass — so llm-wiki-memory wikis are unbounded-depth BY CONSTRUCTION. `ignore_max_depth`
      is a declarative marker on our side; document the relationship in the layout comment.
      (A manual `skill build --max-depth N` remains an explicit user override.)
- [x] Set `ignore_max_depth: true` AND remove `max_depth:` from every entry in:
      `examples/layouts/default/layout.yaml`, `examples/layouts/tracker-issues/layout.yaml`,
      `templates/llmwiki.layout.yaml`, and the live `wiki/.layout/layout.yaml` (after Phase 2).
- [x] Test: validator accepts `ignore_max_depth: true` and a layout with NO `max_depth`; a
      deep subject places without error.

### Phase 2 — Rename `layout/` → `.layout/`
#### 2a. skill-llm-wiki (the engine)
- [x] `scripts/lib/paths.mjs`: add `export const LAYOUT_CONTRACT_DIR = ".layout";`
- [x] `paths.mjs::resolveLayoutContractPath`: `join(wikiPath, LAYOUT_CONTRACT_DIR, LAYOUT_CONTRACT_FILENAME)`.
- [x] `paths.mjs`: update comments (139-141, 161, 181) to `.layout`.
- [x] `scripts/lib/init.mjs:156`: `join(absTopic, LAYOUT_CONTRACT_DIR)` (import the const); update comments 38-39, 152-155.
- [x] `scripts/testkit/make-wiki-fixture.mjs:193`: use `LAYOUT_CONTRACT_DIR`; comments 144, 191.
- [x] `scripts/lib/intent.mjs:906`: hint string `…/.layout/layout.yaml`.
- [x] `balance.mjs`: add a guard test that a root-level `.layout/` is never deleted by the
      dotEntries flatten cleanup.
- [x] Update skill tests: `tests/unit/paths-recognition.test.mjs:58-59`,
      `tests/unit/init.test.mjs` (101,183,204,215-220,264), `tests/e2e/invariants-phase4.test.mjs:155-157`.
- [x] Bump `@ctxr/skill-llm-wiki` version (minor at least; breaking layout location).
- [x] Run skill test suite; green.
#### 2b. llm-wiki-memory (the memory layer)
- [x] `scripts/cli.mjs::cmdInit` (lines 28,32,42,98): `layout` → `.layout`; update comment line 23.
- [x] `scripts/lib/wiki-store.mjs:101`: `path.join(r, ".layout", "layout.yaml")`; update comments 33,100,168,431.
- [x] `scripts/lib/topology-runtime.mjs:66,70,80`: `.layout`.
- [x] `scripts/migrate-nest.mjs:62`: `.layout`.
- [x] `scripts/hooks/flush.mjs:444`: `.layout`.
- [x] `scripts/hooks/exit-plan-mode.mjs:130`: `.layout`.
- [x] `mcp-server/index.mjs:484` (and any other tool description mentioning `<wiki>/.llmwiki.layout.yaml` / layout path): correct to `<wiki>/.layout/layout.yaml`.
- [x] Update tests that write/read `<wiki>/layout/…`:
      `test/subject-axis.test.mjs:43-44`, `test/yaml-driven-layout.test.mjs:29,70,105`,
      `test/wiki-store.test.mjs:19,44-45`, `test/round-trip-principle.test.mjs:20-21,58-60,78,85`,
      `test/plan-sync.test.mjs:18,22,53,74`. (Leave `test/mcp-config.test.mjs:92` — that's
      template-source paths, unchanged.)
- [x] `bootstrap.sh`: ensure init creates `.layout`; no stale `layout/` reference.
#### 2c. live-wiki migration
- [x] `git mv` (in the wiki repo) `wiki/layout/` → `wiki/.layout/` (preserve `layout.yaml`,
      `to_path.mjs`, `from_path.mjs`).
- [x] Re-run `validate` + `validate-topology` + `validate-layout` against the live wiki; all clean.
- [x] Confirm no `wiki/layout/index.md` orphan was created previously; confirm `.layout` is
      not indexed (no `index.md` inside it, not in any category index).

### Phase 3 — `validate_layout` MCP tool (parity with `validate_topology`)
- [x] `mcp-server/index.mjs`: register `validate_layout` wrapping `validateLayoutFile`
      (optional `wiki_root`/`path`), returning the structured result.
- [x] Test (`test/mcp.test.mjs` or new): server exposes `validate_layout`; returns
      `{ok:false,…}` (no crash) for a missing/malformed layout.

### Phase 4 — `migrate-from-manifest.mjs` guards + tests
- [x] `planTarget`: guard a slash-less `entry.target` (reject or treat whole string as a
      single-segment under a default dir) instead of `dir=""`.
- [x] `migrateManifest`: detect two non-skip entries that compute the SAME target leaf →
      report a collision error rather than silent overwrite.
- [x] New `test/migrate-from-manifest.test.mjs`: classification→dataset mapping; `#heading`
      slice + missing-heading throw; whole-file read; source-missing per-entry failure;
      slash-less target guard; collision detection; dry-run output shape; ok/fail tally.

### Phase 5 — bootstrap `.agents/` idempotency
- [x] `bootstrap.sh`: stop unconditionally clobbering `.agents/mcp.json` + client files on
      re-run. Either merge (like `merge-config.mjs` for `.mcp.json`) or skip-if-user-modified,
      so a manually-added prompt_security wrapper / customization survives a re-run.
- [x] Test (or documented manual check): re-run preserves a user-edited `.agents/mcp.json`.

### Phase 6 — minor edge cases
- [x] `mcp-config.sh` / `bootstrap.sh`: make the `sed` substitution robust to a workspace
      path containing `#` (use a delimiter unlikely to appear, or escape). Verify quoting.
- [x] `env.mjs`: document (comment) the symlinked-`src` / non-standard-layout `WORKSPACE_DIR`
      derivation caveat; consider a one-line guard or clearer failure.
- [x] `topology-validator.mjs::sampleForFacet`: when a `pattern` facet has no canned match,
      emit a clearer "could not synthesize a sample matching pattern" message rather than a
      generic validateFacets mismatch.

### Phase 7 — missing-test backfill
- [x] `metaMatchesFilters` subject branch: seed leaves with differing subject arrays; assert
      a `{subject:[…]}` filter includes/excludes correctly (array + comma-string coercion).
- [x] save→relocate subject round-trip on disk: `saveDocument` with subject, then
      `updateDocMetadata` to relocate, assert recomputed nested path on disk + pruned source.
- [x] deep multi-level prune: relocating out of `…/observability/kamon/` prunes all newly
      emptied subject segments up to the first shared ancestor (not beyond).
- [x] CLI `validate-topology` subcommand: spawnSync test (args, `category` flag, exit code).
- [x] `env.mjs` `WORKSPACE_DIR`/`wikiRoot`/`embedCachePath` derivation tests (installed vs
      bare-checkout branch).
- [x] `topology-validator` branches: `path_template`-only kind; required facet with no
      facet_inputs + no enum; pattern facet with no matching candidate.

### Phase 8 — Full test suite
- [x] `cd llm-wiki-memory/src && npm test` → all green (compile/import clean first).
- [x] `cd skill-llm-wiki && <its test cmd>` → all green.

### Phase 9 — Edge-case analysis
- [x] Re-review missing/outdated tests after implementation; add any gaps surfaced.

### Phase 10 — Code review cycle (MANDATORY, repeat until clean)
- [x] Launch parallel scoped review agents (source correctness; tests; cross-repo rename
      consistency + skill interplay).
- [x] Fix ALL issues (blocking/minor/observation).
- [x] Re-review with fresh agents; repeat until zero issues.

## Edge cases to cover
- Empty/whitespace/punctuation subject segments (Phase 0).
- Subject deeper than `max_depth` with `ignore_max_depth: true` (Phase 1).
- `.layout` never indexed; contract still resolves; balance never deletes it (Phase 2).
- Already-installed wiki migration is in-place and reversible via git (Phase 2c).
- migrate-from-manifest collisions / slash-less / missing source/heading (Phase 4).
- bootstrap re-run preserving user `.agents/` + prompt_security wrapper (Phase 5).
- Workspace path with spaces / `#` (Phase 6).
- Symlinked `src` install (Phase 6).

## Review cycle
Per `implementation-review-loop.md`: parallel agents → fix all → re-review → repeat until
zero issues; then full test runs in BOTH repos; then edge-case pass.

## Critical files
- skill-llm-wiki: `scripts/lib/paths.mjs`, `scripts/lib/init.mjs`, `scripts/lib/orchestrator.mjs`,
  `scripts/lib/balance.mjs`, `scripts/lib/intent.mjs`, `scripts/testkit/make-wiki-fixture.mjs`, its tests, `package.json` (version).
- llm-wiki-memory: `scripts/cli.mjs`, `scripts/lib/wiki-store.mjs`, `scripts/lib/layout-validator.mjs`,
  `scripts/lib/topology-runtime.mjs`, `scripts/migrate-nest.mjs`, `scripts/migrate-from-manifest.mjs`,
  `scripts/hooks/{flush,exit-plan-mode}.mjs`, `mcp-server/index.mjs`, `bootstrap.sh`, `scripts/mcp-config.sh`,
  `scripts/lib/env.mjs`, `scripts/lib/topology-validator.mjs`, the example/template layouts, and tests.
- live wiki: `wiki/layout/` → `wiki/.layout/`.

## Verification
- Both test suites green.
- `validate` + `validate-layout` + `validate-topology` clean on the live wiki post-rename.
- Live wiki has `.layout/` (not `layout/`); `.layout` absent from all content indexes.
- Deep subject placement works with `ignore_max_depth: true`; empty subject segments never
  produce `untitled/`.
- Review loop produced zero issues.

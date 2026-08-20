# AGENTS.md

`llm-wiki-memory`: local LLM-wiki-backed memory for AI coding agents. Capture, compile,
recall, stored as leaves in a git-versioned local wiki (via `@ctxr/skill-llm-wiki`), with
local-embedding recall. No RAG, no Docker.

## Development discipline (`.agents/`)

Rules for working ON this repo are canonical in `.agents/rules/`:
`live-runtime-safety.md` (**read first** — this tree is executed live by the MCP server,
hooks and cron; editing it can destroy live data),
`dev-principles.md` (durability / parsing / injection / config invariants, cross-client
portability, wiki placement, LLM-pipeline contracts, hook design),
`defensive-invariants.md` (when a guard may be deleted; guard vs tripwire; why
"unreachable by derivation" is not "unreachable in fact"),
`verification-completeness.md` (what "green" is allowed to mean — the full gate chain,
falsifiable tests, named before/after invariants for durable artifacts),
`module-state-ownership.md` (one state machine per module; keyed memos over hot-reloading
settings; the disposal duty a rebuild path creates),
`testing.md` (harness + mocking conventions, the `/tmp/lwm-*` leak trap),
`release-migrations-authoring.md` (a breaking change ships an idempotent,
state-detecting migration under `scripts/migrations/` — never a runbook),
`self-observability.md` (capture confirmed engine bugs while you work),
and `docs-style.md` (README/docs conventions). Step-by-step procedures live in
`.agents/skills/` (`write-migration.md`, `run-tests-safely.md`,
`debug-capture-pipeline.md`, `verify-live-change.md`, `triage-review-findings.md`).

Per-client shadows reference the canonical files via `@`-imports — `.claude/rules/` +
`.claude/skills/` (Claude Code), `.cursor/rules/` (Cursor); always edit the `.agents/`
file, never a shadow. The shadows are GENERATED: run `npm run wire:dev-surfaces` after
adding or renaming a canonical file, and `test/dev-surface-mirror.test.mjs` fails the
gate if any client is missing one. That gate exists because Cursor silently went five
shadows short — a missing shadow means the rule simply does not apply in that client,
and nothing reports it.

These govern DEVELOPING llm-wiki-memory; the rules shipped into consumer installs live in
`templates/rules/` and are rendered by bootstrap — keep the two audiences separate.

## Layout

- `scripts/hooks/`: Claude Code lifecycle hooks (bash wrappers calling `.mjs`).
  `session-start` (triggers daily compile, prints routing context),
  `pre-compact`/`post-compact`/`session-end` (call `flush.mjs`, extract atoms to
  `daily/`), `exit-plan-mode` (capture approved plans to `plans/`).
- `scripts/compile.mjs`: once-per-day promotion of daily atoms into `knowledge/` and
  `self_improvement/`, with embedding plus metadata dedup; archives promoted dailies.
- `scripts/lib/wiki-commit.mjs`: the wiki auto-commit layer (`wiki.autoCommit`). Every
  wiki-store writer records per-leaf changes; orchestrators wrap a run in
  `withWikiCommit` so one logical operation = one commit to the wiki's OWN repo
  (toplevel-checked — it can never commit into the workspace repo). Best-effort;
  failures breadcrumb to `state/.wiki-commit.log`.
- `scripts/cron-job.mjs`: hourly compile+consolidate runner with two-tier logging
  (slim `state/.consolidate-attempts.log` + full sharded `state/logs/yyyy/mm/`),
  per-entity healing state (`state/.consolidate-entities.json`), and escalation
  issue reports (`issues/yyyy/mm/dd/<sig>.<version>.md`; episode index in
  `state/.issues-index.json`). Compile exit `69` (EX_UNAVAILABLE: daily docs
  pending, no LLM provider reachable) counts as a FAILED attempt but still runs
  consolidate; the synthetic entities `system:compile-llm-providers` /
  `system:consolidate-llm-providers` escalate persistent provider absence and
  resolve on the first healthy tick.
- `scripts/lib/wiki-store.mjs`: the storage seam, a drop-in for a RAG bridge whose every
  document is a wiki leaf. Drives `skill-llm-wiki` for index-rebuild, validate, heal,
  rebuild (it owns tree-building; we own category routing). Hardens arbitrary names via
  `normalizeLeafName` and rejects unknown categories. **Placement is always nested, never a
  flat category root:** non-daily categories nest by the metadata facets they are searched by
  (`knowledge/<project_module>/<atom_type>/`, `self_improvement/<project_module>/<task_type>/`,
  `plans/<project_module>/`, `investigations/<project_module>/`), daily by capture date (`daily/<yyyy>/<mm>/<dd>/`);
  absent facets use the sentinels `unscoped` (project_module) / `unknown` (task_type) / `untyped` (atom_type). Browsing the tree then mirrors how
  `searchMemoryFiltered` filters. Do NOT run the skill's topical `rebuild` on these memory
  wikis (it would re-cluster by meaning and fight the facet layout); re-nest deterministically
  with `node scripts/cli.mjs nest`.
- `scripts/migrate-nest.mjs`: `cli.mjs nest` - moves pre-existing flat leaves into the nested
  layout by reading each leaf's frontmatter facets (idempotent; `--dry-run`, `--check`).
- `scripts/lib/embed.mjs`: the FACADE over the embedding subsystem (default
  EmbeddingGemma-300m via `@huggingface/transformers`, inference in a worker thread so the
  event loop never blocks). One state machine per module behind it: `embed-backend-state.mjs`
  (which backend is serving), `embed-runner.mjs` (texts → vectors, single worker thread +
  in-process), `embed-cache-dims.mjs` (one vector dimension per cache file — a mixed file
  makes leaves score 0 and vanish from results),
  `embed-cache-io.mjs` (how the cache file is read/written), `embed-cache-guards.mjs` (whether
  a write is safe), `keyed-memo.mjs` (artefacts keyed on the settings that built them). Model
  families, retrieval prompts, and per-family dtype defaults resolve in `embed-inference.mjs`.
  The only retrieval engine (the skill has no query command). See
  `.agents/rules/module-state-ownership.md`.
- `scripts/lib/fatal-guard.mjs`: process-level diagnostics for the LONG-LIVED entrypoints
  only (MCP server, webapp daemon, embed worker). An `unhandledRejection` is reported to
  stderr plus one monitoring capture per signature and the process KEEPS SERVING — Node's
  default would otherwise remove a user's memory tools mid-session; an `uncaughtException`
  reports then exits 70 (EX_SOFTWARE). Deliberately NOT installed in hooks or the one-shot
  CLI, whose wrappers make node's exit code the hook's own and which must always exit 0.
- `scripts/lib/recall.mjs`: `recallLessons` (fall-back ladder), `searchMemory`, `saveLesson`.
- `scripts/lib/discipline.mjs`: single source of the memory discipline (MCP `instructions`
  and the SessionStart context).
- `scripts/lib/wiki-cli.mjs`: wrapper around the `skill-llm-wiki` bin; resolves it from
  `node_modules` (or `LLM_WIKI_SKILL_CLI`), runs `index-rebuild-one` for every touched
  ancestor dir, bottom-up.
- `mcp-server/index.mjs`: local stdio MCP server exposing `save_lesson`, `recall_lessons`,
  `save_to_dataset`, `search_memory`, and the document/audit tools.
- `templates/`: `.claude/settings.json` hooks, `.mcp.json`, `env.example`, vendor-neutral
  `agents/`, and discipline `skills/`. (Layout contracts are NOT here: the
  `examples/layouts/<name>/` folders are the single source, installed by `cli.mjs init
  --template <name>`.)
- `examples/layouts/<name>/`: the shipped layout templates (`default`, `tracker-issues`,
  `repo`) — a `layout.yaml` plus any sibling path-compiler helpers and a README. `init`
  copies the whole chosen folder into `<wiki>/.layout/`.
- `bootstrap.sh`: installer (npm install, render config, merge hooks and mcp, render rules
  to `.agents/rules`/`.claude/skills`/`.cursor/rules`, materialise the wiki, gitignore,
  optional `--schedule`). `scripts/mcp-config.sh` prints per-client MCP config.

## Tests

`npm test` (unit: wiki-store, recall, slug, discipline, MCP boot and round-trip) and
`npm run test:e2e` (full lifecycle against the real skill CLI; LLM stubbed via
`MEMORY_LLM_PROVIDER=mock`, embeddings via `embed.backend: lexical` in the test workspace's `settings.yaml` — see `test/harness.mjs`).

## Conventions

- No em dashes or en dashes in authored text (use commas, colons, parentheses, line breaks).
- Runtime data lives outside the repo, under `<workspace>/.llm-wiki-memory/`.

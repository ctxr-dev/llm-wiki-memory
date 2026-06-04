# AGENTS.md

`llm-wiki-memory`: local LLM-wiki-backed memory for AI coding agents. Capture, compile,
recall, stored as leaves in a git-versioned local wiki (via `@ctxr/skill-llm-wiki`), with
local-embedding recall. No RAG, no Docker.

## Development discipline (`.agents/`)

Rules for working ON this repo are canonical in `.agents/rules/`:
`dev-principles.md` (durability / parsing / injection / config invariants, cross-client
portability, wiki placement, LLM-pipeline contracts, hook design),
`testing.md` (harness + mocking conventions, the `/tmp/lwm-*` leak trap),
`releases-docs-authoring.md` (when and how to write a
`docs/releases/yyyy/mm/dd[/vN]/update-prompt.md` runbook + the paired-repo release order),
and `docs-style.md` (README/docs conventions). Step-by-step procedures live in
`.agents/skills/` (`write-release-runbook.md`, `run-tests-safely.md`,
`debug-capture-pipeline.md`). Per-client shadows
reference the canonical files via `@`-imports — `.claude/rules/` + `.claude/skills/`
(Claude Code), `.cursor/rules/` (Cursor); always edit the `.agents/` file, never a shadow.
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
  `state/.issues-index.json`).
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
- `scripts/lib/embed.mjs`: MiniLM embeddings (`@xenova/transformers`), cosine, content-hash
  cache, lexical fallback. The only retrieval engine (the skill has no query command).
- `scripts/lib/recall.mjs`: `recallLessons` (fall-back ladder), `searchMemory`, `saveLesson`.
- `scripts/lib/discipline.mjs`: single source of the memory discipline (MCP `instructions`
  and the SessionStart context).
- `scripts/lib/wiki-cli.mjs`: wrapper around the `skill-llm-wiki` bin; resolves it from
  `node_modules` (or `LLM_WIKI_SKILL_CLI`), runs `index-rebuild-one` for every touched
  ancestor dir, bottom-up.
- `mcp-server/index.mjs`: local stdio MCP server exposing `save_lesson`, `recall_lessons`,
  `save_to_dataset`, `search_memory`, and the document/audit tools.
- `templates/`: `.claude/settings.json` hooks, `.mcp.json`, the `.llmwiki.layout.yaml`
  contract, `env.example`, vendor-neutral `agents/`, and discipline `skills/`.
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

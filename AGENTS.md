# AGENTS.md

`llm-wiki-memory`: local LLM-wiki-backed memory for AI coding agents. Capture, compile,
recall, stored as leaves in a git-versioned local wiki (via `@ctxr/skill-llm-wiki`), with
local-embedding recall. No RAG, no Docker.

## Layout

- `scripts/hooks/`: Claude Code lifecycle hooks (bash wrappers calling `.mjs`).
  `session-start` (triggers daily compile, prints routing context),
  `pre-compact`/`post-compact`/`session-end` (call `flush.mjs`, extract atoms to
  `daily/`), `exit-plan-mode` (capture approved plans to `plans/`).
- `scripts/compile.mjs`: once-per-day promotion of daily atoms into `knowledge/` and
  `self_improvement/`, with embedding plus metadata dedup; archives promoted dailies.
- `scripts/lib/wiki-store.mjs`: the storage seam, a drop-in for a RAG bridge whose every
  document is a wiki leaf. Drives `skill-llm-wiki` for index-rebuild, validate, heal,
  rebuild (it owns tree-building; we own category routing). Hardens arbitrary names via
  `normalizeLeafName` and rejects unknown categories.
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
`MEMORY_LLM_PROVIDER=mock`, embeddings via `MEMORY_EMBED_BACKEND=lexical`).

## Conventions

- No em dashes or en dashes in authored text (use commas, colons, parentheses, line breaks).
- Runtime data lives outside the repo, under `<workspace>/.llm-wiki-memory/`.

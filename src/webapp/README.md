# llm-wiki-memory web app

A local, single-user web GUI for browsing, searching, and editing your
llm-wiki-memory wikis. It is a **client of the engine** (imported in-process), so
every read and write goes through the same placement, re-embedding, index, git,
and write-gate rules the CLI and MCP use — nothing is reimplemented.

## Run

```
llm-wiki-webapp start      # detached daemon; opens http://localhost:4319
llm-wiki-webapp status
llm-wiki-webapp stop
llm-wiki-webapp restart
```

`start` is non-blocking; the PID and logs live under `<MEMORY_DATA_DIR>/webapp/`.
`LWM_WEBAPP_OPEN=0` skips opening the browser, `--port <n>` changes the port, and
`--foreground` runs it attached for debugging.

## What it does

- **Wikis** — your home brain plus any wiki-mount folders you add.
- **Navigate** — layout-driven facet drill-down with document counts.
- **Read** — rendered markdown (tables, syntax highlighting via shiki, mermaid
  diagrams), a hover table-of-contents, a collapsible frontmatter card, and
  embedding-based related documents.
- **Search / Ask** — semantic search (current wiki or federated across all
  installed wikis), a retrieval "ask your memory" panel, and a ⌘K command palette.
- **Edit** — a Lexical WYSIWYG editor with a lossless guard that falls back to a
  CodeMirror source editor when a document can't round-trip; a typed frontmatter
  form; diff-on-save; the `self_improvement` consent gate; the shared-repo
  "commit & push" banner; archive/restore; and create. All writes go through the
  engine's own writers.
- **Boards** — read-only Plans (grouped by status) and Issues (decoded from the
  tracker topology and grouped by lifecycle).

## Develop

```
npm run dev        # Vite dev server (proxies /api to the daemon)
npm run gates      # typecheck + lint + no-comments + build + vitest
npm run test:e2e   # Playwright in a real browser (npx playwright install chromium)
```

## Layout

```
server/   Fastify + the in-process engine bridge (per-request withWikiRoot)
client/   React + Tailwind + Tanstack Query
shared/   zod API contract shared by client + server
e2e/      Playwright specs + a seeded fixture-wiki generator
```

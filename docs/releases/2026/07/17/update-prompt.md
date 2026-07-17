# llm-wiki-memory: length-aware chunked embeddings for long leaves (2026-07-17)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past the
**2026-07-17** release. Apply the earlier 2026-07-13/14/15 releases first if you have
not.

**WHO IS AFFECTED — everyone, but this is additive and needs no manual data step.**
Recall/search over LONG notes (plans, investigations, tracker issues, daily capture)
gets much better; nothing else changes.

## WHAT'S NEW

- **(recall) Long leaves are now chunked for search.** The embedding model only reads
  the first ~512 tokens of a note, so a long note's later sections were invisible to
  semantic search (measured: ~4% recall of tail content). On `search_memory`,
  `recall_lessons`, and CLI `search`/`recall`, a note whose embed text exceeds the
  window is now split into up to 6 window-sized pieces; the note is scored by its
  best-matching piece minus a small per-extra-chunk penalty. Short notes (the large
  majority) are unchanged.
- **(unchanged, by design) consolidate + compile de-duplication still score on the
  whole-note vector** — their calibrated thresholds are byte-identical to before, so
  the destructive archive/merge paths do not shift.
- **(on-disk, additive) the per-category cache entry gains an optional `chunks`
  field** for long notes. The existing `vector` (whole-note) is still present on every
  entry, so an **older engine reads the file unchanged** (it uses `vector`, ignores
  `chunks`). Not a breaking artifact change.
- **(config) new `embed.chunk` block** in `settings.yaml`: `enabled` (default true),
  `maxChunks` (6), `penalty` (0.015). Omit it to accept the defaults.

## PROCEDURE

1. Standard update against the runtime clone:
   ```
   cd ~/.llm-wiki-memory/src
   git fetch origin && git merge --ff-only origin/main && npm install
   ```
2. **RESTART your MCP client** (Claude Code / Cursor / Codex / Claude Desktop) so the
   server reloads with the new scorer.
3. **No data migration.** Long notes re-embed their chunks **lazily** the first time a
   chunk-aware recall touches their category (or run a warm — a `git pull`/merge into a
   shared repo fires the sync-embeddings hook, or just search). The whole-note vectors
   are reused unchanged (same content hash), so only the extra chunk vectors are
   computed, once.

## DECISIONS

- **Keep chunking on?** Yes (default). To disable: `embed.chunk.enabled: false` in
  `settings.yaml`. To trade recall vs precision: raise `penalty` (fewer long-note hits,
  stronger atomic precision) or lower it (more long-note recall).
- **Custom embed model?** Chunking triggers at the bge-large 512-token window
  regardless of model; if you run a longer-context model the trigger still fires at 512
  (conservative — never worse than today).
- **Lexical backend?** No chunking (lexical has no fixed window); behavior unchanged.

## VERIFICATION

- After a recall over a category with a long note, its cache entry
  (`<wiki>/<category>/.embeddings/embeddings.json`) has a `chunks` array AND still a
  `vector`:
  ```
  node -e 'const c=require("os").homedir()+"/.llm-wiki-memory/wiki/plans/.embeddings/embeddings.json";const e=Object.values(JSON.parse(require("fs").readFileSync(c,"utf8")).entries)[0];console.log("has vector:",Array.isArray(e.vector),"has chunks:",Array.isArray(e.chunks))'
  ```
- A query for a detail buried deep in a long note now surfaces that note (it did not
  before).
- Short-note searches return the same top hits as before; consolidate output is
  unchanged.
- `node scripts/cli.mjs doctor` is clean; `npm run gates` (in the src clone) is green.

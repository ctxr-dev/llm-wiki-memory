# Topology categories require an explicit, layout-matched `path`

Some wiki categories nest by a **topology path-compiler**, not by facet
placement. The shipped baseline (knowledge / self_improvement / plans /
investigations / daily) is facet-placed — you do **not** pass `path` for those.
But a category that declares a `topology:` block in
`<wiki>/.layout/layout.yaml` (the canonical example is a tracker **`issues`**
tree: `issues/<tracker>/<prefix>/<buckets>/<lifecycle>/…`) is different:

> For a topology category you MUST supply `path=` on `save_to_dataset` /
> `write_memory`, and that path MUST match the layout's topology for the leaf's
> file_kind. A missing path, or a path that does not round-trip through the
> topology, is **refused deterministically** by the MCP server. (A no-path
> write used to land flat at the category root — unsearchable, and frozen out
> of lifecycle moves. That hole is now closed.)

## How to compute the path (consult layout.yaml first)

1. **Read `<wiki>/.layout/layout.yaml`.** Find the category entry and its
   `topology.file_kinds`. A tracker `issues` topology declares two:
   - `knowledge` — facts about an issue (link, decision, gotcha). Required
     facets: `tracker, prefix, number`. Path has **no** lifecycle segment, e.g.
     `issues/JIRA/DEV/129/95/7/DEV-129957.md`.
   - `plan` — a plan/investigation scoped to the issue, lifecycled. Required
     facets: `tracker, prefix, number, lifecycle, slug`. Leaf name ends
     `.plan.md`, path includes `<lifecycle>`, e.g.
     `issues/JIRA/DEV/129/95/7/in-progress/DEV-129957-fix-timeout.plan.md`.
2. **Pick the file_kind that matches your intent** — a plan (`.plan.md`) vs a
   knowledge leaf. The leaf-name suffix decides it: `.plan.md` → `plan`,
   anything else → `knowledge`.
3. **Derive the facets** from the tracker key and your intent: `tracker` (e.g.
   `JIRA`), `prefix`+`number` from the issue key (`DEV-129957` →
   `DEV`/`129957`), `lifecycle` (`pending|in-progress|done|archived`) for a
   plan, and a kebab `slug`. The number buckets the way the layout's `to_path`
   does (`129957 → 129/95/7`: thousands / (mod 1000)/10 / mod 10).
4. **Pass the full directory as `path`** (the leaf filename is appended from
   `name`). Example:

   ```
   save_to_dataset({
     scopes,
     target,
     write: {
       dataset: "issues",
       name: "DEV-129957-fix-timeout.plan.md",
       path: "issues/JIRA/DEV/129/95/7/in-progress",
       text, metadata,
     },
   })
   ```

If you are unsure of the exact shape, run
`node .llm-wiki-memory/src/scripts/cli.mjs test-path-compiler plan --category issues tracker=JIRA prefix=DEV number=129957 lifecycle=in-progress slug=fix-timeout`
to get the resolved path, then save with that directory as `path`.

## Re-nesting stranded leaves

If flat tracker leaves already sit at the category root (a pre-fix install),
`node .llm-wiki-memory/src/scripts/cli.mjs nest` relocates them deterministically
into the topology tree (it derives facets from the filename + plan body and
fails loud per file on anything it cannot resolve). `nest --check` is a CI
guard that reports any remaining flat leaves.

## Why this is a hard rule

Placement is the difference between a leaf that the tracker-scoped recall
(`current-work-context`, issue-key search) can find and lifecycle automation
can move, versus an orphan at the category root that silently double-counts and
never updates. The server enforces it; this rule tells you how to satisfy it.

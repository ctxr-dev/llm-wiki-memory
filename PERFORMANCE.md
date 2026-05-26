# Performance characteristics

Empirical measurements of write, search, and lookup latency for
`llm-wiki-memory` (Xenova `bge-large-en-v1.5` embedder + `@ctxr/skill-llm-wiki`
index-rebuild pipeline). All numbers from a single-process Node 25.9 run on
macOS (Apple Silicon) against a small wiki (≤30 leaves). Re-measure on
your own hardware if you care about absolute numbers; relative shape and
asymptotic behaviour will match.

## TL;DR

- **Adding a leaf**: ~300 ms for a shallow path, ~500 ms for a 7-deep
  tracker-issues path. Dominated by `skill-llm-wiki index-rebuild-one`
  subprocess spawns (one per ancestor directory; ~50 ms each).
- **Searching**: ~40 ms once the embedder is warm. First search in a
  process pays ~8.5 s to load the 340 MB Xenova model.
- **Looking up by key** (issue tree): **0 ms** — the topology helper
  computes the path with pure arithmetic. No I/O.
- **Browsing the tree**: ≤ 7 `index.md` reads worst-case for the
  `tracker-issues` layout, even at 100 k+ issues per tracker (digit
  bucketing caps fan-out at ~100 per folder).
- **No LLM is involved** in writes. Xenova handles embeddings locally;
  the caller supplies the leaf body.

## Adding a leaf

Each leaf write does:

1. `fs.writeFileSync` of the leaf with normalised frontmatter — sub-ms
2. `ensureIndexes(root, [leaf])` — one `skill-llm-wiki index-rebuild-one`
   subprocess per ancestor directory, **deepest first**
3. `upsertEmbedding(rel, text)` — Xenova embed + write to
   `<data>/index/embeddings.json`

Step (2) dominates. Each subprocess pays Node startup (~50 ms).

| Scenario | Ancestor dirs | Wall clock (avg, N=3 warm) |
|---|---|---|
| `knowledge/<area>/<atom_type>/leaf.md` | 3 | **~280 ms** |
| `issues/JIRA/DEV/<k>/<h>/<u>/<issue>.md` | 6 | **~470 ms** |
| `issues/JIRA/DEV/<k>/<h>/<u>/<lifecycle>/<plan>.plan.md` | 7 | **~520 ms** |

Leaf body size (1 KB vs 10 KB) had no measurable effect: the embedding
model amortises away inside the warm Node process, and the file write +
markdown render are dwarfed by the index-rebuild spawn cost.

### Bulk-write hazard

For N leaves at depth K the cost is **N × K subprocess spawns**. A 1 000-issue
bulk migration in the `tracker-issues` layout would do ~7 000 spawns,
~6 minutes of wall clock on a single thread. If you need this, batch the
writes and call `ensureIndexes(root, allLeaves)` **once** at the end
instead of per-leaf — the helper dedupes ancestor dirs automatically.

## Searching

Two distinct search modes:

### Semantic search (Xenova)

`node scripts/cli.mjs search "<query>"` (or `searchMemory` via the lib /
MCP). Walks every leaf under the queried categories, embeds the query
once, ranks by cosine similarity.

| Query against the seeded 5-leaf wiki | Top score | Latency (warm) |
|---|---|---|
| `"APISIX gateway migration ArgoCD"` | 0.699 | 38 ms |
| `"ResourceIO cats-effect memory leak Kamon"` | 0.839 | 38 ms |
| `"GaugeMaxSampler sampler endpoint"` | 0.711 | 38 ms |
| `"tracker-agnostic GitHub demo topology"` | 0.846 | 39 ms |
| `"lorem ipsum dolor sit amet consectetur"` | 0.744 | 45 ms |

First query in a fresh process is **+8.5 s** for the one-time Xenova
model download / decode. Subsequent queries reuse the in-process model.

The MCP server stays alive across calls, so production latency is the
warm number (≤ 50 ms) once the server has answered its first query.

### Direct lookup by Jira key

For any tracker-issue with a known `{tracker, prefix, number}`, the
topology helper computes the path with pure arithmetic:

```js
pathFor(topo, "knowledge", { tracker: "JIRA", prefix: "DEV", number: 129957 })
// -> "issues/JIRA/DEV/129/95/7/DEV-129957.md"   (~0 ms)

pathFor(topo, "plan", {
  tracker: "JIRA", prefix: "DEV", number: 129957,
  lifecycle: "in-progress", slug: "investigate-timeout",
})
// -> "issues/JIRA/DEV/129/95/7/in-progress/DEV-129957-investigate-timeout.plan.md"
//    (~0 ms)
```

Zero I/O, zero embedding, no cache lookup. Constant time regardless of
how big the wiki is.

## Browsing the tree

Auto-generated `index.md` files at every directory level give Markdown-
clickable navigation. For the `tracker-issues` layout with 100 k+
issues per tracker:

| Layer | Depth | Max children |
|---|---|---|
| `wiki/` | 0 | ≤ 5 categories + `issues/` |
| `wiki/issues/` | 1 | ≤ N trackers (JIRA, GITHUB, …) |
| `wiki/issues/JIRA/` | 2 | ≤ N project prefixes (DEV, OPS, …) |
| `wiki/issues/JIRA/DEV/` | 3 | ≤ 1 000 buckets (thousands digit, capped at floor(maxN/1000)) |
| `wiki/issues/JIRA/DEV/<k>/` | 4 | ≤ 100 buckets (hundreds-tens) |
| `wiki/issues/JIRA/DEV/<k>/<h>/` | 5 | ≤ 10 buckets (units digit) |
| `wiki/issues/JIRA/DEV/<k>/<h>/<u>/` | 6 | 1 knowledge file + N plan-lifecycle dirs |
| `wiki/issues/JIRA/DEV/<k>/<h>/<u>/<lifecycle>/` | 7 | N plan files |

Worst-case browsing path for our deepest layout: **7 `index.md` reads**.
The digit-bucket scheme means adding 100 000 more issues *widens* the
middle level (more entries under the thousands digit) rather than
*deepening* the tree.

## Writing a leaf without an LLM

Adding a leaf is a deterministic write through `wiki-store.mjs`:

```js
import { saveDocument } from "llm-wiki-memory";

saveDocument({
  name: "DEV-129957.md",
  text: "<your body — supplied by you, not by an LLM>",
  datasetId: "issues",
  metadata: { atom_type: "jira_issue", area: "hermes-service" },
  placementOverride: "issues/JIRA/DEV/129/95/7",
});
```

The pipeline is:

1. Caller supplies content
2. `renderLeaf` composes the frontmatter (id, type, parents, covers,
   tags, sha256 of body, updated, memory block) — no LLM
3. `fs.writeFileSync`
4. `skill-llm-wiki index-rebuild-one` for each ancestor — no LLM
5. Xenova embeds the body locally and writes to the embedding cache —
   no LLM

Claude is only needed for *generating* content (drafting an investigation
note from a transcript, deciding tags, deduping atoms). Once the content
exists, absorbing it into the wiki is pure code.

## Open performance follow-ups

These are real issues we know about but haven't fixed:

1. **No batch write API.** Bulk imports of N leaves spawn ~N×K
   `index-rebuild-one` subprocesses. A `saveDocuments({leaves})` that
   amortises `ensureIndexes` over the whole batch would cut 1 k-leaf
   imports from minutes to seconds.
2. **Topology cache is process-lifetime.** `loadTopology` caches the
   compiled topology object indefinitely. Long-running processes (the
   MCP server) won't see edits to `layout/layout.yaml` or its sibling
   `.mjs` helpers until restart. A file-mtime check or a manual reset
   API would close this.
3. **Cold-start embedding model.** ~8.5 s on first search. The
   `SessionStart` warm-up hook addresses this for Claude Code sessions;
   bare CLI invocations still pay it.

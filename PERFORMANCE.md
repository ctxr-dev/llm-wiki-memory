# Performance characteristics

Empirical latency for `llm-wiki-memory` — the Xenova `bge-large-en-v1.5`
embedder + the `@ctxr/skill-llm-wiki` index pipeline.

> **Measured:** Apple **M4 Pro** (14 cores) · **Node 25.9** · macOS · production
> backend (real `bge-large`, model already cached on disk) · an **isolated**
> throwaway wiki grown to **~280 leaves** (the live install is never touched).
> Numbers are medians of repeated runs. Re-measure on your own hardware for
> absolute values — the *shape* (what dominates what) is what transfers.

---

## TL;DR

| Operation | Latency | Notes |
|---|---|---|
| **Add a leaf** (shallow → deep) | **~350 ms → ~590 ms** | Dominated by `index-rebuild-one` subprocess spawns (~67 ms each, one per ancestor dir). Writes do **not** embed. |
| **Search, warm** | **~30–80 ms** | Query embed + cosine over the corpus. Scales gently with leaf count. |
| **Search, cold cache** | **~24 ms × (uncached leaves)** | First search after a bulk import / model change lazily embeds candidates once. ~9 s over 280 cold leaves; warm forever after. |
| **Lookup by key** (topology) | **< 1 µs** | Pure arithmetic. O(1) regardless of wiki size. No I/O. |
| **recall_lessons** | **~65 ms** | Drop-rung ladder over `self_improvement`. |
| **validate** (full wiki, 280 leaves) | **~210 ms** | One `skill-llm-wiki validate` subprocess. |
| **gc-embeddings** (sweep 280 entries) | **~15 ms** | Pure in-memory set diff + cache rewrite. |
| **Cold model load** | **~500 ms** | One-time per process; decode of the locally-cached 340 MB model. |

**No LLM is involved in writes, search, or lookup.** Claude only *generates*
content; absorbing it is pure local code + on-device embeddings.

---

## Embedding (Xenova `bge-large-en-v1.5`)

| Measurement | Latency |
|---|---|
| Cold model load (first `embed()` in a process — local-cache decode) | **~500 ms** |
| Warm query embed (short query, model loaded) | **~12 ms** |
| Warm leaf embed (leaf-sized body, ~150 chars) | **~24 ms** |

The model loads **once per process**. The MCP server stays alive, so it pays the
~500 ms exactly once and every later call is warm. (Historically this was ~8.5 s
because the model was downloaded on first use; once cached on disk it's ~500 ms.)

---

## Adding a leaf

A write (`saveDocument` / `save_to_dataset`) does, synchronously:

1. `renderLeaf` + `fs.writeFileSync` — frontmatter (id, covers, sha256, memory block) + body. **Sub-millisecond.**
2. `ensureIndexes(root, [leaf])` — one `skill-llm-wiki index-rebuild-one` **subprocess per ancestor directory**, deepest-first. **This dominates.**
3. `upsertEmbedding(rel, text)` — **lazy**: only *invalidates* a stale cache entry. The vector is **not** computed here — it's deferred to the next search that needs it (see below).

| Scenario | Ancestor dirs | Wall clock (median) |
|---|:---:|:---:|
| `knowledge/<area>/<atom_type>/` | 3 | **~347 ms** |
| `knowledge/<area>/<atom_type>/<subject…>/` (subject axis) | 5 | **~413 ms** |
| 7-deep path (e.g. `issues/JIRA/DEV/<k>/<h>/<u>/<lifecycle>/`) | 7 | **~586 ms** |

Per-`index-rebuild-one` subprocess: **~67 ms** (Node startup + the skill's
single-dir index regen). Total write ≈ a fixed render/cache overhead + `K × 67 ms`
for `K` ancestors. **Leaf body size is irrelevant** to write cost — nothing is
embedded at write time.

> ⚠️ **Bulk-write hazard.** N leaves at depth K = **N × K subprocess spawns**.
> A 1 000-leaf import at depth 7 ≈ 7 000 spawns ≈ **8 min** single-threaded.
> Mitigation: write the leaves, then call `ensureIndexes(root, allLeaves)` **once**
> at the end (it dedupes ancestor dirs) instead of per-leaf. (No batch save API
> yet — see follow-ups.)

---

## Searching

`searchMemoryFiltered` (lib / MCP `search_memory`): frontmatter-prefilter the
candidate leaves, embed the query once, rank by cosine.

### Warm (vectors cached — the normal case)

| Corpus size | Warm search latency |
|---:|:---:|
| 25 leaves | **~29 ms** |
| 100 leaves | **~40 ms** |
| 250 leaves | **~61 ms** |
| 280 leaves | **~81 ms** |

Roughly **~25 ms base + ~0.2 ms/leaf** — the walk + cosine grow linearly, the
single query-embed is fixed. Comfortable into the low thousands of leaves.

### Cold cache (first search after a bulk import, or after a model change)

Because embedding is **lazy**, the first search that sees an uncached leaf embeds
it then (~24 ms each), once. A search over **280 fully-cold leaves ≈ 9.0 s**;
every subsequent search is warm (~80 ms). A model change wipes the cache and
re-pays this once. The `SessionStart` warm-up + the persistent MCP server keep
this off the interactive path in normal use.

### Direct lookup by key (topology) — **O(1), < 1 µs**

For any tracker issue with a known `{tracker, prefix, number}`, the topology
helper computes the path with pure arithmetic — **sub-microsecond**, no I/O, no
embedding, constant regardless of wiki size:

```js
pathFor(topo, "knowledge", { tracker: "JIRA", prefix: "DEV", number: 129957 })
// → "issues/JIRA/DEV/129/95/7/DEV-129957.md"
parsePath(topo, "issues/JIRA/DEV/129/95/7/DEV-129957.md")
// → { tracker:"JIRA", prefix:"DEV", number:129957 }
```

100 000 iterations of each measured below the timer's resolution (≈ 0 µs/call).

---

## Maintenance & lifecycle ops

| Operation | Latency | What it is |
|---|:---:|---|
| `recall_lessons` | **~65 ms** | Drop-rung ladder (error_pattern → language → task_type → area) over `self_improvement`, warm. |
| `validate` (full wiki, 280 leaves) | **~210 ms** | One `skill-llm-wiki validate` subprocess (invariants + git fsck). |
| `gc-embeddings` sweep (280 entries) | **~15 ms** | Walk live leaves, drop orphan cache entries, rewrite JSON. |

---

## Browsing the tree

Auto-generated `index.md` at every level gives markdown-clickable navigation.
The `tracker-issues` digit-bucket scheme caps fan-out so the tree **widens**, not
**deepens**, as issue counts grow:

| Layer | Depth | Max children |
|---|:---:|---|
| `wiki/` | 0 | categories + `issues/` |
| `issues/JIRA/DEV/` | 3 | ≤ 1 000 thousands-buckets |
| `issues/JIRA/DEV/<k>/` | 4 | ≤ 100 hundreds-tens |
| `issues/JIRA/DEV/<k>/<h>/` | 5 | ≤ 10 units |
| `issues/JIRA/DEV/<k>/<h>/<u>/` | 6 | 1 knowledge file + lifecycle dirs |
| `issues/JIRA/DEV/<k>/<h>/<u>/<lifecycle>/` | 7 | plan files |

Worst-case browse for the deepest layout: **7 `index.md` reads**, even at
100 k+ issues per tracker.

---

## Open performance follow-ups

Known, unfixed:

1. **No batch write API.** Bulk imports spawn ~N×K `index-rebuild-one`
   subprocesses (~67 ms each). A `saveDocuments({ leaves })` that amortises
   `ensureIndexes` over the batch would cut a 1 000-leaf import from minutes to
   seconds.
2. **Per-write subprocess fan-out.** Even a single deep write spawns one Node
   process per ancestor dir. An in-process index regen (importing the skill lib
   instead of shelling out) would remove the ~67 ms × K tax — at the cost of the
   clean CLI boundary (see [ARCHITECTURE.md](ARCHITECTURE.md)).
3. **Cold-cache first search.** Lazy embedding means the first search after a
   bulk import pays ~24 ms × (uncached leaves). A background "warm the cache"
   pass after bulk writes would hide it.

*Resolved:* the layout (placement) and topology caches used to be
process-lifetime — a long-running MCP server wouldn't see `.layout/layout.yaml`
or sibling `.mjs` edits until restart. They now **revalidate by file mtime** on
each read (sibling `.mjs` re-imported with an mtime cache-bust), and the
`reload_layout` MCP tool force-clears them as an explicit escape hatch.

---

*Methodology: `bench.mjs` built an isolated temp wiki (own `MEMORY_DATA_DIR`),
ran each scenario with the real `bge-large` backend, and was deleted afterward —
the live wiki and its embedding cache were never written to. Reproduce by
benchmarking against a throwaway `MEMORY_DATA_DIR` so your install stays clean.*

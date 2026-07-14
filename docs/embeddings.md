# Embeddings

How llm-wiki-memory turns text into vectors, ranks a query against stored
leaves, caches the vectors, and how fast that is on real hardware.

Everything here runs **on-device** — no embedding text ever leaves the machine.

---

## What we embed, and how

The skill-llm-wiki package has no query/search command (retrieval is "walk the
index tree" by design), so ranking a free-text query against existing leaves is
this engine's job. Two things get embedded:

- **Every active leaf's body** — lazily, the first time a search touches its
  category, and again only when its content hash changes.
- **The search query** — once per search.

Ranking is cosine similarity between the query vector and each candidate leaf
vector, after a frontmatter-metadata filter narrows the candidate set.

### Backends

| Backend | What it is | When |
|---|---|---|
| `transformers` (default) | `Xenova/bge-large-en-v1.5`, mean-pooled, L2-normalized, quantized ONNX via `@xenova/transformers` (onnxruntime-node). ~340 MB, downloaded once, then offline. | Default. |
| `lexical` (fallback) | Deterministic hashed bag-of-tokens into a fixed 256-dim vector. Not semantic, but stable and dependency-free. | When the model can't load (offline first run, download failure), or forced via `embed.backend: lexical`. |

The backend is resolved once per process and latched: a mid-run
transformer→lexical fallback sticks for the rest of the process, and the cache
records which backend produced its vectors (see caching).

Change the model with `MEMORY_EMBED_MODEL` (e.g. a lighter
`Xenova/bge-small-en-v1.5`). A model change invalidates the vector cache (it is
stamped with the model), so vectors recompute on the next search.

---

## Caching

Vectors are cached per category at
`<wikiRoot>/<category>/.embeddings/embeddings.json` (gitignored). Each entry is
keyed by the leaf's relative id and carries the **content hash** of the body it
was computed from, so an unchanged leaf is never re-embedded.

The cache file is **stamped** with `{ model, backend, dim }`. On load, a stamp
mismatch (different model, different backend, or a different vector dimension)
drops the whole cache and forces a cold re-embed — this is safe because
lazy-embed rebuilds it on first use. Writes are atomic (unique temp + fsync +
rename) so the long-running MCP server and the hourly cron can never tear each
other's write into invalid JSON.

A read against a **read-only** shared tree (a teammate consuming another owner's
curated memory) can't create `.embeddings/`; that persist failure is swallowed
best-effort — the vectors are already scored in memory, and lazy re-embed at the
next writable search is the correctness net.

---

## One model in memory — fan-out does NOT multiply it

This is the load-bearing guarantee, verified in code and empirically.

- **The pipeline is a per-process singleton.** `embed.mjs` holds one memoized
  `_extractorPromise`; every `embed()` / `embedMany()` call reuses it. ES modules
  are per-process singletons, so there is exactly **one** model instance per
  Node process.
- **Federated fan-out reuses that one model.** A multi-level search
  (`searchMemoryFiltered` → per-level `searchOneTree`) runs each level inside a
  `withWikiRoot` frame that swaps only the wiki *path* (an AsyncLocalStorage
  value) — it never re-imports or re-instantiates the pipeline. N levels = N
  searches, **1 model**. Measured: RSS stays flat across a full multi-level run.

### Why not a worker-thread pool

Each Node `worker_thread` is a separate V8 isolate with its own module
registry, so importing the model inside each worker loads its **own** ~340 MB
copy — RAM ≈ pool size × model. A live onnxruntime session cannot be shared
across workers (it's a native handle bound to one isolate). A worker pool would
therefore multiply the model, and it would not even be faster (see the
thread-scaling result below — a single inference does not speed up with more
threads on this stack). **Rejected by design.**

### Batching (the safe parallelism)

The transformer pipeline accepts an **array** of strings and runs it as a single
padded forward pass — one model, one batch. The mass-embed paths use this:

- `embedMany(texts)` — chunks the inputs and returns vectors aligned to input
  order (lexical fallback maps element-wise). Chunk size is bounded internally.
- `cachedEmbeddings(cache, items)` — reuses hash-matching entries and batches
  only the **misses** in one `embedMany` call.

Both mass-embed callers use it: the git-hook category warm
(`sync-embeddings.mjs`) and the cold-cache first search (`searchOneTree` batches
misses per category). This turns a cold N-leaf warm from N serial model calls
into `ceil(N / batch)` forward passes.

---

## Benchmarking

Measured on an **Apple M4 Pro (14 cores), Node v25, `@xenova/transformers`
2.17.2**, model `Xenova/bge-large-en-v1.5` already downloaded (warm), the
content-hash cache **bypassed** to measure raw embed cost.

### Embedding the same document 1000× (one model, no reload)

| Path | Throughput | Per-doc | 1000 docs |
|---|---|---|---|
| **Serial** (90-word doc, 1000×) | **11.4 docs/s** | ~87 ms (p50 87, p95 91) | **~88 s** |
| Serial (short 1-sentence doc) | 22 docs/s | ~45 ms | ~45 s |
| **Batched** B=8 | 12.0 docs/s | — | ~83 s (1.05×) |
| **Batched** B=16 / 32 / 64 | ~12.5 docs/s | — | ~80 s (**~1.10×**) |

Per-doc cost scales with token count (longer body → slower). Batching buys only
**~10%** here because one bge-large forward pass is ~45–87 ms of dense compute;
batching amortizes the small per-call overhead, not the model itself.

### Thread scaling — flat (not a lever on this stack)

Serial throughput at `intraOpNumThreads` ∈ {1, 2, 4, 8, 14}:

| threads | 1 | 2 | 4 | 8 | 14 |
|---|---|---|---|---|---|
| ms/doc | 45.4 | 44.5 | 44.6 | 44.5 | 44.6 |

Changing the ONNX intra-op thread count has **no measurable effect** here — CPU
thread parallelism is not the exploitable bottleneck.

### Memory — no multiplication

RSS after model load settled at ~1.1–1.4 GB and **stayed at that single-model
baseline across every batch size** (B=8 → 64). One model, regardless of batch.

### Takeaways

1. **Fan-out and batching keep exactly one model in memory** — confirmed by flat
   RSS. A worker pool is the only thing that would multiply it, and it's rejected.
2. **Batching is a ~10% win on bge-large** — real but modest; it's applied to the
   mass-embed paths (hook warm + cold first search).
3. **The content-hash cache is the real everyday saver** — a cold 1000-leaf
   embed only happens on first install, a model change, or a cache wipe. Routine
   operation re-embeds only the handful of leaves whose content changed.
4. **The biggest single speed lever is model size**, not parallelism. `bge-large`
   is the heavy end (~45–87 ms/doc); a quantized `bge-small`/MiniLM is ~3–5×
   faster per doc at a small quality cost — set `MEMORY_EMBED_MODEL` to switch.
   The default stays `bge-large` for retrieval quality.

### Reproducing

Load the pipeline once, warm it, then time N serial `extractor(doc, {pooling:
'mean', normalize: true})` calls and the same N split into batched array calls;
track `process.memoryUsage().rss` at each stage. Run from inside the engine's
`src/` (so `@xenova/transformers` resolves) against the already-downloaded model
cache under `node_modules/@xenova/transformers/.cache`.

---

## Not applicable: sqlite vector stores

`sqlite-vec` / `sqlite-vss` are vector **search/storage** extensions — they do
not generate embeddings (you still need a model). There is no sqlite-based
embedder. For this engine's corpus size (up to a few thousand vectors) the
existing in-memory cosine scan is already the right choice; an ANN index only
starts to matter at hundreds of thousands to millions of vectors.

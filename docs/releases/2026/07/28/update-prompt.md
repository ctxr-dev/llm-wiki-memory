# llm-wiki-memory: EmbeddingGemma default + Transformers.js v4 + worker-thread inference (2026-07-28)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past the
**2026-07-28** release. This is a **BREAKING** release for the embedding stack: the
inference library, the default model, and the model-coupled ranking thresholds all
changed. Recall keeps working out of the box either way — the vector caches
self-heal — but an operator should make one explicit choice (adopt the new default
model, or pin the old one) and update pinned thresholds to match.

**WHO IS AFFECTED — everyone.** Installs that never touched `embed.model` flip to
the new default model on upgrade (one-time ~197 MB download + a full re-embed of
every category, performed gradually). Installs that PIN `embed.model` or any
remapped threshold in `settings.yaml` keep their pinned values and MUST reconcile
them by hand (Decisions below).

## WHAT'S NEW

- **(library) `@xenova/transformers` 2.x → `@huggingface/transformers` v4.** New
  direct dependency; the old one is removed. The arm64/x64 onnxruntime binding
  ships inside the npm package (the blocked `onnxruntime-node` postinstall under
  `allow-scripts` policies is harmless). Tokenizer API changed
  (`encode(text, opts)`, no `text_pair` positional) — internal call sites updated.
- **(model) default `embed.model` is now `onnx-community/embeddinggemma-300m-ONNX`**
  (Google EmbeddingGemma-300m): 768-dim, **2048-token window** (4× less chunking),
  q4 QAT ONNX **~197 MB** (vs bge-large q8 ~340 MB), English retrieval at parity
  with the previous default, multilingual. Retrieval prompts
  (`task: search result | query: ` / `title: none | text: `) are applied
  automatically at inference time and never enter cache hashes. License: Gemma
  Terms of Use (the previous default was MIT). The previous default
  `Xenova/bge-large-en-v1.5` remains fully supported via `embed.model`.
- **(settings, NEW) `embed.dtype`** ("" = per-family default: EmbeddingGemma q4,
  BERT-family q8), **`embed.threads`** (onnxruntime intra-op threads per forward
  pass, default **2**, 0 = all cores — the cap was impossible on v2), and
  **`embed.maxColdPerRead`** (default **32** texts; see DECISIONS).
- **(settings, REMAPPED DEFAULTS — model-coupled)** measured on a real 537-leaf
  corpus embedded with both models (true near-duplicates scored ≥0.9925 in Gemma;
  the highest non-duplicate pair <0.956; unrelated-pair noise sits ~0.14 vs bge's
  ~0.05):
  - `consolidate.cosineThreshold` 0.97 → **0.975**
  - `consolidate.clusterScoreThreshold` 0.75 → **0.7**
  - `recall.scoreThreshold` 0.05 → **0.12**
  - `recall.priorityBand` / `recall.depthBoostBand` unchanged (score-gap geometry
    maps ~1:1, slope 1.107).
- **(runtime) transformer inference runs in a worker thread.** The onnxruntime
  forward pass is a synchronous native call; on v2 it froze the daemon's event loop
  for the duration of any cold re-embed. The worker keeps the loop free
  (`LWM_EMBED_NO_WORKER=1` forces the old in-process path).
- **(runtime) gradual cache warm.** The webapp daemon warms the home wiki's vector
  caches at boot inside its own process, in small duty-cycled slices (measured:
  ~127–200% avg CPU in 1–2 s bursts, ~1.4–2.1 GB peak RSS, vs ~580% sustained and
  3.5 GB unpaced). An already-warm brain is an all-hit no-op. Progress persists
  every few slices, so a restart resumes. Opt out: `LWM_WEBAPP_NO_WARM=1`.
- **(scope, BEHAVIOUR CHANGE) the warm now covers ARCHIVED leaves too.** Recall with
  `includeArchived` scores archived leaves, so leaving them out of the warm left them
  cold and let one "show archived" request embed hundreds of leaves inline — the
  request blocked for minutes while the worker saturated its thread cap. Expect the
  first warm after upgrading to cover your archived corpus as well (on a
  537-active-leaf brain that was ~240 extra leaves, one time, paced). Nothing prunes
  them afterwards: `pruneEmbeddingCache` keys orphans off file existence, not status.
- **(hardening) embed-cache backend downgrade guard + retryable model fallback +
  `doctor` backend-mismatch check** (shipped earlier the same window; see the
  `embed-cache-backend-downgrade-corruption-and-guard` knowledge leaf).

## PROCEDURE

1. In the runtime clone (`<workspace>/.llm-wiki-memory/src` or your install path):
   `git fetch && git merge --ff-only origin/main && npm install`.
   Under an `allow-scripts` policy, ignore the `onnxruntime-node` postinstall
   warning — the binding ships in-package.
2. Re-run `bootstrap.sh` (idempotent; no new pointers in this release, safe skip if
   unchanged).
3. **Decide your model** (Decisions below), then edit `settings/settings.yaml`:
   - Adopting the new default: remove (or update) any pinned `embed.model`, and
     update pinned thresholds: `consolidate.cosineThreshold: 0.975`,
     `consolidate.clusterScoreThreshold: 0.7`, `recall.scoreThreshold: 0.12`
     (skip any you deliberately customised).
   - Keeping bge: pin `embed.model: Xenova/bge-large-en-v1.5` and keep the old
     thresholds; nothing else changes for you.
4. Restart long-running processes: `npm run webapp -- restart` from the engine
   clone; the MCP server picks the change up on its next session. (There is a
   `llm-wiki-webapp` bin, but a clone install never puts it on `PATH` — run
   `npm link` once if you want the short command.) On a model change the gradual warm
   re-embeds every category in the background (a few hundred leaves ≈ 5–15 min at
   low CPU); recall self-heals lazily on other clients.
5. One-shot alternative to the gradual warm (full speed, ~2–6 min at high CPU):
   `node scripts/cli.mjs search "warmup"` from the runtime clone.

## DECISIONS

- **Adopt EmbeddingGemma (recommended) or keep bge-large?** Gemma: same English
  retrieval quality, multilingual, 4× window (less chunking), 40% smaller download,
  auto prompts; license is Gemma ToU, not MIT. bge: zero re-embed, MIT. The
  `embed.threads` cap applies to BOTH families (it is library-level), so neither
  choice affects it. If compliance forbids the Gemma ToU, keep bge.
- **q4 or q8?** Default (dtype "") resolves q4 for Gemma — Google QAT'd it
  (Mean(Task) 69.31 vs 69.49 for q8). Pin `embed.dtype: q8` only if you want zero
  quality risk over ~110 MB extra.
- **`embed.threads`**: default 2 caps a forward pass at ~2 cores (~200% CPU during
  a background warm). Set 0 to restore all-core inference (fastest cold warm,
  heaviest bursts).
- **`embed.maxColdPerRead`**: default 32 texts. ONE search/recall may cold-embed at
  most this many before leaving the rest to the background warm; skipped leaves are
  dropped from that one result set (never scored 0) and stay queued for the warm.
  Set 0 for the old unbounded behaviour. A maintenance pass (consolidate) is exempt
  automatically — it needs every vector or its dedup clustering under-merges.
- **Pinned `recall.scoreThreshold: 0`** (keep-every-hit) stays valid under Gemma —
  0 disables the floor entirely; no action needed.

## VERIFICATION

- `node scripts/cli.mjs doctor` → `ok: true`, `summary.cacheMismatches: 0`.
- Every `<wiki>/<category>/.embeddings/embeddings.json` stamps
  `model: onnx-community/embeddinggemma-300m-ONNX, dim: 768` (or your pinned
  model) after the warm completes.
- `npm test` in the runtime clone: full suite green.
- Webapp: doc tabs render instantly during any background warm; `/related`
  responds <1 s warm.
- `MEMORY_EMBED_CACHE_DIR` (if set) contains `onnx-community/embeddinggemma-300m-ONNX/onnx/model_q4.onnx*`
  after first use; no HF token is required (the mirror is ungated).

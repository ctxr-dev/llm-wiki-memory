# Configuration

Settings live in **two** files in `./.llm-wiki-memory/settings/`:

- **`.env`** — secrets, provider switches, deployment paths, workspace identity, test seams. Things that genuinely need shell precedence. See [`../templates/env.example`](../templates/env.example).
- **`settings.yaml`** — every other knob, nested by concern (`consolidate`, `flush`, `hook`, `embed`, `recall`, `compile`, `gc`, `gate`, `wiki`, `providers`) plus the top-level `crossCuttingAreas` list. See [`../templates/settings.yaml`](../templates/settings.yaml).

The `.env` file's strict subset overrides the YAML where it overlaps (e.g. `MEMORY_LLM_PROVIDER` collapses the YAML chain). Since the 2026-06-03 release, every `MEMORY_*` env var NOT on the strict allow-list is a silent no-op — application config moved into `settings.yaml`.

## Strict-subset `.env` keys

| Key | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | (unset) | Provider API keys (only for API providers). |
| `MEMORY_LLM_PROVIDER` | auto | `claude` / `codex` / `cursor` / `anthropic` / `openai` / `openai-compatible` / `mock`. When set, collapses the YAML chain to this one provider. |
| `MEMORY_LLM_MODEL` | (unset) | Provider-agnostic model override; prepends to the head provider's models list. |
| `ANTHROPIC_MODEL` / `OPENAI_MODEL` | (unset) | Provider-specific model override; prepends to that provider's models list. |
| `MEMORY_LLM_BASE_URL` | (unset) | OpenAI-compatible local endpoint (ollama, vLLM, lm-studio, llama.cpp, litellm). |
| `MEMORY_LLM_TIMEOUT_MS` | `120000` | Per-call CLI/API timeout. |
| `MEMORY_DATA_DIR` / `LLM_WIKI_MEMORY_ROOT` / `MEMORY_EMBED_CACHE` / `MEMORY_EMBED_CACHE_DIR` / `MEMORY_SETTINGS_PATH` | derived | Deployment + model-cache paths. |
| `MEMORY_DEFAULT_PROJECT_MODULE` / `LLM_WIKI_MEMORY_PROJECT` | deterministic identity | Workspace identity (scopes recall): the canonical git origin as `org/repo`, else `file://<workspaceDir>`, with `basename(workspace)` only as a last resort. |
| `MEMORY_MCP_SERVER_NAME` | `llm-wiki-memory` | MCP server name advertised at initialize. |
| `MEMORY_LLM_MOCK_*` | (unset) | Test seams for the mock provider. |

Recall scoping is deterministic: `project_module` is derived from a declared `project_id` > the canonical git origin `org/repo` > `file://mountDir` (nested repos chain as `org/repo//sub`); `cli.mjs migrate-identity` restamps legacy leaves. A recall `project_module` filter matches the INNERMOST chain segment (a leaf stamped `org/repo//sub` matches a filter for `sub` or the full chain, not the outer `org/repo`), so clones of a sub-package still gather regardless of parent.

## Highlights from `settings.yaml`

The knobs you're most likely to flip — the full annotated set is in [`../templates/settings.yaml`](../templates/settings.yaml):

| Section.key | Default | Meaning |
| --- | --- | --- |
| `consolidate.enabled` | `false` | Master switch for consolidation. Off by default (every path no-ops until you set `true`). |
| `consolidate.intervalDays` | `1` | Throttle for `consolidate --if-due`. |
| `consolidate.llmPassesEnabled` | `true` | Disable to run deterministic-only consolidation. |
| `embed.model` | `onnx-community/embeddinggemma-300m-ONNX` | Embedding model — see the model comparison below. |
| `embed.backend` | `transformers` | `transformers` (on-device model) or `lexical` (no model download). |
| `embed.dtype` | `""` | ONNX quantization. `""` resolves per model family: EmbeddingGemma → `q4`, BERT-family → `q8`. |
| `embed.threads` | `2` | ONNX intra-op threads per forward pass — a background warm then sits near 200% CPU rather than saturating the machine. `0` = all cores. |
| `embed.maxColdPerRead` | `32` | Most texts ONE search/recall may cold-embed before leaving the rest to the background warm. Skipped leaves are dropped from that result set (never scored 0) and stay queued. `0` = unlimited. Consolidate is exempt automatically. |
| `embed.warmIntervalMinutes` | `30` | How often a scheduler (hourly cron, webapp timer, `cli.mjs warm --if-due`) may re-run the gradual cache warm for a wiki. Throttled by a per-wiki-root stamp in `state/.embed-warm.json` and serialised by a lock. `0` = no scheduled warm (recall still self-heals lazily, at search latency). |
| `recall.recentActivityDays` | `3` | SessionStart "🧠 Recently" window (days of recent notes surfaced). `0` disables. |
| `recall.planContextMax` | `2` | Max plans surfaced at SessionStart. `0` hides plans. |
| `gate.selfImprovementEnabled` | `true` | Operator escape hatch for the server-side write-gate. |
| `gate.claudeHookEnabled` | `true` | Enable/disable the Claude Code PreToolUse write-gate hook. |
| `gate.perLessonConsent` | `true` | One save phrase auto-allows only the first gated write of a turn (Claude Code). |
| `gate.maxInlineBodyBytes` | `32768` | Byte cap on an inline `text` sent to `save_lesson` / `save_to_dataset` / `write_memory`; over it the write is refused with `inline-body-too-large` and a pointer to `cli.mjs save-leaf --file` / `update_document_metadata`. Independent of `gate.enabled` (that flag is consent; this is a token/latency bound). `absorb_document` is exempt. `0` = unlimited; a malformed value falls back to the default, never to unlimited. |
| `wiki.autoCommit` | `true` | Auto-commit every wiki change to the wiki's own git repo. |
| `flush.chunkTargetK` | `5` | Target chunk count for map-reduce distillation. |
| `flush.reduceModelPromote` | `true` | Use a one-tier-stronger model for the reduce step. |

The full annotated schema in [`../templates/settings.yaml`](../templates/settings.yaml) also covers the consolidate self-healing knobs (`attemptsKeep`, `fullLogRetentionDays`, `escalateAfterAttempts`, `cosineThreshold`), the audit knobs (`gate.auditTrailEnabled`, `gate.auditKeep`), `providers.chain` + per-provider `models`, and the top-level `crossCuttingAreas` list.

## Choosing an embedding model

Recall ranks queries with an on-device [transformers.js](https://github.com/huggingface/transformers.js) (`@huggingface/transformers` v4) model, set by `embed.model`. The default `onnx-community/embeddinggemma-300m-ONNX` — Google EmbeddingGemma-300m (308M params) — reads a 2048-token window (4× the BERT-family models) and is multilingual; English retrieval quality is on par with the previous default `Xenova/bge-large-en-v1.5`. Lighter models trade some accuracy for a smaller download. Sizes below are the **quantized** ONNX weights (full-precision is larger), lightest first:

| Model | Dim | Window | Download | Notes |
| --- | :---: | :---: | :---: | --- |
| `Xenova/all-MiniLM-L6-v2` | 384 | 512 | ~25 MB | Smallest and fastest. Modest retrieval quality. MIT. |
| `Xenova/bge-small-en-v1.5` | 384 | 512 | ~35 MB | Strong quality for a small download. MIT. |
| `Xenova/bge-base-en-v1.5` | 768 | 512 | ~110 MB | Noticeably better routing than `small`. MIT. |
| `onnx-community/embeddinggemma-300m-ONNX` | 768 | 2048 | ~197 MB (q4) | **Default.** Multilingual, longest window; English ≈ `bge-large`. [Gemma Terms of Use](https://ai.google.dev/gemma/terms) (permissive with use restrictions, not MIT). |
| `Xenova/bge-large-en-v1.5` | 1024 | 512 | ~340 MB (q8) | Previous default. Best BERT-family routing quality; English-only. MIT. |

```yaml
embed:
  model: Xenova/bge-small-en-v1.5
```

Changing the model invalidates the per-category vector caches automatically (they are stamped with model + backend + dim) and the leaves re-embed via the gradual warm or the next search. Stay with EmbeddingGemma or the MiniLM / BGE / GTE / mxbai families: EmbeddingGemma's retrieval prompts are applied automatically at inference time, and the BERT-family models are mean-pooled with no prefix — which is how this engine embeds them. Other prefix-based models (e5, nomic) underperform here because the engine doesn't add the `query:` / `search_document:` prefixes they expect.

For a **team sharing a wiki**, keep everyone on the same `embed.model` + `embed.backend`: the `transformers` and `lexical` backends rank the same query differently, so a machine on `lexical` and one on `transformers` get internally-consistent but mutually-different recall order. Results are never wrong (the cache is stamped with model + backend and rebuilds on mismatch) — just ranked differently.

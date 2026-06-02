<div align="center">

# LLM Wiki Memory

### Local, git-versioned memory for AI coding agents. Capture, compile, recall — now with offline consolidation.

The same capture / compile / recall loop and self-improvement behaviour you'd get from a RAG memory stack, stored as a local [LLM wiki](https://github.com/ctxr-dev/skill-llm-wiki) with local-embedding recall and a deterministic write-gate.

**No RAG. No Docker. No external service.**

<br/>

[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio_server-6E40C9?logo=anthropic&logoColor=white)](https://modelcontextprotocol.io)
[![recall](https://img.shields.io/badge/recall-bge_embeddings-FF6F00)](https://huggingface.co/Xenova/bge-large-en-v1.5)
[![infra](https://img.shields.io/badge/infra-no_Docker_·_no_RAG-success)](#)
[![built on](https://img.shields.io/badge/built_on-%40ctxr%2Fskill--llm--wiki-1f6feb)](https://github.com/ctxr-dev/skill-llm-wiki)
[![tests](https://img.shields.io/badge/tests-664_passing-brightgreen)](#testing)

</div>

---

## Highlights

- **Zero infrastructure.** Everything lives in a local `.llm-wiki-memory/` folder. No vector DB, no container, no API service to run.
- **Git-versioned memory.** Every memory is a markdown leaf in a hierarchical wiki with full history, maintained by [`@ctxr/skill-llm-wiki`](https://github.com/ctxr-dev/skill-llm-wiki).
- **Write-gated.** Self-improvement lessons can only be saved with explicit user consent (propose-then-confirm). Enforced server-side, cross-client, with a defence-in-depth `PreToolUse` hook on Claude Code. Other categories (knowledge, plans, investigations, daily) stay direct-write.
- **Offline consolidation.** A search-driven refinement orchestrator runs on the daily cron + at session end: deduplicates near-identical leaves, archives stale entries, optionally rewrites bodies via an LLM (same `JSON-output-with-retry` contract as compile). Never hard-deletes; always reversible.
- **Local semantic recall.** Transformer embeddings (default `Xenova/bge-large-en-v1.5`) rank queries on-device. One env var swaps in a lighter model (lexical fallback if no model is available).
- **Works with any MCP client.** Claude Code, Cursor, Codex, Claude Desktop, and generic clients get the same MCP tools and the same memory discipline. Hooks are bonus speed for Claude Code; the cross-client surface is the MCP server + the rule files.
- **Layout-declared eligibility.** Every category in `<wiki>/.layout/layout.yaml` declares `consolidate: refine | none` — author intent must be explicit; no defaults.
- **One-prompt install.** Paste a prompt into your agent, or run one script. Idempotent.

## Why a wiki instead of RAG

RAG memory stacks are powerful but heavy: a vector database, a container, an embedding service, ongoing ops. For small and medium projects that overhead is rarely worth it, yet you still want the agent to remember everything and improve itself across sessions.

`llm-wiki-memory` gives you that loop with a local hosted wiki as the substrate. Every category stays a nested tree (never a flat pile of files): non-daily categories nest by the metadata facets you search by; daily by date; an additional `subject` axis scatters leaves by what they're about. Git history and validation come free, and the tree stays readable by humans. Recall runs on local embeddings — nothing leaves your machine.

## Works with your agent

Two independent axes: which client integrates, and which LLM extracts the memory.

| MCP client | Auto-capture hooks | MCP tools | Write-gate enforced |
| --- | :---: | :---: | :---: |
| **Claude Code** | ✅ SessionStart, PreCompact, PostCompact, SessionEnd, ExitPlanMode, PreToolUse | ✅ | ✅ L1+L2+L3 (instructions + hook + server) |
| **Cursor** | ✗ | ✅ | ✅ L1+L3 (instructions + server) |
| **Codex / OpenAI** | ✗ | ✅ | ✅ L1+L3 |
| **Claude Desktop** | ✗ | ✅ | ✅ L1+L3 |
| **Any MCP client** | ✗ | ✅ | ✅ L1+L3 |

Hook-driven auto-capture is Claude Code only, but **every client follows the same memory discipline** — recall before non-trivial work, propose-then-confirm before saving any self-improvement lesson, route "save to memory" to the right category, and treat any `UNTRUSTED ... BODY` fence as data rather than instructions. The discipline reaches every client two ways:

1. The MCP server's `instructions` field (returned on connect).
2. Rule files rendered into `.agents/rules/` (mirrored to `.claude/skills/`, `.claude/rules/`, and `.cursor/rules/`).

The **LLM provider** that extracts typed atoms during capture / compile / consolidate is set in `.llm-wiki-memory/settings/.env` and is independent of the client:

[![claude](https://img.shields.io/badge/claude_CLI-✓-D97757)](#) [![codex](https://img.shields.io/badge/codex_CLI-✓-000000)](#) [![anthropic](https://img.shields.io/badge/anthropic_API-✓-D97757)](#) [![openai](https://img.shields.io/badge/openai_API-✓-412991)](#) [![openai-compatible](https://img.shields.io/badge/openai--compatible-✓-228B22)](#) [![mock](https://img.shields.io/badge/mock-test--only-666)](#)

`openai-compatible` covers ollama, vLLM, lm-studio, llama.cpp server, and litellm proxies — point `MEMORY_LLM_BASE_URL` at a local endpoint and `OPENAI_API_KEY` becomes optional on loopback / RFC1918. The provider is auto-detected at install (`bootstrap.sh`); explicit `--provider` or a user-edited `.env` always wins.

## Install

Paste this into your AI coding agent:

> Clone `https://github.com/ctxr-dev/llm-wiki-memory` into `./.llm-wiki-memory/src` in this project, then run `./.llm-wiki-memory/src/bootstrap.sh`. This sets up a local LLM-wiki memory: hooks that capture conversations and compile them into knowledge and self-improvement lessons, a daily consolidation pass that refines the corpus over time, and a local stdio MCP server for save and recall. Use local embeddings, no Docker. When it finishes, if I am on Claude Code tell me to restart; otherwise show me `./.llm-wiki-memory/src/scripts/mcp-config.sh <my-client>` so I can register the server.

Or run it yourself:

```bash
git clone https://github.com/ctxr-dev/llm-wiki-memory ./.llm-wiki-memory/src
./.llm-wiki-memory/src/bootstrap.sh           # add --commit-memory to commit the wiki
./.llm-wiki-memory/src/bootstrap.sh --schedule daily   # optional: cron / launchd
```

The bootstrap is **idempotent** — re-running preserves user edits to `.env` and your rule files.

<details>
<summary><strong>What bootstrap does</strong></summary>

1. installs dependencies in `./.llm-wiki-memory/src`,
2. auto-detects the LLM provider (`claude` → `codex` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → `MEMORY_LLM_BASE_URL` → ollama at `:11434` → `mock`),
3. writes `./.llm-wiki-memory/settings/.env` (preserves your edits on re-run),
4. merges hooks into `.claude/settings.json` and the stdio server into `.mcp.json`,
5. renders vendor-neutral configs into `.agents/` and discipline rules into `.agents/rules/`, `.claude/skills/`, `.claude/rules/`, `.cursor/rules/`,
6. materialises the hosted wiki at `./.llm-wiki-memory/wiki` (with the layout template that declares `consolidate: refine | none` per category) and validates it,
7. adds `/.llm-wiki-memory` to `.gitignore` (`--commit-memory` commits the wiki instead),
8. optionally installs the daily compile + consolidate cron via a wrapper script (`--schedule daily`).

</details>

<details>
<summary><strong>Register with a non-Claude client</strong></summary>

```bash
./.llm-wiki-memory/src/scripts/mcp-config.sh cursor          # .cursor/mcp.json
./.llm-wiki-memory/src/scripts/mcp-config.sh codex           # ~/.codex/config.toml
./.llm-wiki-memory/src/scripts/mcp-config.sh claude-desktop  # claude_desktop_config.json
./.llm-wiki-memory/src/scripts/mcp-config.sh all
```

</details>

## How it works

```text
 AI session
   |  PreCompact / PostCompact / SessionEnd hooks (Claude Code)
   v
 flush.mjs ........ LLM extracts typed atoms .........> daily/<yyyy>/<mm>/<dd>/daily-<ts>.md
   |  SessionStart hook (once per UTC day)
   v
 compile.mjs ...... embedding + metadata dedup .......> knowledge/<area>/<atom_type>/<subject…>/
                                                        self_improvement/<area>/<task_type>/<subject…>/
                                                        (archives the source daily leaves)
   |  daily cron + hook-less skill rule
   v
 consolidate.mjs .. search-driven refinement ........> dedup (sha256 / lesson-key / cosine),
                                                       staleness flag, LLM merge near-duplicates,
                                                       LLM semantic refresh of stale leaves,
                                                       orphan archive, compress-archived bodies.
                                                       NEVER hard-deletes (uses disableDocument).
                                                       Working set: only categories declared
                                                       `consolidate: refine` in the layout YAML.

 ExitPlanMode hook ......................> plans/<area>/<subject…>/<slug>.plan.md

 MCP server (stdio): save_lesson, recall_lessons, save_to_dataset, search_memory,
                     consolidate_memory, get_memory_config, reload_provider, …
 skill-llm-wiki:     builds, nests, index-rebuilds, and validates the tree
 embed.mjs:          ranks recall queries against leaf embeddings (lexical fallback)
```

<details>
<summary><strong>Wiki layout (categories + the subject axis)</strong></summary>

Top-level categories: **`knowledge`**, **`self_improvement`**, **`plans`**, **`investigations`**, **`daily`** (and any custom categories declared in `<wiki>/.layout/layout.yaml`).

Every category is a nested tree (never a flat pile), so no directory grows unbounded:

- `knowledge/<area>/<atom_type>/<subject…>/`
- `self_improvement/<area>/<task_type>/<subject…>/`
- `plans/<area>/<subject…>/`
- `investigations/<area>/<subject…>/`
- `daily/<yyyy>/<mm>/<dd>/`

The `subject` axis (a `kind: path` facet) carries a controlled-vocabulary first segment (`languages` / `frameworks` / `architecture` / `observability` / …) plus arbitrary deeper segments — leaves are scattered semantically by what they're about, not just structurally. Browsing the tree mirrors how recall filters; finding by content is independent of layout (recall embeds and walks every leaf). Existing flat installs re-nest with `node .llm-wiki-memory/src/scripts/cli.mjs nest`.

</details>

## Memory write-gate

Self-improvement lessons are **propose-then-confirm**: the agent NEVER calls `save_lesson` (or `save_to_dataset(dataset="self_improvement", ...)` / `write_memory(datasetId="self_improvement", ...)`) on its own initiative. It proposes the save in chat, waits for an explicit user yes in the same turn, then calls the tool with `userRequested: true`. The server refuses gated writes without the flag.

Three enforcement layers, belt-and-suspenders:

1. **L1 — discipline (instructions).** Every connecting client receives the discipline at `initialize`; rule files mirror it in `.agents/rules/`, `.claude/rules/`, `.cursor/rules/`.
2. **L2 — Claude Code `PreToolUse` hook.** Inspects the latest user turn for explicit save phrases; matches → `allow`, otherwise → `ask` (user clicks yes/no). Also denies direct `Write`/`Edit` to Claude Code's per-client memory directory (`~/.claude/projects/<workspace>/memory/`).
3. **L3 — MCP server-side guard.** Required `userRequested: boolean` argument on the three gated writers. The server also detects `path:` overrides that try to land a write in `self_improvement/...` from a non-gated `dataset:` claim (closes the path-bypass).

Knowledge, plans, investigations, daily, and tracker-issue writes are **not** gated — their routing rules apply directly.

Set `MEMORY_WRITE_GATE_SELF_IMPROVEMENT=off` in `.env` to disable the L3 check as an operator escape hatch (L1+L2 still apply).

## Consolidate (offline refinement)

The `consolidate` orchestrator runs nightly via the daily cron (chained after `compile`) and once per session via the hook-less skill rule. It walks the layout-declared `consolidate: refine` categories and applies these passes on each leaf's similarity cluster:

| Pass | What it does |
| --- | --- |
| `dedupe-by-sha256` | Group by exact body hash; archive losers with `supersedes_id`. |
| `dedupe-by-lesson-key` | Group `self_improvement` leaves by `(project_module, area, task_type, error_pattern)`; archive duplicates. |
| `dedupe-by-cosine` | Pairs above the cosine threshold (default `0.97`; `0.995` on the lexical fallback) → archive older. |
| `llm-merge-near-duplicates` | LLM merges the keeper body from the (keeper, loser) pair; falls back to deterministic archive on failure. |
| `staleness-flag` | Marks long-unrecalled `self_improvement` leaves + eligible knowledge atoms (`bug-root-cause`, `feedback-rule`, `pattern-gotcha`) as `memory.stale: true`. |
| `llm-semantic-refresh` | For each stale leaf, the LLM keeps / rewrites / archives against the current cluster context. Cap per run: `MEMORY_CONSOLIDATE_REFRESH_MAX_PER_RUN`. |
| `prune-orphan-leaves` | Leaves with no inbound `[[link]]`, no `parents:`, no recall hits, older than `MEMORY_CONSOLIDATE_ORPHAN_TTL_DAYS` (default `365`) → archive. |
| `compress-archived` | Truncate long-archived bodies (preserves original sha256 in frontmatter for git recovery). |
| `prune-empty-ancestors`, `prune-embeddings`, `index-rebuild` | Corpus-wide structural cleanup. |

**Layout declares which trees are eligible.** Every category in `<wiki>/.layout/layout.yaml` must say `consolidate: refine` or `consolidate: none` — no defaults. `consolidate: none` categories (plans, investigations, daily by default — owned by other lifecycles) are never walked by per-leaf passes.

**LLM passes** reuse the same `JSON-output-with-retry` contract as `compile.mjs:decideAction` (fixed prompt + zod schema validation + retry on schema fail). The orchestrator probes the provider once at start and skips LLM passes cleanly if unavailable; deterministic passes still run.

**Determinism.** Deterministic passes produce byte-identical state across two runs with the same wiki + frozen clock. LLM passes are reproducible via `MEMORY_LLM_MOCK_FILE` / `MEMORY_LLM_MOCK_RESPONSE` for tests. Locking is shared with `compile.mjs`, so they never race; the daily cron chains them sequentially via a wrapper script.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `recall_lessons` | Recall self-improvement lessons before a task (fall-back ladder drops `error_pattern`, then `language`, then `task_type`). |
| `search_memory` | Cross-category embedding search with metadata pre-filtering. |
| `save_lesson` | **Write-gated.** Persist a lesson after explicit user yes (requires `userRequested: true`). |
| `save_to_dataset` | Upsert a plan, investigation, knowledge artefact, or other category by name. Write-gated when `dataset="self_improvement"`. |
| `write_memory` | Create a memory leaf, optionally superseding an existing one. Write-gated when `datasetId="self_improvement"`. |
| `consolidate_memory` | Run the deterministic + LLM consolidation passes. System-maintenance; not write-gated. |
| `disable_document` / `enable_document` / `delete_document` | Archive (reversible) or remove a leaf. |
| `audit_memory` | Surface duplicate keys, missing metadata, and cleanup candidates. |
| `list_datasets`, `get_memory_config`, `reload_provider`, `reload_layout` | Inspect categories, config, LLM provider, and force-refresh caches. |
| `validate_layout`, `validate_topology`, `test_path_compiler` | Layout + topology + placement-compiler sanity checks. |

## Configuration

All settings live in `./.llm-wiki-memory/settings/.env` (see [`templates/env.example`](templates/env.example)). Highlights:

| Key | Default | Meaning |
| --- | --- | --- |
| `MEMORY_LLM_PROVIDER` | auto | `claude` / `codex` / `anthropic` / `openai` / `openai-compatible` / `mock`. Detected at install. |
| `MEMORY_LLM_BASE_URL` | (unset) | OpenAI-compatible local endpoint (ollama, vLLM, lm-studio, llama.cpp, litellm). |
| `MEMORY_LLM_MODEL` | (unset) | Provider-agnostic model override (wins over `ANTHROPIC_MODEL` / `OPENAI_MODEL`). |
| `MEMORY_EMBED_MODEL` | `Xenova/bge-large-en-v1.5` | Embedding model — see the model comparison below. |
| `MEMORY_WRITE_GATE_SELF_IMPROVEMENT` | `on` | Operator escape hatch for the L3 server-side gate. |
| `MEMORY_CONSOLIDATE_INTERVAL_DAYS` | `1` | Throttle for `consolidate --if-due`. |
| `MEMORY_CONSOLIDATE_LLM_PASSES` | `on` | Disable to run deterministic-only consolidation. |
| `MEMORY_CONSOLIDATE_COSINE_THRESHOLD` | `0.97` | Dedup threshold (auto-bumped to `0.995` on the lexical fallback). |
| `MEMORY_RECALL_TOUCH` | `on` | Whether `searchMemoryFiltered` stamps `last_recalled_at` on hits (24h throttled). |

<details>
<summary><strong>Full env-knob list</strong></summary>

See [`templates/env.example`](templates/env.example) for the complete annotated set, including:

- LLM provider + model overrides
- Embedding backend / model / cache
- Hook thresholds (`MEMORY_HOOK_MAX_TURNS`, `MEMORY_HOOK_MAX_CHARS`, …)
- Compile tuning (`MEMORY_ATOM_BODY_MAX_CHARS`, `MEMORY_COMPILE_QUALITY_STRICT`, lock TTL)
- Embedding-cache GC cadence (`MEMORY_GC_INTERVAL_DAYS`)
- All `MEMORY_CONSOLIDATE_*` knobs (orphan TTL, staleness window, archive-body cap, cluster top-K + score threshold, LLM retry budget, refresh-per-run cap)
- Recall-touch throttle (`MEMORY_RECALL_TOUCH_MIN_HOURS`)
- Identity (`MEMORY_DEFAULT_PROJECT_MODULE`)

</details>

<details>
<summary><strong>Choosing an embedding model</strong></summary>

Recall ranks queries with an on-device [transformers.js](https://github.com/xenova/transformers.js) model, set by `MEMORY_EMBED_MODEL`. The default `Xenova/bge-large-en-v1.5` gives the best routing quality; lighter models trade some accuracy for a much smaller download. Sizes below are the **quantized** ONNX weights transformers.js downloads by default (full-precision is roughly 4× larger), lightest first:

| Model | Dim | Download | Notes |
| --- | :---: | :---: | --- |
| `Xenova/all-MiniLM-L6-v2` | 384 | ~25 MB | Smallest and fastest. Modest retrieval quality. |
| `Xenova/bge-small-en-v1.5` | 384 | ~35 MB | Strong quality for a small download. |
| `Xenova/bge-base-en-v1.5` | 768 | ~110 MB | Noticeably better routing than `small`. |
| `Xenova/bge-large-en-v1.5` | 1024 | ~340 MB | **Default.** Best routing quality. |

Prefer a smaller download? Set a lighter model in `.env`:

```bash
MEMORY_EMBED_MODEL=Xenova/bge-small-en-v1.5
```

Changing the model invalidates the embedding cache automatically. Stay within the MiniLM / BGE / GTE / mxbai families: they are mean-pooled with no query prefix, which is how this engine embeds. Prefix-based models (e5, nomic) underperform here because the engine doesn't add the `query:` / `search_document:` prefixes they expect.

</details>

## Manual commands

```bash
cd .llm-wiki-memory/src
node scripts/cli.mjs init             # materialise or repair the wiki shell
node scripts/cli.mjs validate         # skill-llm-wiki validate
node scripts/cli.mjs heal             # classify state and name the next command
node scripts/cli.mjs compile          # promote daily atoms now
node scripts/cli.mjs consolidate --if-due   # search-driven refinement (cron-friendly)
node scripts/cli.mjs gc-embeddings --if-due # throttled embedding-cache GC
node scripts/cli.mjs recall "<query>"
node scripts/cli.mjs search "<query>"
node scripts/cli.mjs where            # resolved paths, LLM provider, skill location
```

On non-hook clients you can schedule the daily promotion + consolidation:

```bash
./.llm-wiki-memory/src/bootstrap.sh --schedule daily   # cron on Linux, launchd on macOS
./.llm-wiki-memory/src/bootstrap.sh --schedule off     # remove
```

The cron entry calls a generated wrapper script (`state/cron-daily.sh`) — safe across workspaces whose paths contain single-quotes, percents, or spaces.

<details>
<summary><strong>Architecture (responsibility matrix)</strong></summary>

| Path | Role |
| --- | --- |
| `scripts/lib/wiki-store.mjs` | Storage seam: every document is a wiki leaf. Drives the skill for index-rebuild / validate / heal / rebuild. Houses the recall-touch instrumentation and the `getConsolidateLayout()` layout reader. |
| `scripts/lib/embed.mjs` | Transformer embeddings, cosine, content-hash cache (lexical fallback). The only retrieval engine. |
| `scripts/lib/recall.mjs` | The `recall_lessons` ladder, `search_memory`, and `save_lesson`. |
| `scripts/lib/llm.mjs` | LLM provider dispatch (claude / codex / anthropic / openai / openai-compatible / mock) + `health()` probe + `isLocalEndpoint` heuristic. |
| `scripts/lib/llm-callJSON.mjs` | Prompt-file + variable-interpolation + zod-schema-validated LLM JSON-call wrapper. Used by compile + consolidate. |
| `scripts/lib/maintenance-tag.mjs` | AsyncLocalStorage-backed `withSystemMaintenance` frame for the L3 write-gate exemption. |
| `scripts/lib/discipline.mjs` | Single source of the memory discipline (MCP `instructions` + the SessionStart context). |
| `scripts/lib/layout-validator.mjs` | Zod schema for `<wiki>/.layout/layout.yaml`. |
| `scripts/lib/wiki-cli.mjs` | Wrapper around the `skill-llm-wiki` bin (bottom-up `index-rebuild-one`). |
| `scripts/consolidate.mjs` | Search-driven AutoDream consolidation orchestrator. |
| `scripts/compile.mjs` | LLM-driven daily → knowledge / self_improvement promotion. |
| `scripts/hooks/*` | Claude Code lifecycle hooks (capture, gate, plan-sync, embed-gc). |
| `mcp-server/index.mjs` | Local stdio MCP server. |
| `templates/`, `bootstrap.sh`, `scripts/mcp-config.sh` | Install and multi-client registration. |

Full per-concern responsibility split (this package vs the underlying engine) and known smells: [**ARCHITECTURE.md**](ARCHITECTURE.md).

</details>

## Testing

```bash
npm test           # unit suite
npm run test:e2e   # full lifecycle against the real skill-llm-wiki CLI (LLM stubbed)
```

**664 tests** in total. The e2e suite builds a wiki from scratch in a temp directory and asserts genesis, daily capture, lesson + knowledge + plan + investigation absorption, compile promotion + dedup, recall, tree-growth integrity, and idempotency — against the real `skill-llm-wiki` CLI with mocked LLM responses.

## Requirements

Node 20 or newer, and git. No Docker, no Python. The embedding model downloads on first recall (set `MEMORY_EMBED_BACKEND=lexical` to skip it entirely).

## License

[MIT](LICENSE)

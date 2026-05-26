# Architecture & Separation of Concerns

How the two packages divide responsibility, where the boundary is, and why one
depends on the other. The guiding rule: **each package does one thing and does
it well** — the engine owns *structure*, the memory system owns *meaning*.

- [`@ctxr/skill-llm-wiki`](https://github.com/ctxr-dev/llm-wiki-memory) — the **structure engine** (domain-agnostic).
- `llm-wiki-memory` (this package) — the **memory adapter** (memory-domain).

---

## TL;DR

| | `@ctxr/skill-llm-wiki` | `llm-wiki-memory` |
|---|---|---|
| **Mandate** | Build & maintain a filesystem wiki — markdown leaves + per-folder `index.md` navigation — optimized for token-efficient LLM retrieval. | Turn such a wiki into a git-versioned, embedding-searchable agent memory: capture → classify → place → recall. |
| **Domain** | **Agnostic** over "markdown leaves with frontmatter" | **Memory-specific** (atoms, lessons, facets, trackers) |
| **Knows about memory/atoms/Jira/embeddings?** | **No** | **Yes** |
| **Knows how to generate `index.md` / balance a tree?** | **Yes** | **No** (delegates) |
| **Surfaces** | A CLI (`skill-llm-wiki …`) + a small lib/testkit | MCP server, lifecycle hooks, a CLI |
| **Dependency** | — | depends on the engine (`file:` dep), calls it as a **CLI subprocess** |

> **One-sentence boundary:** memory owns *content + placement + retrieval*; the
> engine owns *structure + indexing*. Memory writes its own leaf files, then asks
> the engine to (re)derive the navigation — and the engine never learns what a
> "lesson" or a "Jira issue" is.

---

## The seam (one picture)

```
        ┌─────────────────────────────────────────────────────────────┐
        │  Agent host  (Claude Code · Codex · Cursor · any MCP client)  │
        └───────────────┬─────────────────────────┬─────────────────────┘
              MCP tools  │                hooks    │   (Claude Code only)
        ┌───────────────▼─────────────────────────▼─────────────────────┐
        │  llm-wiki-memory            ── MEMORY DOMAIN ──                 │
        │  capture · classify · place · embed · recall · plan-lifecycle  │
        │  mcp-server · wiki-store · facets · topology-runtime · embed   │
        │                                                                │
        │  writes leaf .md files directly (fs)  ───────────────┐         │
        └───────────────┬────────────────────────────────────┬┘         │
                         │  spawnSync CLI                      │          │
                         │  scripts/lib/wiki-cli.mjs           │          │
                         │  (the ONE cross-package seam)       │          │
                         │  index-rebuild-one · build ·        │          │
                         │  validate · heal · rebuild          │          │
        ┌────────────────▼───────────────────┐                │          │
        │  @ctxr/skill-llm-wiki  ── ENGINE ── │                │          │
        │  index.md · validate · balance ·    │                │          │
        │  soft-DAG · heal · rebuild          │                │          │
        │  agnostic: "markdown leaves +       │                │          │
        │  frontmatter"                       │                │          │
        │  writes index.md ──────────────┐    │                │          │
        └────────────────────────────────┼────┘                │          │
                                          ▼                     ▼          │
        ┌────────────────────────────────────────────────────────────────┐
        │  <wiki>/   knowledge/ self_improvement/ plans/ investigations/   │
        │            daily/ issues/        + per-folder index.md           │
        │            .layout/layout.yaml   (contract)   .llmwiki/ (git)    │
        └────────────────────────────────────────────────────────────────┘
```

Both packages write into the wiki tree, but to **disjoint files**: memory writes
the **leaf `.md`** files; the engine writes the **`index.md`** files. Neither
touches the other's.

---

## Responsibility matrix

✅ = owns it · ➡️ = delegates to the other · ❌ = deliberately absent

| Concern | skill-llm-wiki (engine) | llm-wiki-memory (memory) |
|---|:---:|:---:|
| Tree shape & per-folder `index.md` generation | ✅ | ➡️ |
| Routing frontmatter (`entries[]`, `children`, `parents[]`, `shared_covers`) | ✅ | ➡️ |
| Structural validation (wiki-root, dup ids, provenance, size caps) | ✅ | ➡️ |
| `heal` (classify findings → next command) | ✅ | ➡️ |
| `rebuild` / **balance** (fanout sub-clustering, max-depth flatten) | ✅ | ➡️ |
| Soft-DAG (TF-IDF extra parents, overlay leaves) | ✅ | ❌ |
| Chunked, scale-safe frontmatter iteration | ✅ | ❌ |
| `routing_cost` quality metric | ✅ | ❌ |
| Git lifecycle (snapshot → phase commits → validate → finalize/rollback) | ✅ | ❌ |
| Intent resolution ("ask, don't guess" `INT-*` codes) | ✅ | ❌ |
| **Leaf `.md` authoring** (create/upsert/relocate/delete) | ❌ | ✅ |
| Layout contract — **path resolution / wiki recognition** | ✅ | ❌ |
| Layout contract — **body interpretation** (placement facets, `topology:`) | ❌ | ✅ |
| Facet placement (`area`, `atom_type`/`task_type`) + **subject axis** | ❌ | ✅ |
| Custom tracker topology (`issues/JIRA/…` tree, `to_path`/`from_path`) | ❌ | ✅ |
| Embeddings (Xenova `bge-large`) + vector cache + throttled GC | ❌ | ✅ |
| Semantic recall + the drop-rung recall ladder | ❌ | ✅ |
| Memory atoms / atom types / lessons / datasets | ❌ | ✅ |
| Plan lifecycle sync (checkbox → status/progress → folder move) | ❌ | ✅ |
| Empty-ancestor pruning after a move/delete | ❌ | ✅ |
| MCP server + tools | ❌ | ✅ |
| Lifecycle hooks (capture, compact, session-end) | ❌ (forbidden) | ✅ |
| Install / bootstrap / rule+skill distribution | ❌ | ✅ |

Note the symmetry: **every "❌ absent" on one side is a "✅ owns" on the other.**
That complementarity is the separation of concerns made concrete.

---

## Capability inventory (maximum detail)

### `@ctxr/skill-llm-wiki` — the structure engine

| Module / area | Responsibility |
|---|---|
| `ingest` + `orchestrator` | Walk a source tree, hash content, emit deterministic leaf candidates; drive the phased build pipeline (preflight → snapshot → ingest → draft → index → validate → commit). |
| `indices` | Generate each folder's `index.md`: routing frontmatter (`entries[]`, `children`, `shared_covers`) + auto-nav body; preserves authored orientation across rebuilds. Stamps `generator: skill-llm-wiki/v1` on the root index. |
| `validate` | Hard invariants: valid wiki root, duplicate-id detection, git fsck, provenance, size caps → structured findings. |
| `balance` | Post-convergence rebalance: sub-cluster folders over `fanout-target`, flatten single-child chains past `max-depth`; deterministic to a fixed point. |
| `operators` | Rewrite operators (DESCEND / LIFT / MERGE applied; NEST / DECOMPOSE detect-only) with a fixed tie-break order. |
| `soft-dag` | TF-IDF cosine assigns extra "soft" parents; `overlay` leaf type with `overlay_targets[]` — without moving files. |
| `chunk` | The single chokepoint for scale-safe frontmatter-only iteration with lazy body loading (bounded memory on multi-MB corpora). |
| `quality-metric` | `routing_cost` = bytes-read-per-query ÷ total-leaf-bytes; rewards nested over flat. |
| `contract` | **The consumer source of truth**: `FORMAT_VERSION`, leaf/index frontmatter schema, `SUBCOMMANDS`, exit codes, layout tokens. Deny-list pass-through keeps it schema-agnostic. |
| `paths` | Resolve `<wiki>/.layout/layout.yaml` and recognize a wiki root (`isWikiRoot`). Resolves the contract **path only — never reads its body**. |
| `init` | Seed a wiki + contract at `<topic>/.layout/layout.yaml`. |
| `join` | Multi-source merge (N≥2 read-only wikis) with id-collision policy. |
| `heal` | Classify validate findings (ok / fixable / needs-rebuild / broken) and name the next command — doesn't run it. |
| `intent` | Sole "ask, don't guess" enforcer; refuses ambiguous invocations with `INT-*` codes. |
| `tiered` | Build-time similarity ladder: Tier 0 TF-IDF → Tier 1 local MiniLM embeddings → Tier 2 sub-agent. **Not** a retrieval/RAG index. |
| `testkit` | Consumer test helpers: `runCli`, `make-wiki-fixture`, `readLeafFrontmatter`, `stub-skill`. |

**Public surface:** CLI subcommands (`build`, `extend`, `validate`, `rebuild`,
`fix`, `join`, `rollback`, `init`, `heal`, `where`, `contract`, + internal
`index-rebuild[-one]`) and a small exported lib/testkit. Invoked primarily as a
**CLI**, with the host LLM as orchestrator.

**Deliberately NOT:** no MCP server, no lifecycle hooks ("non-automation
contract"), no RAG / vector store / semantic-search retrieval, and no
memory/atom/lesson/Jira concepts. Leaf `type` is only `primary | overlay`.

### `llm-wiki-memory` — the memory adapter

| Module / area | Responsibility |
|---|---|
| `mcp-server/index.mjs` | Stdio MCP server; registers the tools; ships the memory discipline via `instructions`; hot-reloads `wiki-store`/`recall` without dropping the pipe. |
| `discipline` | Single source of the recall-before-work / save-on-correction rules (fed to MCP `instructions` + SessionStart context). |
| `wiki-store` | Leaf render + `writeMemory`/`saveDocument` upsert-by-name; metadata-driven placement with cross-facet **relocate**; `disable`/`enable`/`delete`; `searchMemoryFiltered` (frontmatter prefilter → cosine). Writes leaves directly; calls the engine for indexes. |
| `facets` | Infer `area` + `atom_type`/`task_type` with deterministic non-junk fallbacks. |
| `topology-runtime` + `path-compiler` | Load a layout's `topology:` block; run forward `to_path` / reverse `from_path` (tracker `issues/…` trees) with a mandatory **round-trip** check; inline JS runs in a locked-down `vm` sandbox. |
| `layout-validator` | Strict Zod schema over `layout.yaml` with line:col errors. |
| `topology-validator` | Sample-facet round-trip pre-flight for a topology. |
| `embed` | Xenova `bge-large-en-v1.5` (lexical fallback); model-stamped on-disk vector cache; throttled GC (`gc-embeddings --if-due`, `MEMORY_GC_INTERVAL_DAYS`, `.embed-gc.json`). |
| `recall` | Drop-rung recall ladder (error_pattern → language → task_type → area → project_module), workspace-scoped, with knowledge cross-refs appended. |
| `plan-sync` + `plan-frontmatter` + `tracker-parse` | Rewrite plan status/progress/flip-log from checkboxes; relocate the leaf into the matching lifecycle folder. |
| `fs-prune` | Remove ancestor dirs a move/delete emptied (no orphan `index.md`). |
| `work-context` | SessionStart context block (active branch/issue → top recalls). |
| `hooks/*` | `session-start`, `flush` (pre/post-compact + session-end distill), `exit-plan-mode` (capture approved plans), `plan-frontmatter-sync`, `embed-gc-session-end`. |
| `wiki-cli` | **The only shell-out to the engine** — see the seam below. |
| `bootstrap.sh` + `cli init` | Install: deps, wiki materialization (engine `build`), settings/MCP merge, rule/skill distribution, optional scheduled compile. |

**User-facing surfaces:**
- **MCP tools:** `get_memory_config`, `list_datasets`, `search_memory`, `recall_lessons`, `save_lesson`, `save_to_dataset`, `write_memory`, `disable_document`, `enable_document`, `delete_document`, `audit_memory`, `validate_layout`, `validate_topology`, `test_path_compiler`.
- **Hooks:** `SessionStart`, `PreCompact`, `PostCompact`, `SessionEnd` (flush + plan-frontmatter-sync + embed-gc), `PostToolUse` (`ExitPlanMode`, `Write|Edit`).
- **CLI:** `init`, `validate`, `validate-layout`, `validate-topology`, `test-path-compiler`, `heal`, `gc-embeddings`, `where`, `recall`, `search`, `compile`, `nest`, `migrate`.

---

## The seam: how memory uses the engine

**Mechanism:** a `file:` dependency, called as a **CLI subprocess** (`spawnSync`),
never imported as a library. The entire cross-package contact surface is one
file: `scripts/lib/wiki-cli.mjs`. `run()` requires exit 0 or throws a typed
`WikiCliError`; `runJson()` tolerates non-zero and parses a trailing JSON
envelope; `validate` degrades gracefully by scraping `"N error(s)"`.

| memory wrapper (`wiki-cli.mjs`) | engine subcommand | Why |
|---|---|---|
| `ensureIndexes` / `indexRebuildOne` | `index-rebuild-one <dir> <wiki>` | **Hot path** — regenerate `index.md` after every leaf write/move/delete (walks leaf→root, deepest-first, because a full rebuild won't create *new* nested indexes). |
| `indexRebuildAll` | `index-rebuild <wiki>` | Refresh all existing indexes. |
| `buildHosted` | `build … --layout-mode hosted --target <wiki>` | Materialize the wiki on install. |
| `validate` | `validate <wiki>` | Structural invariant check. |
| `heal` | `heal <wiki> --json` | Classify wiki state + name the next command. |
| `rebuild` | `rebuild <wiki> --quality-mode …` | Structural rebalance (the anti-flat-pile optimizer). |
| `where` / `contract` | `… --json` | Introspection (skill root, contract grammar). |

### Boundary ownership

| Question | Answer |
|---|---|
| Who writes leaf `.md` files? | **Memory**, directly via `fs` (`wiki-store.mjs`). No engine "write" command exists. |
| Who writes `index.md`? | **The engine**, only via the `index-rebuild[-one]` subprocess. It also stamps the `generator` marker. |
| Who parses `.layout/layout.yaml`? | **Both — but disjoint concerns.** Engine reads only the **path** (to recognize a wiki root); memory reads only the **body** (placement facets in `wiki-store`, the `topology:` block in `topology-runtime`). |
| Who owns embeddings / semantic search? | **Memory only.** The engine is embedding-agnostic (its MiniLM is build-time clustering, not retrieval). |
| Who owns the custom `issues/` tracker topology? | **Memory only.** The engine never reads the layout body, so it never sees `topology:`/`file_kinds`/`to_path`. |

---

## Verdict & known smells

**Separation of concerns: clean. Dependency: justified.**

- The "both parse `layout.yaml`" appearance is **not** overlap — recognition
  (engine, path-only) vs. interpretation (memory, body-only) are different jobs.
- Memory delegates *all* structural/index work through one chokepoint
  (`wiki-cli.mjs`) and never imports engine internals or edits engine-owned
  `index.md`. The engine stays reusable precisely because it carries none of the
  memory domain.

**Minor smells (do not blur ownership):**

1. **Per-write process fan-out** — `ensureIndexes` spawns one `node` subprocess
   per ancestor dir on every save (synchronous). Correct, but a perf cost on
   deep trees / bulk writes.
2. **Loose version coupling** — `file:` dep (no semver); the only cross-boundary
   compatibility token is the `generator: skill-llm-wiki/v1` marker, read only by
   the engine. Adequate, but there is no shared `FORMAT_VERSION` assertion at the
   seam.
3. **Internal (not cross-package) duplication** — `layout.yaml` is parsed in two
   memory modules (`wiki-store` for placement, `topology-runtime` for topology),
   each with its own cache.

---

## How to verify (key files)

- Seam: `scripts/lib/wiki-cli.mjs` (every engine call).
- Leaf authoring + placement: `scripts/lib/wiki-store.mjs`.
- Custom topology: `scripts/lib/topology-runtime.mjs`, `scripts/lib/path-compiler.mjs`.
- Embeddings: `scripts/lib/embed.mjs`.
- Engine recognition (path-only): `skill-llm-wiki/scripts/lib/paths.mjs`.
- Engine index generation: `skill-llm-wiki/scripts/lib/indices.mjs`.
- Engine contract / grammar: `skill-llm-wiki/scripts/lib/contract.mjs`.

> This document is descriptive, not normative — if the code and this file
> disagree, the code wins; please update this file in the same change.

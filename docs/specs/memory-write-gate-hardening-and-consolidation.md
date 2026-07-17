---
id: memory-hardening-and-consolidate.plan
type: primary
depth_role: leaf
focus: 'Plan: Memory Write-Gate Hardening + Search-Driven AutoDream Consolidation for `llm-wiki-memory`'
parents:
  - index.md
covers:
  - 'Plan: Memory Write-Gate Hardening + Search-Driven AutoDream Consolidation for `llm-wiki-memory`'
  - '---'
  - recall context for plan (3)
source:
  origin: inline
  hash: 'sha256:5671b90581d61f5be4eb10762256736799819e0088e6708a53355b44feef3abf'
updated: '2026-06-04'
memory:
  atom_type: plan
  project_module: repos
  area: llm-wiki-memory
  task_type: design
  status: active
  last_recalled_at: '2026-07-02T09:10:49.924Z'
  recall_count: 4
  priority: P2
status: pending
progress:
  total: 354
  done: 0
  label: 0/354
last_updated: '2026-07-17'
---

---
status: done
---

## Closed 2026-06-04 — scope shipped via separate change-sets (write-gate L1-L3, consolidate orchestrator, hardening PRs). Checkboxes intentionally left as authored; this plan was superseded by the shipped implementation (user-approved audit fix).

# Plan: Memory Write-Gate Hardening + Search-Driven AutoDream Consolidation for `llm-wiki-memory`

> **Plan provenance.** Claude-Code scratch plan. Per `.claude/rules/plans-lifecycle.md`, before implementation starts this file MUST be promoted into the wiki via
> `save_to_dataset(dataset="plans", file_kind="plan", name="memory-hardening-and-consolidate", area="llm-wiki-memory", status="pending", subject=["tooling","memory","consolidation","hardening"], ...)`
> and the scratch file deleted. The wiki leaf becomes the source of truth.

## Context

Two intertwined initiatives, shipped as one project because they touch the same write surface and the same MCP/CLI/skill scaffolding:

### Initiative A — Write-gate hardening (from `repos/memory-write-hardening-notes.md`)
Today the wiki-memory discipline tells the model to call `save_lesson` autonomously the moment the user corrects it. The user wants the inverse: **memory is read-freely, write-gated** — the model NEVER writes a `self_improvement` lesson on its own initiative; it proposes and asks first, and a deterministic gate refuses any write that wasn't user-approved. The notes document a 5-layer stack (L1 instructions → L2 PreToolUse hook → L3 MCP server-side gate → L4 disable client-local file memory → L5 persist rule). All five layers ship.

### Initiative B — Search-driven consolidation (AutoDream principles)
The wiki currently has `compile.mjs` (LLM-driven daily→knowledge promotion) and `gc-embeddings` (orphan-vector sweep) as background mutators, but nothing actively consolidates the existing corpus — finds near-duplicates, merges them, archives stale knowledge, keeps only the most current/correct state of each topic. We're adding a `consolidate` orchestrator that:
1. Iterates every active leaf in `self_improvement/` and `knowledge/`.
2. For each leaf, calls the existing `search_memory` MCP-equivalent to find the **similar cluster**.
3. Applies deterministic passes (sha256 dedup, lesson-key dedup, cosine archive, recall-touch, staleness flag, prune-empty, compress-archived, gc-embeddings, index-rebuild) on the cluster.
4. Optionally applies LLM-driven passes (merge near-duplicate bodies, refresh stale leaves) using the same JSON-output-with-retry contract that `compile.mjs:333 decideAction` already uses.
5. Exposes itself identically across all clients: one MCP tool (`consolidate_memory`), one CLI subcommand (`consolidate`), one skill rule for hook-less agents (`templates/skills/consolidate.md`), one chained daily cron entry (`compile && consolidate --if-due`).

### Why merge into one project
- Consolidate writes to leaves; the gate enforces the write rules. Consolidate must declare itself as system-maintenance so the gate exempts it (allow-list).
- Both initiatives modify `mcp-server/index.mjs`, `templates/skills/*`, `bootstrap.sh`, `discipline.mjs`. Shipping together avoids two rounds of plumbing changes.
- L1's discipline rewrite is the right place to also document the new `consolidate_memory` tool and the search-driven refinement loop.
- Hardening lands first inside the project so consolidate is born compliant with the gate contract.

## Locked decisions

1. **Order = hardening first, then consolidate.** Phase 1 ships the gate; Phase 2 onward builds consolidate on top of the new write contract.
2. **Gate strictness = propose-then-confirm.** Model is instructed never to write `self_improvement` lessons unilaterally. It MUST propose in chat ("want me to save this as a lesson?") and only call the tool after explicit user OK in this turn. The L2 hook + L3 server-side guard physically refuse writes lacking the `userRequested: true` flag.
3. **Gate scope = self_improvement writes only.** `save_lesson` and `save_to_dataset(dataset="self_improvement", ...)` are gated. All other categories (`knowledge`, `plans`, `investigations`, `daily`, `issues`) keep the current write semantics (auto-capture hooks unchanged). Knowledge captures are direct-write today and stay direct-write — knowledge is **refined** by consolidate over time, not gated on entry.
4. **Gate reach = all clients.** Ship L1 (invert + add invariant in `discipline.mjs`) + L2 (Claude Code `PreToolUse` hook) + L3 (MCP server-side `userRequested` arg requirement) + L5 (persist rule). L4 (deny `Write|Edit` under `~/.claude/projects/.../memory/`) is folded into L2's hook.
5. **Approval signal = `userRequested: true` arg on write tools.** Required boolean on `save_lesson` and on `save_to_dataset` when `dataset === "self_improvement"`. Server rejects missing/false with an explicit error guiding the model to propose-then-confirm. L2 hook in Claude Code may inject the flag when the latest user turn contains an explicit save phrase (decided by a deterministic phrase-match list in the hook); otherwise the hook returns `permissionDecision: "ask"` so Claude Code prompts the user.
6. **System-maintenance allow-list.** Consolidate's internal writes (`disableDocument`, `updateDocMetadata`, body rewrites via the LLM passes, recall-touch instrumentation) are tagged `_systemMaintenance: true` at the call site. The L2 hook + L3 server-side guard allow-list this tag. The model cannot set the tag directly — it's only set by the orchestrator's own code path (server-side, after a structural check). This keeps the gate airtight while letting the orchestrator function unattended.
7. **Consolidate is search-driven, not walk-driven.** For each leaf in the working set, use the existing `searchMemoryFiltered` (`wiki-store.mjs:900`) with the leaf's body as the query (top-K, scoreThreshold) — the returned cluster IS the candidate set for dedup / merge / refresh. Full-corpus walks remain only for the cheap structural passes (`prune-empty-ancestors`, `gc-embeddings`, `compress-archived`).
8. **Consolidate working set = all active leaves in self_improvement + knowledge.** Each run iterates the full set; cluster-search bounds the work per leaf. The daily cron makes total cost bounded. Dailies, plans, investigations are excluded (they have their own lifecycle owners).
9. **Recall-touch = keep, frontmatter write, 24h throttle.** `searchMemoryFiltered` and `recallLessons` stamp `memory.last_recalled_at = <now>` + increment `memory.recall_count` on every returned leaf above `scoreThreshold`, but only if the previous stamp is > 24h old (`MEMORY_RECALL_TOUCH_MIN_HOURS=24`). Frontmatter-only mutation; body hash unchanged → embedding cache stays valid. These writes carry `_systemMaintenance: true`.
10. **Never hard-delete.** Every consolidate pass uses `disableDocument` (`status: archived`); `deleteDocument` is NOT called from the orchestrator. Files persist on disk + git; recoverable via `enable_document`.
11. **Cosine threshold = 0.97 on bge-large; auto-bump to 0.995 on lexical fallback** (one-shot warning log). Pairs above threshold inside one cluster are dedup candidates.
12. **LLM passes default ON, opt-out via `MEMORY_CONSOLIDATE_LLM_PASSES=off`.** Refusal modes: missing provider → log once, run all deterministic passes, skip LLM passes (no crash); per-call timeout → deterministic fallback (archive without merge for the dedup case; leave stale flag for the refresh case).
13. **LLM call contract = same as `compile.mjs`.** Extract `compile.mjs:333 decideAction`'s LLM JSON-call helper into `src/scripts/lib/llm-callJSON.mjs` (if not already a module) and reuse from both `compile.mjs` and `consolidate.mjs`. Fixed prompts at `src/prompts/consolidate-merge.md` and `src/prompts/consolidate-refresh.md`. JSON output schema-validated; retry on invalid up to `MEMORY_CONSOLIDATE_LLM_MAX_RETRIES` (default 2); terminal failure → deterministic fallback.
14. **Cross-client reproducibility ≠ no LLM.** Reproducibility holds at the SYSTEM-CONTRACT level (same MCP/CLI surface across clients, same JSON shapes, same retry behaviour, same gate response). The deterministic-pure subset is byte-identical reproducible; the LLM-driven subset is testable via `MEMORY_LLM_MOCK_FILE` (`env.mjs`).
15. **No category cross-talk in dedupe / merge.** Cluster search is bounded to the originating leaf's category (`searchMemoryFiltered({ dataset: leaf.category })`). A `knowledge` leaf and a `self_improvement` leaf are NEVER merged even if highly similar — different lifecycles, different gating rules.
16. **Locking shares the compile lock.** Consolidate acquires the same `COMPILE_LOCK_PATH` so it never runs mid-compile (also bounds the shared LLM API budget).
17. **Cron entry is chained, not split.** `bootstrap.sh` schedules one job: `compile && consolidate --if-due`. One plist / one cron line per platform.
18. **Throttling state = single per-orchestrator** (`state/.consolidate.json`, `last_run_utc`); default interval `MEMORY_CONSOLIDATE_INTERVAL_DAYS=1`.
19. **Auto-capture hooks stay as-is for non-gated categories.** `session-end` flush (writes `daily/`), `pre-compact` / `post-compact` (compile work), `exit-plan-mode` (writes `plans/`) all continue unchanged — they don't touch the gated `self_improvement` category.
20. **Vendored vs upstream.** The hardening changes that need to propagate to other repos must also land in the upstream `@ctxr/skill-llm-wiki` package source — call it out in the verification section so the user remembers to mirror the change before re-publishing.
21. **LLM provider is resolved from `.llm-wiki-memory/settings/.env`, detected at install time, user-overridable.** The existing `llm.mjs` already reads `MEMORY_LLM_PROVIDER` via `envValue()` (process.env wins over `.env`-file value — `env.mjs:82-86`) and dispatches via switch (`llm.mjs:21-41`) to `claude` CLI / `codex` CLI / `anthropic` API / `openai` API / `mock`. `bootstrap.sh:58-64` already auto-detects `claude` → `codex` via `command -v` and writes the result to `.env` at install. Gaps to close as part of this plan: (a) detection misses `anthropic`/`openai` (no probe for `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`); (b) no support for OpenAI-compatible local endpoints (ollama, vLLM, lm-studio) — `openai` path's URL is hardcoded; (c) no way for the model or operator to introspect which provider is active. Consolidate's LLM passes (3A, 3B) consume the SAME provider — no separate config.

## Phase 0 — Scaffold

- [ ] Add env knobs to `src/scripts/lib/env.mjs` (mirrors `gcIntervalDays` / `GC_STATE_PATH` at `env.mjs:36,98`):
  - [ ] `CONSOLIDATE_STATE_PATH = path.join(MEMORY_DATA_DIR, "state", ".consolidate.json")`
  - [ ] `consolidateIntervalDays()` reading `MEMORY_CONSOLIDATE_INTERVAL_DAYS` (default `1`)
  - [ ] `consolidateCosineThreshold()` reading `MEMORY_CONSOLIDATE_COSINE_THRESHOLD` (default `0.97`)
  - [ ] `consolidateCosineLexicalThreshold()` reading `MEMORY_CONSOLIDATE_COSINE_LEXICAL_THRESHOLD` (default `0.995`)
  - [ ] `consolidateClusterTopK()` reading `MEMORY_CONSOLIDATE_CLUSTER_TOP_K` (default `12`; search results per leaf)
  - [ ] `consolidateClusterScoreThreshold()` reading `MEMORY_CONSOLIDATE_CLUSTER_SCORE_THRESHOLD` (default `0.75`; only include cluster hits above this — coarser than the dedupe threshold so the LLM-refresh prompt sees more context)
  - [ ] `consolidateOrphanTtlDays()` reading `MEMORY_CONSOLIDATE_ORPHAN_TTL_DAYS` (default `365`)
  - [ ] `consolidateStaleAfterMonths()` reading `MEMORY_CONSOLIDATE_STALE_AFTER_MONTHS` (default `6`)
  - [ ] `consolidateArchiveBodyMax()` reading `MEMORY_CONSOLIDATE_ARCHIVE_BODY_MAX` (default `1200`)
  - [ ] `consolidateArchiveAgeDays()` reading `MEMORY_CONSOLIDATE_ARCHIVE_AGE_DAYS` (default `30`)
  - [ ] `consolidatePassesEnv()` reading `MEMORY_CONSOLIDATE_PASSES` (default `"all"`)
  - [ ] `consolidateLlmPassesEnabled()` reading `MEMORY_CONSOLIDATE_LLM_PASSES` (default `"on"`)
  - [ ] `consolidateLlmMaxRetries()` reading `MEMORY_CONSOLIDATE_LLM_MAX_RETRIES` (default `2`)
  - [ ] `consolidateRefreshMaxPerRun()` reading `MEMORY_CONSOLIDATE_REFRESH_MAX_PER_RUN` (default `25`)
  - [ ] `recallTouchMinHours()` reading `MEMORY_RECALL_TOUCH_MIN_HOURS` (default `24`)
  - [ ] `writeGateSelfImprovementEnabled()` reading `MEMORY_WRITE_GATE_SELF_IMPROVEMENT` (default `"on"`; `"off"` disables the L3 server-side check, leaves L1/L2/L5 in place — operator escape hatch)
- [ ] Extend `normaliseMeta` in `src/scripts/lib/wiki-store.mjs:332` to pass through seven new memory-block keys (no defaults; absent = absent):
  - [ ] `last_recalled_at` (ISO string)
  - [ ] `recall_count` (non-negative integer)
  - [ ] `stale` (boolean)
  - [ ] `supersedes_id` (relative path string)
  - [ ] `consolidated_at` (ISO string)
  - [ ] `last_refreshed_at` (ISO string)
  - [ ] `consolidate_truncated_at` (ISO string)
- [ ] Extract the LLM JSON-call helper from `compile.mjs:333` into `src/scripts/lib/llm-callJSON.mjs`:
  - [ ] Signature `callJSON({ promptPath, vars, schema, maxRetries, llmConfig })` → returns validated JSON object or throws after retries
  - [ ] Refactor `compile.mjs` to import from the new module; preserve behaviour exactly; existing compile tests must still pass
- [ ] Add `truncateArchivedBody(doc, max, nowIso)` helper next to `disableDocument` in `wiki-store.mjs:807`: reads body, slices, appends `\n\n[truncated by consolidate at <nowIso>; original sha256 preserved in frontmatter.source.hash]\n`, writes via the same renderLeaf pipeline; sets `memory.consolidate_truncated_at`.
- [ ] Add `withSystemMaintenance(fn)` helper in `wiki-store.mjs` (or a new `src/scripts/lib/maintenance-tag.mjs` module): wraps a call so the MCP layer can detect it via a per-process flag (e.g. `process.env.__LLM_WIKI_INTERNAL_MAINTENANCE="1"` set/cleared around the call, or an AsyncLocalStorage frame). The L3 server-side gate's allow-list reads this flag — model code can NEVER set it from outside the orchestrator process. This is the structural guarantee that prevents prompt-injection bypass.

## Phase 0B — LLM provider configuration (install-time detection + override path)

Goal: make the active LLM provider unambiguous, persistable, and overridable — covering the cases the current auto-detect misses (API-key providers, local OpenAI-compatible endpoints).

### 0B.1 — Expand bootstrap detection
- [ ] Edit `src/bootstrap.sh:58-64` (the existing `claude` / `codex` `command -v` loop). New priority order (configurable via `--provider <name>`; otherwise picks the first match):
  1. `--provider <explicit>` flag (already supported; keep)
  2. `MEMORY_LLM_PROVIDER` already exported in the environment (already supported via `envValue`; keep)
  3. `command -v claude` exists → `claude`
  4. `command -v codex` exists → `codex`
  5. `$ANTHROPIC_API_KEY` is set → `anthropic`
  6. `$OPENAI_API_KEY` is set → `openai`
  7. `MEMORY_LLM_BASE_URL` is set OR ollama is reachable at `http://localhost:11434` (curl probe with `--max-time 1` — fail-silent) → `openai-compatible` (new provider; see 0B.2)
  8. Fallback → `mock` (don't silently default to `claude` if the binary isn't installed — that just causes runtime failures later)
- [ ] When falling back to `mock`, emit a clear stderr warning so the operator sees it: `"[bootstrap] No LLM provider detected. Defaulting to 'mock'. consolidate's LLM passes will be skipped. Set MEMORY_LLM_PROVIDER or one of {ANTHROPIC_API_KEY, OPENAI_API_KEY, MEMORY_LLM_BASE_URL} in .llm-wiki-memory/settings/.env to enable."`
- [ ] After detection, write the resolved provider to `.llm-wiki-memory/settings/.env` (existing pattern at `bootstrap.sh:71-78`); preserve any user-edited lines.
- [ ] Idempotency: re-running `bootstrap.sh` should NOT overwrite a user-edited `MEMORY_LLM_PROVIDER` line. If `.env` already has that line, keep it. (Confirm current behaviour at `bootstrap.sh:71-78` — fix if it overwrites.)

### 0B.2 — Add OpenAI-compatible local-model support
- [ ] In `src/scripts/lib/llm.mjs`, extend `callOpenAiApi()` (`:306`) to honour `MEMORY_LLM_BASE_URL` (default `https://api.openai.com/v1`). When non-default, treat as a local OpenAI-compatible endpoint (ollama / vLLM / lm-studio / llama.cpp server / litellm proxy):
  - [ ] `OPENAI_API_KEY` becomes optional when `MEMORY_LLM_BASE_URL` is set and points to localhost / 127.0.0.1 / a private RFC1918 address (heuristic for "local, no auth needed"); use empty bearer if absent.
  - [ ] `OPENAI_MODEL` env unchanged; user picks the model name the local server expects (e.g. `llama3.1:8b-instruct` for ollama).
- [ ] Add provider value `openai-compatible` as an alias / synonym for `openai` with the local-server defaults. The switch in `llm.mjs:21-41` routes both to `callOpenAiApi`. The distinction is purely documentary (lets `get_memory_config` report "running local").
- [ ] Add env knobs in `env.mjs`:
  - [ ] `llmBaseUrl()` reading `MEMORY_LLM_BASE_URL` (no default → falls back to provider's own default)
  - [ ] `llmModel()` reading `MEMORY_LLM_MODEL` (provider-agnostic override; if absent, `llm.mjs` falls back to `ANTHROPIC_MODEL` / `OPENAI_MODEL` per provider — preserves existing behaviour)

### 0B.3 — Surface the active provider
- [ ] Extend the existing `get_memory_config` MCP tool (already in `mcp-server/index.mjs`) to report the resolved `{provider, model, baseUrl, available: boolean}` block. `available` is a one-shot probe (CLI present / API key set / base URL reachable). Caches per process-lifetime; explicit `reload_layout` does NOT invalidate it (different concern). Add a `reload_provider` MCP tool that re-probes.
- [ ] Extend the existing `where` CLI subcommand (`scripts/cli.mjs`) to print the active provider block in the same format as `get_memory_config`. Lets the operator confirm config from a terminal without going through MCP.

### 0B.4 — Provider override path (operator UX)
- [ ] Document in `templates/env.example` (which `bootstrap.sh:71` copies to `.env` on first install):
  - [ ] Each `MEMORY_LLM_*` knob with a one-line comment
  - [ ] A short comment block at the top: "This file is auto-detected at install. Edit any line to override; process.env wins over .env values. To re-detect: rerun `./bootstrap.sh` (it preserves user-edited lines)."
- [ ] Document in `templates/skills/consolidate.md` (Phase 4C) that consolidate's LLM passes use whatever provider is in `.env`; pointer to `get_memory_config` MCP tool for inspection.

### 0B.5 — Probe at orchestrator start (already in Phase 3 — confirm wiring)
- [ ] When `consolidate.mjs` starts, if `consolidateLlmPassesEnabled()` is true, call the resolved provider's `health()` (new method in `llm.mjs` — one ping, 2s timeout). If unavailable, set `consolidateLlmPassesEnabled` to false for this run and log `event=llm-provider-unavailable provider=<x> reason=<y>`. Single log line per run, not per call.

## Phase 1 — Write-gate hardening (L1 + L2 + L3 + L5)

### 1A — L1: invert the discipline (instructions)
- [ ] Read `.llm-wiki-memory/src/scripts/lib/discipline.mjs` and identify the `INSTRUCTIONS` array.
- [ ] Replace current Rule #2 ("call `save_lesson` BEFORE replying when corrected") with the new invariant:
  > "Memory is **read-freely, write-gated**. Recall as needed (`recall_lessons`, `search_memory`). NEVER call `save_lesson` or `save_to_dataset(dataset='self_improvement', ...)` on your own initiative. When you think a lesson is worth saving, PROPOSE it to the user in one sentence ('Want me to save this as a lesson? Title: …, error_pattern: …') and only call the tool after explicit yes in this turn, passing `userRequested: true`. The server REFUSES self_improvement writes without this flag. Knowledge / plans / investigations / daily captures are NOT gated; the previous routing rules for those categories stand."
- [ ] Keep the existing rules about routing, `recall_lessons` discipline, MCP server health check, untrusted-body fences.
- [ ] Add a short rule about consolidate: "The `consolidate_memory` MCP tool runs system-level deterministic + LLM passes that refine self_improvement + knowledge over time. It is system-maintenance — you don't need to invoke it during normal turns. The daily cron runs it. Invoke manually only when the user asks."
- [ ] Mirror the change in `.llm-wiki-memory/src/templates/skills/self-improvement.md` (the rule the model sees when reading skills).
- [ ] Audit the other capture skills for autonomous-save language: `investigation-capture.md`, `session-end-capture.md`, `current-work-context.md`, `plan-capture.md`. Confirm none of them instruct the model to write `self_improvement` lessons. Adjust any drift.
- [ ] Re-run `bootstrap.sh` to re-render `.agents/rules/`, `.claude/skills/`, `.cursor/rules/` from the updated templates. Confirm the new rule is present in all three.

### 1B — L2: Claude Code PreToolUse hook
- [ ] Create `src/scripts/hooks/pretooluse-gate-memory-writes.mjs`:
  - [ ] Read the JSON payload from stdin (`{tool, args, transcript_path, ...}`).
  - [ ] If `tool` is NOT one of `mcp__llm-wiki-memory__save_lesson` / `mcp__llm-wiki-memory__save_to_dataset` / `mcp__llm-wiki-memory__write_memory`: exit 0 (allow, untouched).
  - [ ] For `save_to_dataset`: if `args.dataset !== "self_improvement"`: exit 0 (allow). Other datasets are not gated.
  - [ ] For gated writes: tail the transcript (last user message) and check for explicit save phrases: `/\b(save|memori[sz]e|remember|store|persist|record)\b/i` AND optionally `\b(lesson|memory|wiki|this)\b/i`. Deterministic regex match.
  - [ ] If matched: write `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"user explicitly requested save in this turn"}}` to stdout and exit 0. (The L3 server-side check still enforces the `userRequested:true` arg — defence in depth.)
  - [ ] If NOT matched: write `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"self_improvement write without explicit user request"}}`. Claude Code prompts the user; nothing is auto-committed.
  - [ ] On parse failure / unknown shape: `permissionDecision: "ask"` (fail-closed).
- [ ] Add a SECOND `PreToolUse` hook script `src/scripts/hooks/pretooluse-deny-client-memory-path.mjs`:
  - [ ] For `tool` in `{Write, Edit, NotebookEdit}`: deny if `args.file_path` starts with `~/.claude/projects/.../memory/` (path-normalize and compare). Stdout `permissionDecision:"deny"` + a reason. Covers L4.
- [ ] Wire both in `.llm-wiki-memory/src/templates/claude/settings.json` `PreToolUse` block with matchers `mcp__llm-wiki-memory__(save_lesson|save_to_dataset|write_memory)` and `Write|Edit|NotebookEdit` respectively.
- [ ] Run `bootstrap.sh` to render into `.claude/settings.json` in the project.

### 1C — L3: MCP server-side gate
- [ ] In `src/mcp-server/index.mjs`, locate the `save_lesson` and `save_to_dataset` tool registrations.
- [ ] Extend the input schema:
  - [ ] `save_lesson`: add `userRequested: z.boolean()` (REQUIRED). Description: "Set to true only when the user explicitly asked in this turn. The model must propose and wait for explicit yes before calling. Server refuses without this flag."
  - [ ] `save_to_dataset`: add `userRequested: z.boolean().optional()`. Server only requires it when `dataset === "self_improvement"`.
- [ ] In each handler, before invoking the underlying implementation:
  - [ ] If the call is gated (per category) AND `writeGateSelfImprovementEnabled()` is on AND the `withSystemMaintenance` flag is NOT set AND `userRequested !== true`: return an MCP error response `{ ok: false, error: "self_improvement writes require userRequested:true (propose to the user and wait for explicit yes; the discipline rule in your instructions explains the contract)" }`. Do NOT call the underlying writer.
  - [ ] If `userRequested === true` OR `withSystemMaintenance` is set: proceed normally.
- [ ] Confirm `recall_lessons`, `search_memory`, `disable_document`, `enable_document`, `delete_document`, `consolidate_memory` (added in Phase 4) are NOT subject to the gate. (Disable/enable/delete are administrative; surface them but do not gate them at this layer — the orchestrator uses them with the maintenance tag, the user can call them directly when they want.)

### 1D — L5: persist the rule + extend the existing lesson
- [ ] Locate the existing lesson `self_improvement/.../lesson-never-write-to-the-client-local-file-memory-unprompted-….md` (mentioned in the hardening notes); extend its body to cover the wiki too:
  - [ ] Add a section: "**Extension (2026-06-02):** The same rule applies to wiki writes. NEVER call `save_lesson` or `save_to_dataset(dataset='self_improvement', ...)` without explicit user request in this turn. The MCP server now enforces this via a `userRequested:true` arg requirement; the Claude Code `PreToolUse` hook returns `permissionDecision:'ask'` if the rule is bypassed. Propose and wait for yes."
  - [ ] Save back via `save_to_dataset` (with `userRequested:true` set BY THE USER if doing manually, OR via the system-maintenance pathway since this IS a hardening rollout).
- [ ] Create a short hard-rule file `src/templates/rules/memory-write-gate.md`:
  - [ ] One-paragraph rule statement (verbatim version of the discipline rule from 1A, plus the propose-then-confirm protocol).
  - [ ] `bootstrap.sh`'s `render_agent` already mirrors `templates/rules/*.md` to `.agents/rules/`, `.claude/rules/`, `.cursor/rules/` (per existing pattern at `bootstrap.sh:137`). Confirm the new file lands in all three.

### 1E — Cross-project propagation note
- [ ] Add a one-line note inside `discipline.mjs` (comment, not a runtime string) reminding maintainers: "Changes to INSTRUCTIONS must also land in upstream `@ctxr/skill-llm-wiki` source repo and be re-published before installing in other vendored locations."
- [ ] Note in the verification section that vendored `.llm-wiki-memory/` installs in other repos won't get this change until the package is republished + reinstalled.

## Phase 2 — Search-driven consolidate (deterministic passes)

The orchestrator is the SAME function that runs all passes (deterministic + LLM). Phase 2 builds the deterministic-only subset; Phase 3 layers the LLM passes on top.

### 2A — Orchestrator skeleton
- [ ] Create `src/scripts/consolidate.mjs`:
  - [ ] Export `consolidateMemory({ dryRun, ifDue, passes, force, llm, now })` (`now` injectable for tests).
  - [ ] If `ifDue` AND `last_run_utc` within `consolidateIntervalDays()` AND `!force`: return `{ skipped: "not-due" }`.
  - [ ] Acquire `COMPILE_LOCK_PATH` via `lib/lock.mjs:acquireLock`; on contention return `{ skipped: "locked-by", pid }`.
  - [ ] Wrap the entire run in `withSystemMaintenance(async () => { ... })` so every internal write carries the maintenance tag.
  - [ ] Compute the working set: `listActiveDocuments({ category: "self_improvement" })` ∪ `listActiveDocuments({ category: "knowledge" })`. Stable lex-ascending order for determinism.
  - [ ] For each leaf in the working set, compute its cluster: `searchMemoryFiltered({ query: leafBodyFirstNChars(leaf, 1024), dataset: leaf.category, project_module: leaf.memory.project_module, scoreThreshold: consolidateClusterScoreThreshold(), top: consolidateClusterTopK() })`. Filter the leaf itself out of the results.
  - [ ] Dispatch cluster-scoped passes (2B–2D, 3A–3B) on each (leaf, cluster) pair.
  - [ ] After all leaves processed, dispatch corpus-scoped passes (2E–2H) once.
  - [ ] Collect per-pass reports `{ name, before, after, archived, touched, merged, refreshed, flagged, freedBytes, ms }`.
  - [ ] Write `state/.consolidate.json` with `last_run_utc`; append one summary line to `state/.consolidate.log`.
  - [ ] Return `{ ok, dryRun, llm, passes: [...], total: { archived, touched, merged, refreshed, flagged, freedBytes } }`.
- [ ] Add `listActiveDocuments({ category })` helper in `wiki-store.mjs` if one doesn't already exist; reuse the walker pattern from `pruneEmbeddingCache:1052` / `searchMemoryFiltered:900`.

### 2B — `dedupe-by-sha256` (cluster-scoped)
- [ ] Within each cluster (the leaf + its similar neighbours from search), group by `frontmatter.source.hash`.
- [ ] For every group of size ≥ 2:
  - [ ] Keeper = newest `frontmatter.updated`; tiebreaker = lex-ascending `documentId`.
  - [ ] For each non-keeper:
    - [ ] `updateDocMetadata(id, { memory: { supersedes_id: keeperId, consolidated_at: now } })`.
    - [ ] `disableDocument(id)`.
    - [ ] Increment `report.archived`.
- [ ] Cross-category guard: cluster was already filtered to one category in the orchestrator, so this is automatic. Defensive assert anyway.

### 2C — `dedupe-by-lesson-key` (cluster-scoped, self_improvement only)
- [ ] Run only when the working-set leaf is in `self_improvement`.
- [ ] Within the cluster (self_improvement entries only), group by `(memory.project_module, memory.area, memory.task_type, memory.error_pattern)`. Skip groups whose `error_pattern` is empty.
- [ ] Same keeper rule + archive-with-supersedes_id as 2B.

### 2D — `dedupe-by-cosine-and-archive` (cluster-scoped)
- [ ] Detect backend via `activeBackend()` (`embed.mjs`); set threshold to `consolidateCosineThreshold()` (bge) or `consolidateCosineLexicalThreshold()` (lexical, emit one-shot warning).
- [ ] For the leaf's cluster, compute pairwise `cosine` between the LEAF and every cluster member (we don't need full O(n²) within the cluster — only leaf-vs-member matters because every member will get its own turn as the working-set leaf).
- [ ] For every member with `cosine(leaf, member) ≥ threshold`:
  - [ ] Keeper = newer `frontmatter.updated`; tiebreaker = lex-ascending id.
  - [ ] If the loser was already archived earlier this run (already-touched set), skip.
  - [ ] Apply archive-with-supersedes_id (`memory.supersedes_id`, `memory.consolidated_at`).
  - [ ] Track the (keeper, loser) pair in a `mergeCandidates` list (Phase 3A consumes it BEFORE the loser is archived if LLM passes are on).

### 2E — `staleness-flag` (corpus-scoped)
- [ ] List active leaves in `self_improvement` only (knowledge leaves don't get the stale flag — they're durable until consolidate's LLM-refresh acts on them).
- [ ] For each leaf, compute `lastActivity = max(memory.last_recalled_at, frontmatter.updated)`.
- [ ] If `now - lastActivity > consolidateStaleAfterMonths()` months:
  - [ ] `updateDocMetadata(id, { memory: { stale: true } })`. Increment `report.touched`.
- [ ] Else if `memory.stale === true`: clear (`updateDocMetadata(id, { memory: { stale: false } })`). Increment `report.touched`.

### 2F — `prune-orphan-leaves` (corpus-scoped)
- [ ] Build inbound-link map across the whole active wiki by scanning every active leaf body for `[[<id-or-name>]]` and every leaf's `frontmatter.parents:` (excluding `index.md`).
- [ ] A leaf is orphan iff: zero inbound `[[link]]`, zero non-`index.md` `parents:` entries, AND `frontmatter.updated < now - consolidateOrphanTtlDays()`, AND `memory.last_recalled_at` is absent.
- [ ] Exclude leaves whose `memory.atom_type` is in `["jira_issue","plan","investigation","decision","project-lore","reference"]` (graph lives partly outside the wiki).
- [ ] For each orphan: `updateDocMetadata` consolidated_at, `disableDocument`. Increment `report.archived`.

### 2G — `compress-archived` (corpus-scoped)
- [ ] Walk every category; list leaves with `memory.status === "archived"` AND `body.length > consolidateArchiveBodyMax()` AND `(now - frontmatter.updated > consolidateArchiveAgeDays())` AND `memory.consolidate_truncated_at` absent.
- [ ] For each: call `truncateArchivedBody`. Increment `report.touched`, accumulate `report.freedBytes`.

### 2H — `prune-empty-ancestors` + `prune-embeddings` + `index-rebuild` (corpus-scoped)
- [ ] After all leaf-mutating passes:
  - [ ] Walk every category root + facet directory; call `pruneEmptyAncestors(dir, wikiRoot)` (`fs-prune.mjs:13`). Idempotent.
  - [ ] Call `pruneEmbeddingCache({ ifDue: false, dryRun })` (`wiki-store.mjs:1021`).
  - [ ] Call `ensureIndexes(root, allTouchedAncestors)` (existing helper in `wiki-cli.mjs`).
- [ ] Accumulate `report.freedBytes`.

### 2I — Recall-touch instrumentation (covers the recall path, not the consolidate path)
- [ ] In `src/scripts/lib/wiki-store.mjs:searchMemoryFiltered`: after the result set is computed, for each returned record with score ≥ the call's `scoreThreshold`:
  - [ ] Read `memory.last_recalled_at` from the leaf.
  - [ ] If absent OR `now - last_recalled_at >= recallTouchMinHours()`:
    - [ ] Wrap in `withSystemMaintenance(...)` so the L3 gate exempts it (search hits are not user-authored saves).
    - [ ] `updateDocMetadata(id, { memory: { last_recalled_at: now, recall_count: (prev||0) + 1 } })`. Best-effort try/catch — search MUST NOT fail if metadata write fails (log + continue).
- [ ] Same instrumentation in `src/scripts/lib/recall.mjs:recallLessons`.
- [ ] Audit: re-check that `updateDocMetadata` does NOT re-trigger embedding compute on frontmatter-only changes (existing `upsertEmbedding` no-op-when-same-hash at `wiki-store.mjs:954` — confirm intact).
- [ ] Add `MEMORY_RECALL_TOUCH=off` env knob as a safety valve to disable instrumentation entirely.

## Phase 3 — Search-driven consolidate (LLM passes)

These piggyback on the cluster the orchestrator already computed per leaf. They run BEFORE the deterministic archive (2B / 2D) finalises, so the merge can choose to rewrite the keeper body rather than just discarding the loser. The orchestrator dispatch order per leaf is: 2B (sha256-dedup → mark mergeCandidates) → 2C (lesson-key dedup → mark mergeCandidates) → 2D (cosine-dedup → mark mergeCandidates) → **3A (llm-merge consumes mergeCandidates)** → finalise archive of losers → 2E onward.

### 3A — `llm-merge-near-duplicates`
- [ ] If `consolidateLlmPassesEnabled()` is false OR the runtime LLM provider is unavailable (probed once at orchestrator start, single log line `event=llm-provider-unavailable`): skip — losers still get archived without merge.
- [ ] For each (keeper, loser, source-pass) tuple in `mergeCandidates`:
  - [ ] Build prompt from `src/prompts/consolidate-merge.md` with variables `{keeperBody, keeperFrontmatter, loserBody, loserFrontmatter, sourcePass}`.
  - [ ] Call `callJSON({ promptPath, vars, schema: MERGE_SCHEMA, maxRetries: consolidateLlmMaxRetries() })` from `lib/llm-callJSON.mjs`.
  - [ ] `MERGE_SCHEMA`:
    ```
    { action: "merge" | "keep-keeper-unchanged" | "skip",
      merged_body?: string,        // required if action="merge"; capped at MEMORY_ATOM_BODY_MAX_CHARS (truncate-with-warn if over)
      keeper_id: string,           // must equal input keeper.id (hallucination guard)
      loser_id: string,            // must equal input loser.id
      reason: string }
    ```
  - [ ] Apply:
    - [ ] `merge`: rewrite keeper body via the `renderLeaf` pipeline (re-uses placement / hashing / embedding-cache invalidation); `updateDocMetadata(keeperId, { memory: { consolidated_at: now } })`; then archive loser. Increment `report.merged`, `report.archived`.
    - [ ] `keep-keeper-unchanged`: archive loser as deterministic path. Increment `report.archived`.
    - [ ] `skip`: leave both leaves active; push `{ class: "llm-rejected-merge", keeperId, loserId, reason }` to `report.flagged`.
  - [ ] On terminal `callJSON` failure: fall back to deterministic archive-without-merge; log `event=llm-merge-failed`.

### 3B — `llm-semantic-refresh`
- [ ] Runs AFTER 2E flagged stale leaves. Cap per run at `consolidateRefreshMaxPerRun()` (default 25); remaining stale leaves carry over.
- [ ] If `consolidateLlmPassesEnabled()` is false: skip; `stale` flags remain.
- [ ] List active leaves with `memory.stale === true` in `self_improvement` ∪ `knowledge`. Order by `last_recalled_at desc` (recently-accessed stale leaves first; they're more likely to be load-bearing).
- [ ] For each:
  - [ ] Reuse the cluster already computed for this leaf in the orchestrator's per-leaf loop (no duplicate search).
  - [ ] Filter the leaf itself out of the cluster.
  - [ ] Build prompt from `src/prompts/consolidate-refresh.md` with `{leafBody, leafFrontmatter, clusterBundle, lastRecalledAt, daysSinceRecall}`.
  - [ ] Call `callJSON({ schema: REFRESH_SCHEMA, ... })`.
  - [ ] `REFRESH_SCHEMA`:
    ```
    { action: "keep" | "rewrite" | "archive",
      leaf_id: string,                 // hallucination guard
      rewritten_body?: string,         // required if action="rewrite"; cap at MEMORY_ATOM_BODY_MAX_CHARS
      archive_reason?: string,         // required if action="archive"
      stale_after: boolean,            // model's verdict on the stale flag
      reason: string }
    ```
  - [ ] Apply:
    - [ ] `keep`: `updateDocMetadata(leafId, { memory: { stale: rsp.stale_after } })`. If `stale_after===false`, flag clears.
    - [ ] `rewrite`: rewrite body via `renderLeaf`; set `memory.stale=false`, `memory.last_refreshed_at=now`, `memory.consolidated_at=now`. Increment `report.refreshed`.
    - [ ] `archive`: stamp `memory.consolidated_at = now`, append `archive_reason` to `report.archive_reasons`, `disableDocument(leafId)`. Increment `report.archived`.
  - [ ] On per-leaf failure: log + leave stale flag in place; continue loop.

## Phase 4 — Cross-client wiring

### 4A — CLI
- [ ] Add `consolidate` case to `src/scripts/cli.mjs` (next to `gc-embeddings` ~line 167). Flags:
  - [ ] `--dry-run`
  - [ ] `--if-due`
  - [ ] `--force`
  - [ ] `--no-llm` (overrides env to disable LLM passes)
  - [ ] `--passes=<csv>`
  - [ ] `--cosine-threshold=<float>`
  - [ ] `--json`
- [ ] Implementation: `const { consolidateMemory } = await import("./consolidate.mjs"); out(await consolidateMemory({...}))`.

### 4B — MCP tool
- [ ] Register `consolidate_memory` in `src/mcp-server/index.mjs` (next to `audit_memory` ~line 399):
  - [ ] inputSchema (zod): `dryRun?`, `ifDue?`, `force?`, `llm?` (boolean), `passes?` (string[]), `cosineThreshold?` (0..1).
  - [ ] description: "Run search-driven memory consolidation: for each active leaf in self_improvement + knowledge, find similar leaves via internal vector search, then apply deterministic passes (sha256 / lesson-key / cosine archive, staleness, orphan, compress-archived, cache GC) and optional LLM passes (merge near-duplicate bodies, refresh stale leaves). No hard deletes. Throttled via MEMORY_CONSOLIDATE_INTERVAL_DAYS when ifDue=true. Safe from any client; orchestrator carries the system-maintenance tag so the write-gate exempts its internal writes."
  - [ ] Dynamic-import `consolidate.mjs`; note the same RELOADABLE caveat as `audit_memory`.
  - [ ] This tool is NOT subject to the L3 write-gate (it's a system tool, not a save).

### 4C — Skill rule (hook-less agents)
- [ ] Create `src/templates/skills/consolidate.md` modelled on `templates/skills/embed-gc.md`:
  - [ ] Frontmatter: `name: consolidate`, one-line description.
  - [ ] Body: at session end (after `embed-gc`), run `node .llm-wiki-memory/src/scripts/cli.mjs consolidate --if-due`. Self-throttled. Best-effort.
  - [ ] Do-NOT list: no mid-task; no `--force`; no `--no-llm` without a stated reason; do not override `--cosine-threshold` casually.
- [ ] `bootstrap.sh:render_agent` already iterates `templates/skills/*.md` into all three rule dirs — confirm.

### 4D — Daily cron
- [ ] In `src/bootstrap.sh schedule_job` (~line 205): change `local job_cmd="node \"$SRC_DIR/scripts/cli.mjs\" compile"` to `local job_cmd="node \"$SRC_DIR/scripts/cli.mjs\" compile && node \"$SRC_DIR/scripts/cli.mjs\" consolidate --if-due"`. One edit; covers both macOS launchd `ProgramArguments` and the Linux cron line.

## Phase 5 — Tests

All under `/Users/developer/repos/.llm-wiki-memory/src/test/`. Each test uses `MEMORY_DATA_DIR=$(mktemp -d)` and a frozen `now`.

### 5A — Hardening tests
- [ ] `test/hardening/gate-server.test.mjs`:
  - [ ] `save_lesson` without `userRequested` → error response
  - [ ] `save_lesson` with `userRequested:false` → error
  - [ ] `save_lesson` with `userRequested:true` → success
  - [ ] `save_to_dataset(dataset="self_improvement",...)` without flag → error
  - [ ] `save_to_dataset(dataset="knowledge",...)` without flag → success (not gated)
  - [ ] `save_to_dataset(dataset="plans",...)` without flag → success (not gated)
  - [ ] `MEMORY_WRITE_GATE_SELF_IMPROVEMENT=off` → gate disabled, all writes succeed without flag
  - [ ] Maintenance pathway: a call made inside `withSystemMaintenance(...)` succeeds without `userRequested`
- [ ] `test/hardening/pretooluse-hook.test.mjs`:
  - [ ] Hook script invoked with mocked stdin (Claude Code transcript) where last user turn contains "save this as a lesson" → stdout has `permissionDecision:"allow"`
  - [ ] Hook invoked with transcript that does NOT contain a save phrase → `permissionDecision:"ask"`
  - [ ] Hook for non-self_improvement `save_to_dataset` → exit 0 (allow untouched)
  - [ ] Path-deny hook for `Write` to `~/.claude/projects/.../memory/foo.md` → `permissionDecision:"deny"`
  - [ ] Path-deny hook for `Write` to `~/.claude/projects/.../some-other-dir/foo.md` → exit 0 (untouched)
- [ ] `test/hardening/discipline-instructions.test.mjs`:
  - [ ] Render the `INSTRUCTIONS` array from `discipline.mjs`; assert the new invariant string is present + the inverted rule is absent
  - [ ] Render `templates/skills/self-improvement.md`; assert same
- [ ] `test/hardening/bootstrap-render.test.mjs`:
  - [ ] Run `bootstrap.sh` in a temp dir; assert `.agents/rules/self-improvement.md`, `.claude/skills/self-improvement.md`, `.cursor/rules/self-improvement.md` all contain the new invariant
  - [ ] Assert `templates/rules/memory-write-gate.md` rendered into the three rule dirs
  - [ ] Assert `.claude/settings.json` `PreToolUse` entries for both new hooks

### 5B — Consolidate tests (deterministic passes)
- [ ] `test/consolidate/orchestrator.test.mjs`:
  - [ ] dry-run: no file mutations, returns `{dryRun:true}`
  - [ ] throttle: two `ifDue:true` calls back-to-back → second returns `{skipped:"not-due"}`
  - [ ] lock contention: two parallel runs → exactly one returns `{skipped:"locked-by"}`
  - [ ] passes allow-list: `passes:["dedupe-by-sha256"]` runs only that
  - [ ] frozen-clock determinism: two runs on a seeded wiki → byte-identical post-state (git diff empty)
  - [ ] working set: confirm only `self_improvement` + `knowledge` leaves enter the per-leaf loop; `plans`/`investigations`/`daily` untouched
- [ ] `test/consolidate/search-driven-cluster.test.mjs`:
  - [ ] Seed 5 leaves in `self_improvement` (one near-dup pair + three unrelated); assert cluster for the near-dup contains the partner above threshold; cluster for unrelated leaves contains only weak matches below `consolidateClusterScoreThreshold`
  - [ ] Confirm `searchMemoryFiltered` is called with `dataset` scoped to the leaf's own category
- [ ] `test/consolidate/dedupe-sha256.test.mjs`:
  - [ ] two same-body active leaves → older archived with supersedes_id
  - [ ] three same-body → keeper=newest, two archived
  - [ ] cross-category same-body → both kept (cluster is single-category, defensive flag)
- [ ] `test/consolidate/dedupe-lesson-key.test.mjs`:
  - [ ] two lessons same `(area, task_type, error_pattern)` in self_improvement cluster → older archived
  - [ ] empty `error_pattern` → ignored
  - [ ] knowledge-category leaf → never runs this pass
- [ ] `test/consolidate/dedupe-cosine.test.mjs`:
  - [ ] bge-large mock: cluster pair cosine ≥ 0.97 → older archived
  - [ ] just below threshold → no action
  - [ ] lexical backend: threshold auto-bumps to 0.995; warning emitted once
  - [ ] determinism: two runs → identical `report.archived`
- [ ] `test/consolidate/staleness.test.mjs`:
  - [ ] leaf with `last_recalled_at` 7mo ago, no `stale` → flagged
  - [ ] leaf with `last_recalled_at` 1mo ago, `stale:true` → unflagged
  - [ ] knowledge-category leaf → never gets stale flag (only self_improvement)
- [ ] `test/consolidate/orphan.test.mjs`:
  - [ ] no inbound `[[link]]`, no `parents:`, age > orphan TTL, no recall → archived
  - [ ] one inbound `[[link]]` → kept
  - [ ] excluded `atom_type` (`jira_issue`) → kept
- [ ] `test/consolidate/compress-archived.test.mjs`:
  - [ ] archived leaf, body > max, age > threshold → truncated, `consolidate_truncated_at` set, `freedBytes` reported
  - [ ] already truncated → no-op
  - [ ] active leaf → never touched
  - [ ] hash in `frontmatter.source.hash` preserved
- [ ] `test/consolidate/prune-ancestors.test.mjs`:
  - [ ] after archiving every leaf in a deep facet dir → ancestors with only `index.md` removed
  - [ ] never removes wiki root
- [ ] `test/consolidate/recall-touch.test.mjs`:
  - [ ] `searchMemoryFiltered` returns leaf above threshold → `last_recalled_at` stamped, `recall_count` incremented
  - [ ] second search within 24h → no second write
  - [ ] second search after >24h → write
  - [ ] `MEMORY_RECALL_TOUCH=off` → no writes ever
  - [ ] write failure inside touch path → caller unaffected
  - [ ] embedding cache NOT invalidated by metadata-only write
  - [ ] recall-touch writes carry maintenance tag → not blocked by L3 gate

### 5C — Consolidate tests (LLM passes)
- [ ] `test/consolidate/llm-merge.test.mjs`:
  - [ ] mock LLM `{action:"merge", merged_body:"...", keeper_id, loser_id, reason}` → keeper body replaced verbatim, loser archived, `report.merged===1`
  - [ ] mock `{action:"keep-keeper-unchanged"}` → keeper untouched, loser archived
  - [ ] mock `{action:"skip"}` → both kept active, `report.flagged` has `llm-rejected-merge`
  - [ ] hallucinated `keeper_id` → schema rejection → retry → terminal failure → deterministic archive-without-merge fallback
  - [ ] `MEMORY_CONSOLIDATE_LLM_PASSES=off` → 3A skipped; 2D losers still archived (deterministic path)
  - [ ] `MEMORY_LLM_MOCK_FILE` deterministic replay → byte-identical post-state across two runs
  - [ ] merged_body exceeds `MEMORY_ATOM_BODY_MAX_CHARS` → truncated-with-warning, action still applied
- [ ] `test/llm-provider/bootstrap-detection.test.mjs`:
  - [ ] `claude` on PATH, no other signals → resolved provider = `claude`, written to `.env`
  - [ ] `claude` absent, `codex` on PATH → `codex`
  - [ ] both absent, `ANTHROPIC_API_KEY` set → `anthropic`
  - [ ] both absent, `OPENAI_API_KEY` set → `openai`
  - [ ] none of the above, `MEMORY_LLM_BASE_URL=http://localhost:11434/v1` set → `openai-compatible`
  - [ ] nothing detected → falls back to `mock`; stderr warning emitted
  - [ ] re-run bootstrap with user-edited `MEMORY_LLM_PROVIDER=anthropic` in `.env` → preserved (not overwritten)
- [ ] `test/llm-provider/openai-compatible.test.mjs`:
  - [ ] `MEMORY_LLM_BASE_URL=http://localhost:11434/v1`, no API key → call uses empty bearer, hits the base URL (mocked via http stub)
  - [ ] `MEMORY_LLM_BASE_URL=https://api.openai.com/v1`, `OPENAI_API_KEY` set → standard openai behaviour, no regression
  - [ ] `MEMORY_LLM_BASE_URL=http://10.0.0.5/v1` (private RFC1918), no API key → empty bearer accepted
  - [ ] `MEMORY_LLM_BASE_URL=https://example.com/v1`, no API key → error (refuses to send unauthenticated requests to public hosts)
- [ ] `test/llm-provider/get-memory-config.test.mjs`:
  - [ ] `get_memory_config` returns `{provider, model, baseUrl, available}` block
  - [ ] `reload_provider` re-probes and updates `available`
  - [ ] `where` CLI prints the same block
- [ ] `test/consolidate/llm-refresh.test.mjs`:
  - [ ] stale leaf + mock `{action:"keep", stale_after:false}` → `stale` cleared, body unchanged
  - [ ] stale leaf + mock `{action:"rewrite", rewritten_body:"..."}` → body replaced, `last_refreshed_at` + `consolidated_at` set, `stale:false`
  - [ ] stale leaf + mock `{action:"archive", archive_reason:"..."}` → `disableDocument` called, archive reason in report
  - [ ] `consolidateRefreshMaxPerRun=3` with 7 stale → exactly 3 processed; remainder carries over
  - [ ] per-leaf LLM failure → other leaves still processed
  - [ ] `MEMORY_CONSOLIDATE_LLM_PASSES=off` → 3B skipped; stale flags preserved
  - [ ] knowledge-category stale leaves also processed (refresh applies to both self_improvement and knowledge)

### 5D — Cross-client tests
- [ ] `test/consolidate/cli.test.mjs`:
  - [ ] `node cli.mjs consolidate --dry-run --json` parses, expected schema
  - [ ] `--passes=foo` (unknown) → error
  - [ ] `--no-llm` → orchestrator runs with LLM passes disabled (assert via dry-run report)
- [ ] `test/consolidate/mcp.test.mjs`:
  - [ ] MCP `consolidate_memory` round-trip (mirror `audit_memory` test)
  - [ ] Tool is callable WITHOUT `userRequested` (not gated)
- [ ] `test/consolidate/bootstrap-cron.test.mjs`:
  - [ ] `./bootstrap.sh --schedule daily` installs a job whose command matches `compile && ... consolidate --if-due` (regex on `crontab -l` on Linux / plist on macOS)
  - [ ] `--schedule off` removes both
- [ ] `test/consolidate/integration-with-gate.test.mjs`:
  - [ ] End-to-end: run hardening setup + then run a full `consolidate` cycle → assert orchestrator's internal writes succeed (maintenance tag) and a parallel direct-call to `save_lesson` without `userRequested` is still refused

## Phase 6 — Edge cases (test each)

Hardening:
- [ ] L2 hook receives transcript with the save phrase quoted in a code fence (NOT actually a user save request): current regex would match. Decide: tolerate (defensive `permissionDecision: "ask"` from L3 covers it) OR refine regex to require the phrase outside code fences. Pick defensive-stays-with-ask.
- [ ] L2 hook stdin malformed JSON → fail-closed (`permissionDecision: "ask"`).
- [ ] L3 gate receives `userRequested: "true"` (string) → schema validator rejects (zod boolean). Document the error message clearly.
- [ ] L3 gate disabled via env BUT request comes from inside maintenance: still allowed (gate-off is permissive; tag is also permissive).
- [ ] Vendored install in another repo lags upstream: document the propagation gap.
- [ ] Discipline string contains both the new invariant and accidentally the old rule: bootstrap-render test guards against this.

Consolidate:
- [ ] Empty wiki: every pass returns zero; orchestrator exits 0.
- [ ] First-ever run (no state file): treated as "never run"; new file written on exit.
- [ ] Corrupt `state/.consolidate.json`: treated as never-run.
- [ ] Mid-pass `disableDocument` failure (file vanished): log, increment `report.errors`, continue.
- [ ] Concurrent `writeMemory` during dedupe: pass re-reads `frontmatter.updated` right before mutating; skip if changed (`event=skip-changed-under-pass`).
- [ ] Single-leaf cluster (search returned only the leaf itself): all cluster-scoped passes no-op.
- [ ] `MEMORY_CONSOLIDATE_PASSES=""`: orchestrator returns immediately with `passes:[]`.
- [ ] Cosine on lexical backend without bump: explicit test that bumped 0.995 is used.
- [ ] Recall-touch on a leaf without embedding: updates frontmatter; does NOT re-embed.
- [ ] `compress-archived` on body exactly `max` chars: no-op (strict `>`).
- [ ] Two-tier supersedes: A archives B which had previously archived C → A's `supersedes_id` points to A's direct victim; no chain collapse.
- [ ] Plans + investigations untouched by every consolidate pass (assertion test per category).
- [ ] LLM call timeout exceeds `MEMORY_LLM_TIMEOUT_MS` → caught, logged, deterministic fallback.
- [ ] LLM returns JSON with extra unknown fields → schema validator strips them.
- [ ] LLM returns `merged_body` exceeding cap → truncate-and-warn.
- [ ] LLM mock fixture missing a key → terminal failure → deterministic fallback (do NOT crash run).
- [ ] Refresh-related cluster contains the leaf itself → filtered out before sending to LLM.
- [ ] No LLM provider configured but `MEMORY_CONSOLIDATE_LLM_PASSES=on`: probe at start; if unavailable, force-off for the run with one log line.
- [ ] Concurrent compile + consolidate (same lock): consolidate holds lock; compile is blocked until release.
- [ ] Refresh enqueues a leaf for archive whose loser was already archived by 3A in same run: re-read `memory.status`; skip if archived.
- [ ] Cosine-matched pair where keeper has `last_refreshed_at` newer than loser's `updated`: pass it as a prompt variable so LLM doesn't downgrade refreshed content.
- [ ] `userRequested:true` set on the orchestrator's internal call by accident: maintenance tag wins; behaviour unchanged.

## Phase 7 — Review cycle

Per `.claude/rules/implementation-review-loop.md`:

- [ ] **Phase 7.1 (parallel review):** launch three scoped subagents in parallel:
  - [ ] Source-correctness agent over `discipline.mjs`, two new hook scripts, `mcp-server/index.mjs` gate deltas, `consolidate.mjs`, `wiki-store.mjs` deltas, `env.mjs` deltas, `cli.mjs` delta, `bootstrap.sh` delta — check Node/ESM imports, async/await correctness, zod schemas, error responses, regex correctness in the L2 hook.
  - [ ] Test-correctness agent over all new `test/hardening/*.test.mjs` and `test/consolidate/*.test.mjs` — assertion quality, fixture isolation, frozen-clock injection, mock LLM plumbing.
  - [ ] Architecture/lifecycle agent — `withSystemMaintenance` cannot be set from outside the orchestrator process, lock sharing with compile correct, no embedding-cache invalidation on metadata-only writes, deterministic ordering preserved across passes, search-cluster scoping bounded to one category, fail-closed default in L2 hook.
- [ ] **Phase 7.2 (fix all):** collect findings; fix every blocking, minor, and observation item. If genuinely debatable, ASK before deferring.
- [ ] **Phase 7.3 (re-review):** spawn fresh review agents; repeat 7.1→7.2→7.3 until zero issues remain.
- [ ] **Phase 7.4 (run tests):** `cd /Users/developer/repos/.llm-wiki-memory && npm test && npm run test:e2e`. Fix until green.
- [ ] **Phase 7.5 (done gate):** zero issues, zero failures, all checkboxes checked, **explicit user confirmation** before flipping plan state → `done`.

## Critical files

**New:**
- `/Users/developer/repos/.llm-wiki-memory/src/scripts/consolidate.mjs`
- `/Users/developer/repos/.llm-wiki-memory/src/scripts/hooks/pretooluse-gate-memory-writes.mjs`
- `/Users/developer/repos/.llm-wiki-memory/src/scripts/hooks/pretooluse-deny-client-memory-path.mjs`
- `/Users/developer/repos/.llm-wiki-memory/src/scripts/lib/llm-callJSON.mjs` (extracted from compile.mjs)
- `/Users/developer/repos/.llm-wiki-memory/src/scripts/lib/maintenance-tag.mjs` (or fold into wiki-store.mjs)
- `/Users/developer/repos/.llm-wiki-memory/src/prompts/consolidate-merge.md`
- `/Users/developer/repos/.llm-wiki-memory/src/prompts/consolidate-refresh.md`
- `/Users/developer/repos/.llm-wiki-memory/src/templates/skills/consolidate.md`
- `/Users/developer/repos/.llm-wiki-memory/src/templates/rules/memory-write-gate.md`
- `/Users/developer/repos/.llm-wiki-memory/src/test/hardening/*.test.mjs` (4 files)
- `/Users/developer/repos/.llm-wiki-memory/src/test/consolidate/*.test.mjs` (13 files; see Phase 5)

**Modified:**
- `/Users/developer/repos/.llm-wiki-memory/src/scripts/lib/llm.mjs` (extend `callOpenAiApi` to honour `MEMORY_LLM_BASE_URL`; add `openai-compatible` alias; add provider `health()` probe; keep existing switch shape)
- `/Users/developer/repos/.llm-wiki-memory/src/templates/env.example` (commented `MEMORY_LLM_*` knobs + override-instructions header)
- `/Users/developer/repos/.llm-wiki-memory/src/scripts/lib/discipline.mjs` (invert Rule #2, add invariant)
- `/Users/developer/repos/.llm-wiki-memory/src/templates/skills/self-improvement.md` (mirror)
- `/Users/developer/repos/.llm-wiki-memory/src/templates/claude/settings.json` (two new PreToolUse entries)
- `/Users/developer/repos/.llm-wiki-memory/src/scripts/lib/env.mjs` (new knobs + state paths)
- `/Users/developer/repos/.llm-wiki-memory/src/scripts/lib/wiki-store.mjs` (`normaliseMeta` passthrough; `truncateArchivedBody`; `searchMemoryFiltered` recall-touch; `listActiveDocuments` helper if missing; `withSystemMaintenance` if folded here)
- `/Users/developer/repos/.llm-wiki-memory/src/scripts/lib/recall.mjs` (`recallLessons` recall-touch)
- `/Users/developer/repos/.llm-wiki-memory/src/scripts/compile.mjs` (refactor `decideAction` to import from `lib/llm-callJSON.mjs`; behaviour preserved)
- `/Users/developer/repos/.llm-wiki-memory/src/mcp-server/index.mjs` (gate in `save_lesson` + `save_to_dataset`; register `consolidate_memory` tool)
- `/Users/developer/repos/.llm-wiki-memory/src/scripts/cli.mjs` (new `consolidate` case)
- `/Users/developer/repos/.llm-wiki-memory/src/bootstrap.sh` (`schedule_job` `job_cmd` chain; confirm `templates/rules/` and new hook scripts ship)

**Reused utilities (DO NOT re-implement; cite file:line):**
- `disableDocument` — `wiki-store.mjs:807`
- `updateDocMetadata` — `wiki-store.mjs:771`
- `pruneEmptyAncestors` — `fs-prune.mjs:13`
- `pruneEmbeddingCache` — `wiki-store.mjs:1021`
- `cachedEmbedding` — `embed.mjs:139`
- `cosine` — `embed.mjs:71`
- `contentHash` — `embed.mjs:28`
- `acquireLock` — `lib/lock.mjs`
- `placementDirForMeta` — `wiki-store.mjs`
- `searchMemoryFiltered` — `wiki-store.mjs:900`
- `ensureIndexes` — `wiki-cli.mjs`
- `activeBackend` — `embed.mjs`
- `callJSON` — newly extracted to `lib/llm-callJSON.mjs` (from `compile.mjs:333`)

## Verification (end-to-end)

Hardening:
- [ ] From any client, call `save_lesson` without `userRequested:true` → MCP error response. Call with `userRequested:true` → success.
- [ ] In a Claude Code session, ask the model to save a lesson — observe it propose first, only call the tool after explicit yes; observe the `PreToolUse` hook either auto-allows (phrase matched) or returns `ask` (user gets a prompt).
- [ ] Attempt `Write` to `~/.claude/projects/.../memory/foo.md` → `PreToolUse` hook denies.
- [ ] Open a Cursor session pointed at the same workspace, ask the model to save a lesson — it MUST propose first (per L1 instructions) and the server still refuses without `userRequested:true` (L3).
- [ ] Inspect rendered `.agents/rules/memory-write-gate.md`, `.claude/rules/memory-write-gate.md`, `.cursor/rules/memory-write-gate.md` — all present with identical content.

LLM provider:
- [ ] Fresh-install simulation: in a scratch dir, run `./bootstrap.sh` with no PATH match and no env keys → `.env` shows `MEMORY_LLM_PROVIDER=mock` + stderr warning.
- [ ] Real-install: re-run `./bootstrap.sh` here; confirm the existing `.env`'s `MEMORY_LLM_PROVIDER` is preserved.
- [ ] Inspect provider: from Claude Code, call `get_memory_config` MCP tool — assert the returned `{provider, model, baseUrl, available}` block matches the `.env` contents.
- [ ] Local model end-to-end: set `MEMORY_LLM_BASE_URL=http://localhost:11434/v1`, `MEMORY_LLM_MODEL=llama3.1:8b-instruct`, run consolidate `--no-llm` first (deterministic only) to confirm consolidate works, then drop `--no-llm` and confirm the LLM passes hit the local endpoint (network log / ollama logs).

Consolidate:
- [ ] CLI dry-run: `cd /Users/developer/repos/.llm-wiki-memory && node src/scripts/cli.mjs consolidate --dry-run --json` — exit 0, JSON shape verified, no `git diff` inside the wiki.
- [ ] CLI live against a seeded throwaway wiki (`MEMORY_DATA_DIR=$(mktemp -d)`): post-state matches dry-run preview.
- [ ] MCP smoke: from any client, call `consolidate_memory` with `dryRun:true`; compare against CLI JSON.
- [ ] Recall-touch end-to-end: `recall_lessons` on a known query, inspect target leaf → `memory.last_recalled_at` set, `recall_count` incremented; immediate re-recall → unchanged.
- [ ] Cron e2e: re-run `./bootstrap.sh --schedule daily`; on macOS `cat ~/Library/LaunchAgents/com.llm-wiki-memory.*.plist | grep consolidate`; on Linux `crontab -l | grep consolidate`. Both must show the chained command.
- [ ] Cross-client e2e (manual): boot Codex / Cursor / Claude Desktop on the same workspace; call `consolidate_memory` MCP tool from each → same JSON shape.
- [ ] Determinism e2e: seeded wiki under `git init`, run consolidate twice (deterministic-only mode `--no-llm`), `git diff` after second run must be empty.
- [ ] LLM-passes determinism: same seeded wiki + `MEMORY_LLM_MOCK_FILE` fixture → byte-identical post-state across two runs.
- [ ] Skill-rule render: post-bootstrap, `templates/skills/consolidate.md` appears in `.agents/rules/`, `.claude/skills/`, `.cursor/rules/`.

Documentation + propagation:
- [ ] Update `ARCHITECTURE.md` — new "write-gate" row + "consolidation" row in the responsibility matrix.
- [ ] Update `PERFORMANCE.md` — measured consolidate timings (deterministic-only + with LLM) on a real corpus.
- [ ] **Propagation to upstream:** mirror the discipline / hooks / MCP gate / skill / rule changes into the `@ctxr/skill-llm-wiki` package source (`/Users/developer/repos/skill-llm-wiki`), publish a new minor version (e.g. `1.5.0`), then update `.llm-wiki-memory`'s dep range. Other vendored installs WILL NOT pick up these changes until they reinstall.
- [ ] Promote this plan file into the wiki via `save_to_dataset(dataset="plans", file_kind="plan", name="memory-hardening-and-consolidate", area="llm-wiki-memory", status="pending", subject=["tooling","memory","consolidation","hardening"])` and delete the scratch copy at `/Users/developer/.claude/plans/i-need-to-1-cuddly-codd.md`.

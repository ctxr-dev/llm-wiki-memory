# Manual commands

```bash
cd .llm-wiki-memory/src

# Inspect what consolidate WOULD do (no mutations), then run it for real.
node scripts/cli.mjs consolidate --dry-run --force --json | jq
node scripts/cli.mjs consolidate --force --json | jq '.totals'

# Full cron-job (compile + consolidate + attempt log entry), and its health.
node scripts/cli.mjs cron-job
node scripts/cli.mjs cron-health | jq

# The classic ops trio.
node scripts/cli.mjs init       # materialise or repair the wiki shell
node scripts/cli.mjs validate   # skill-llm-wiki validate
node scripts/cli.mjs heal       # classify state and name the next command

# Recall / search from the terminal; resolved paths + provider.
node scripts/cli.mjs recall "<query>"
node scripts/cli.mjs search "<query>"
node scripts/cli.mjs where

# Recover a failed distillation (reads the stash, or the in-leaf raw fallback).
node scripts/cli.mjs redistill --leaf <path>      # one daily leaf
node scripts/cli.mjs redistill --session <id>     # newest stash for a session
node scripts/cli.mjs redistill --all              # every pending stash

# Import existing Markdown into a wiki as full leaves (stored verbatim, embedded whole).
node scripts/cli.mjs absorb <path...> --category=<name> [--match=<glob>]... \
     [--area=<a>] [--subject=<s>] [--atom-type=<t>] [--target=<sel>] [--dry-run]

# Schedule the hourly cron (or remove it).
./bootstrap.sh --schedule hourly   # cron on Linux, launchd on macOS, fires at :00 ('daily' = deprecated alias)
./bootstrap.sh --schedule off      # remove
```

On Linux the cron entry calls a generated wrapper (`state/cron-daily.sh`) — safe across workspaces whose paths contain single-quotes, percents, or spaces; on macOS the launchd job runs `node … cli.mjs cron-job` directly via discrete arguments (no wrapper).

See also the read-only health/observability commands in [mcp-tools.md](mcp-tools.md#read-only-cli-counterparts-no-mcp-tool) (`doctor`, `move-leaf`, `monitor`, `monitoring-health`).

## Architecture — responsibility matrix

| Path | Role |
| --- | --- |
| `scripts/lib/wiki-store.mjs` | Storage seam: every document is a wiki leaf. Drives the skill for index-rebuild / validate / heal / rebuild. Hosts the `getConsolidateLayout()` reader. |
| `scripts/lib/embed.mjs` | The retrieval engine's public facade: `embed`/`embedMany`, `contentHash`, tokenizer, and the transformer→lexical fallback orchestration. Implementation split across `embed-backend-state.mjs` (fallback state), `embed-runner.mjs` (worker + in-process inference) and `embed-cache-io.mjs` (the content-hash vector cache). |
| `scripts/lib/recall.mjs` | `recall_lessons` ladder, `search_memory`, `save_lesson`. |
| `scripts/lib/llm.mjs` | LLM provider dispatch (claude / codex / cursor / anthropic / openai / openai-compatible / mock) + `health()` probe + `isLocalEndpoint` heuristic. |
| `scripts/lib/llm-callJSON.mjs` | Prompt-file + variable-interpolation + zod-schema-validated LLM JSON-call wrapper. Used by compile + consolidate. |
| `scripts/lib/maintenance-tag.mjs` | AsyncLocalStorage-backed `withSystemMaintenance` frame for the server-side gate exemption. |
| `scripts/lib/discipline.mjs` | Single source of the memory discipline (MCP `instructions` + the SessionStart context). |
| `scripts/lib/layout-validator.mjs` | Zod schema for `<wiki>/.layout/layout.yaml`. |
| `scripts/lib/wiki-cli.mjs` | Wrapper around the `skill-llm-wiki` bin (bottom-up `index-rebuild-one`). |
| `scripts/consolidate.mjs` | Search-driven AutoDream consolidation orchestrator. |
| `scripts/cron-job.mjs` | Hourly cron entry point + structured attempt log + `cronHealth`. |
| `scripts/compile.mjs` | LLM-driven daily → knowledge / self_improvement promotion. |
| `scripts/hooks/*` | Claude Code lifecycle hooks (capture, gate, plan-sync, embed-gc, session-start). |
| `mcp-server/index.mjs` | Local stdio MCP server. |
| `templates/`, `bootstrap.sh`, `scripts/mcp-config.sh` | Install and multi-client registration. |

Full per-concern responsibility split (this package vs the underlying engine) and known smells: [../ARCHITECTURE.md](../ARCHITECTURE.md).

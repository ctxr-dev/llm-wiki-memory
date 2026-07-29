# MCP tools

| Tool | Purpose |
| --- | --- |
| `recall_lessons` | Recall self-improvement lessons before a task (fall-back ladder drops `error_pattern`, then `language`, then `task_type`). Pass `sections:["frontmatter"]` for a compact glance view. |
| `search_memory` | Cross-category embedding search with metadata pre-filtering. Each hit is annotated with its `priority`; relevance ranks first, priority breaks near-ties. Bodies are excerpted at the response boundary; `fullContent: true` for whole bodies, `sections:["frontmatter"]` for a glance. |
| `save_lesson` | **Write-gated.** Persist a lesson after explicit user yes (requires `gate.userRequested: true`). |
| `save_to_dataset` | Upsert a plan, investigation, knowledge artefact, or other category by name. Write-gated when `dataset="self_improvement"`. |
| `write_memory` | Create a memory leaf, optionally superseding an existing one. Write-gated when `datasetId="self_improvement"`. |
| `absorb_document` | Import an existing Markdown document into a wiki as a full leaf, stored verbatim and embedded whole (never distilled into short atoms). |
| `consolidate_memory` | Run the deterministic + LLM consolidation passes. System-maintenance; not write-gated. |
| `disable_document` / `enable_document` / `delete_document` | Archive (reversible) or remove a leaf. |
| `move_document` | Relocate a leaf within the curated (non-facet) zone, preserving content + embedding + both `index.md` files. Facet / topology categories relocate by metadata / compiler path instead, and are refused here. |
| `audit_memory` | Surface duplicate keys, missing metadata, and cleanup candidates. |
| `list_datasets`, `get_memory_config`, `reload_provider`, `reload_layout` | Inspect categories, config, LLM provider, and force-refresh caches. |
| `validate_layout`, `validate_topology`, `test_path_compiler` | Layout + topology + placement-compiler sanity checks. |

## `scopes` and `target`

**Every tool takes a required `scopes`** (a `string[]`) — the directories you're working in (your cwd plus any repos in play). It's never optional: an empty or missing `scopes` is rejected before the tool runs, and the engine walks each scope up to your home wiki to resolve context. Claude Code seeds a default at session start; other clients compute it from the working directory + git (the bundled `scope-seeding` skill carries the procedure).

**Every write names its destination — `target` is required.** `scopes` says which wikis a call concerns; `target` says which one a write goes into: the literal `"brain"` for your private tree, or a resolved level's wiki root / mount directory for a shared repo (discover them in `get_memory_config`'s `levels`). Omitting `target` is rejected, so the destination is always deterministic — which matters when two identical clones of one repo are in scope.

## Shared-repo writes

The engine never writes to a shared repo (a mount inside a git project) unless `target` names it. A shared write only *stages* the leaf in that repo's working tree and runs no git there — it isn't shared until a human commits and pushes it. If you later change a category's `ownership` in the mount's `layout.yaml`, re-run `bootstrap.sh` so the mount's `.gitignore` regenerates — it's a point-in-time snapshot of which categories are shared. Full team walkthrough → [shared-wikis.md](shared-wikis.md).

## Read-only CLI counterparts (no MCP tool)

- `cli.mjs doctor` — a layout-derived health scan (broken index refs, stray / orphan leaves; exit `3` on findings). `doctor --fix` surgically rebuilds affected parent indexes. Run it after any suspected cloud-sync event.
- `cli.mjs move-leaf <from> <to>` — the curated move above, from a shell.
- `cli.mjs monitor` / `cli.mjs monitoring-health` — the self-observability pair below.

See [commands.md](commands.md) for the full CLI.

## Self-observability (opt-in)

Enable with `bootstrap.sh --enable-self-observability`: on a confirmed llm-wiki-memory bug the agent records a redacted forensic capture under `.llm-wiki-memory/monitoring/<yyyy>/<mm>/<dd>/` (`cli.mjs monitor`), and at session-end offers to review the open captures (`cli.mjs monitoring-health`) and plan fixes. The capture tree lives outside the wiki: gitignored, never indexed, never auto-fixed. Opt out with `--disable-self-observability`.

## Caveat — cloud-synced workspaces

A sync daemon (Drive, Dropbox, iCloud, OneDrive) can relocate or half-replicate files mid-session. The wiki's own git repo is the source of truth: recover with `git reset --hard HEAD` and run `cli.mjs doctor` after a suspected scramble. The bundled `cloud-sync-safety` rule carries the full checklist.

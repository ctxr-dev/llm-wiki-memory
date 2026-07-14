## Project memory (llm-wiki-memory)

Project memory is available through the local `llm-wiki-memory` MCP server.
The memory discipline rules live in `.agents/rules/` (also mirrored to
`.claude/skills/`). Read them before doing non-trivial work.

Cross-tool **process rules** (e.g. the planning methodology) live in
`.claude/rules/` (Claude Code auto-loads them), mirrored to `.agents/rules/`
and `.cursor/rules/`.

Key tools:
- `recall_lessons`: call BEFORE starting any non-trivial work.
- `save_lesson`: WRITE-GATED. Propose ("Want me to save this as a lesson?") and only call after the user explicitly says yes in this turn, passing `gate:{userRequested:true}`. Server refuses without the flag.
- `save_to_dataset`: persist knowledge, plans, and investigations. `dataset="self_improvement"` is also write-gated (same `userRequested:true` rule); other datasets are not.
- `search_memory`: query the wiki for relevant context.
- `consolidate_memory`: system-maintenance. Daily cron + hook-less skill rule run it on a schedule. Invoke manually only when the user asks.

Call-shape invariants (every client): every tool takes a required `scopes: string[]` (the dirs in play — cwd plus repos this session); every write and document mutation needs an explicit `target` — `"brain"` for private memory or a level's root/mountDir, with no default (omitting it is rejected); and each call's inputs are ONE nested context object (`write:` / `select:` / `gate:{userRequested}` / `consolidate:` / `filters:`), where unknown or misplaced keys are rejected.

---
name: tool-scopes
description: Every llm-wiki-memory MCP tool takes a REQUIRED `scopes: string[]` argument — the directories you are working in (your cwd plus any repos in play). It is never optional; an empty or missing `scopes` is rejected at the protocol layer before the tool runs. The engine walks each scope up toward your home wiki to resolve context. SessionStart seeds a default value (Claude Code); hook-less clients compute it from cwd + git via the scope-seeding skill.
---

<!-- CANONICAL SOURCE: .llm-wiki-memory/src/templates/rules/tool-scopes.md
     bootstrap.sh renders this to .agents/rules/, .claude/rules/, and .cursor/rules/.
     Edit the template and re-render; do NOT hand-edit a rendered copy. -->

# Every memory tool requires `scopes`

Every tool exposed by the `llm-wiki-memory` MCP server takes a **required**
`scopes: string[]` argument. `scopes` is the list of directories you are
working in: your current working directory, plus any repositories in play this
session. The engine walks each scope upward toward your home wiki to resolve
which memory context the call concerns.

This applies UNIFORMLY to every tool — reads (`recall_lessons`,
`search_memory`, `get_memory_config`, `list_datasets`, the `validate_*` /
`test_path_compiler` inspectors), writes (`save_lesson`, `save_to_dataset`,
`write_memory`), document ops (`disable_document`, `enable_document`,
`delete_document`, `move_document`), and maintenance (`consolidate_memory`,
`audit_memory`, `reload_layout`, `reload_provider`). No exceptions.

## The invariant

> `scopes` is **never optional**. It must be a non-empty array of directory
> paths. An empty (`scopes: []`) or missing `scopes` is **rejected
> deterministically at the protocol layer** (an InvalidParams error) BEFORE the
> tool handler runs — the server never guesses a scope for you.

## How to obtain the value

- **Claude Code (and any client that runs the SessionStart hook):** the hook
  injects one line at session start naming the default scopes, e.g.
  `Memory scopes for this session: [<dir>, …]`. Reuse that value on every tool
  call for the rest of the session.
- **Hook-less clients (Cursor, Codex, generic MCP):** compute the value
  yourself from `process.cwd()` + git — see the **`scope-seeding`** skill. In
  short: pass your cwd, and add the git repo root (`git rev-parse
  --show-toplevel`) when you are inside a repo and it differs from cwd.
- **When you switch directories mid-session** (a new repo, a different working
  tree), recompute `scopes` from the new cwd + the repos now in play. Do not
  keep passing a stale value.

## Provider-agnostic by construction

Derive `scopes` from `process.cwd()` and git only. NEVER read a
client-specific environment variable (e.g. `CLAUDE_PROJECT_DIR`) to build it —
the memory engine serves every client uniformly, and a provider-specific signal
is absent (or wrong) on the others.

## Choosing where a write lands (the `target`)

`scopes` says which wikis the call *concerns*; `target` says which one a WRITE
goes INTO. They are different arguments with different jobs.

> Every write (`save_to_dataset`, `save_lesson`, `write_memory`) and every
> document mutation (`disable_document`, `enable_document`, `delete_document`,
> `move_document`) DEFAULTS to your **brain** — your private memory tree. To
> write into a **shared repo** (a `.llm-wiki-memory` mount that lives inside a
> project checked into git), you MUST **ask the user first**, then pass
> `target=<that repo's scope>` (its wiki root or mount directory, or the literal
> `"brain"` for the private tree).

- **Never write to a shared repo without the user choosing it.** A shared repo
  being present in `scopes` does NOT make it a write target — an unspecified
  `target` always resolves to the brain. The engine will not silently write to a
  shared level.
- **A shared write is working-tree only.** The engine writes the leaf into the
  shared repo's working tree and runs **no git** there. It is not committed and
  not shared until a human commits and pushes it. After a shared write, tell the
  user: *"written to `<path>` in `<repo>` — commit and push it in the repo to
  share it."*
- **A target naming no resolved level is an error**, not a fallback — the write
  is refused rather than quietly redirected to the brain.

## Quick reference

| Situation | Pass as `scopes` |
|---|---|
| Working in one repo | `["<repo-root>"]` (or `["<cwd>", "<repo-root>"]` when cwd is a subdir) |
| Working in a plain directory, no git | `["<cwd>"]` |
| Spanning two repos this session | `["<repoA-root>", "<repoB-root>"]` |
| Given a default at SessionStart | reuse it verbatim until you change directories |

| Where should this write land? | Pass as `target` |
|---|---|
| Your private memory (the default) | omit `target` (or `"brain"`) |
| A shared repo, AFTER the user chose it | `"<that repo's root or mount dir>"` — then tell them to commit + push |

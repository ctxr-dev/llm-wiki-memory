---
name: scope-seeding
description: Compute the REQUIRED `scopes` argument that every llm-wiki-memory MCP tool takes, then pass it on every call. Derive it from the working directory + git (your cwd, plus the git repo root when inside a repo) — provider-agnostic, never a client-specific env var. Run at session start and whenever you switch directories mid-session. Claude Code seeds this automatically via its SessionStart hook; hook-less clients (Cursor, Codex, generic MCP) MUST compute it themselves via this skill, or every tool call fails schema validation.
---

# Scope seeding

Every tool exposed by the `llm-wiki-memory` MCP server takes a **required**
`scopes: string[]` argument (the directories you are working in). A call with
an empty or missing `scopes` is rejected before it runs. This skill computes
the value so your calls succeed.

It is the companion to the `tool-scopes` rule (which states the requirement)
and mirrors `current-work-context` (same detect-cwd-and-git idea, different
output): where `current-work-context` builds a semantic query from the branch,
this skill builds the `scopes` array from the directories.

## When to invoke

Compute (or recompute) `scopes` — no special syntax, just do it before the next
tool call:

- **Session start**, before your first memory tool call. On Claude Code the
  SessionStart hook already injects a `Memory scopes for this session: [...]`
  line — reuse that value and skip the computation. On hook-less clients
  (Cursor, Codex, generic MCP) there is no such line, so you MUST compute it
  here.
- **When you switch directories mid-session** — a different repo, a new working
  tree, a second repo now in play. Recompute; do not keep passing a stale
  value.

Do NOT invoke when:

- You already have a current `scopes` value this session and the directories
  have not changed — reuse it.
- The wiki is not initialised in this workspace (no
  `<workspace>/.llm-wiki-memory/wiki/.layout/layout.yaml`); there is nothing to
  scope.

## Steps

1. **Detect cwd + repo root.** Use Bash (universal, provider-agnostic):
   ```
   pwd
   git -C "$(pwd)" rev-parse --show-toplevel 2>/dev/null || true
   ```
   `process.env.CLAUDE_PROJECT_DIR` and other client-specific variables are NOT
   reliable — llm-wiki-memory serves every client uniformly. `pwd` + git
   introspection are universal.

2. **Assemble the array.** Start with your cwd. Add the git repo root when you
   are inside a repo and it differs from cwd. Add the root of any OTHER repo you
   are also working in this session. Deduplicate; keep cwd first. Examples:
   - In a repo, cwd is the repo root: `["<repo-root>"]`.
   - In a repo, cwd is a sub-directory: `["<cwd>", "<repo-root>"]`.
   - Plain directory, not a git repo: `["<cwd>"]`.
   - Spanning two repos: `["<repoA-root>", "<repoB-root>"]`.

3. **Pass it on EVERY tool call.** Include `scopes` in the arguments of every
   `llm-wiki-memory` tool for the rest of the session (or until you recompute):
   ```json
   { "query": "cats-effect resource leak", "scopes": ["/Users/me/repos/webhooks"] }
   ```

4. **Recompute on a directory switch.** If you `cd` into a different repo or
   start touching a second one, redo steps 1-2 and pass the new value.

## Why the engine needs it

Each scope is walked upward toward your home wiki to resolve which memory
context the call concerns (which repo-level and shared levels are in play). The
server refuses to guess this for you: an empty or missing `scopes` is a
deterministic schema rejection, so seeding it is what keeps a freshly (re)started
server usable.

## Provider-agnostic by construction

`scopes` is derived from `pwd` + git only, so it works identically on Claude
Code, Cursor, Codex, and any generic MCP client. Never build it from a
client-specific environment variable.

## Reference

- Rule: [`tool-scopes`](./tool-scopes.md) — the requirement itself.
- Companion skill: [`current-work-context`](./current-work-context.md) — the
  branch-driven session-start context fetch (same cwd + git detection).
- MCP tools: every tool takes `scopes`; see the tool descriptions returned by
  `list_datasets` / the server's `initialize` instructions.

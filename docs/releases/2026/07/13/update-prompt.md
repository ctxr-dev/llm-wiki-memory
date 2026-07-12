# llm-wiki-memory: MCP tool inputs are now a single nested, strict context object (2026-07-13)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past the
**2026-07-13** release.

**WHO IS AFFECTED, read this first.** This release ships a **breaking MCP input-shape change**:

- **(breaking, wire shape) Every MCP tool now takes ONE nested context object, and every
  schema is strict (`additionalProperties:false`) — a flat call, or an unknown/typo'd key,
  is REJECTED, not silently accepted.** The scattered flat params are grouped:
  - **Writes** send a `write:{...}` object plus, only for a self_improvement write,
    `gate:{userRequested:true}`. `scopes` and `target` stay top-level.
    - `save_to_dataset({ scopes, target?, write:{ dataset, name, text, path?, metadata? }, gate?:{ userRequested } })`
    - `save_lesson({ scopes, target?, write:{ title, body, metadata, tags?, evidence? }, gate:{ userRequested } })`
    - `write_memory({ scopes, target?, write:{ name, text, datasetId, supersedes?, supersedesAction?, path?, metadata? }, gate?:{ userRequested } })`
  - **Mutates** send `select:{...}`:
    - `disable_document` / `enable_document` / `delete_document({ scopes, target?, select:{ dataset, documentId } })`
    - `move_document({ scopes, target?, select:{ documentId, toPath, dataset? } })`
  - **Maintenance**: `consolidate_memory({ scopes, target?, consolidate:{ dryRun?, ifDue?, force?, llm?, passes?, cosineThreshold? } })`;
    `audit_memory({ scopes, audit:{ classes? } })`.
  - **recall_lessons** nests its facets under `filters:{ area?, language?, task_type?, error_pattern?, project_module?, tags? }` (matching `search_memory`). `search_memory` and the read-only inspectors keep their existing fields (now strict).
- The advertised JSON schema itself carries the nesting + `additionalProperties:false`, so a
  capable client sends the right shape once it reads the reloaded schema. The formerly-flat
  `userRequested` is now `gate.userRequested`; `path` is now `write.path`; the mutate
  `dataset`/`documentId`/`toPath` move under `select`.

There is **no data migration** — this is a wire-contract change only; the on-disk wiki is
untouched. **The security-relevant context-derived checks are unchanged** (dataset must be a
declared category, target must be in the resolved scopes, the self_improvement write-gate); they
are still enforced at the parse step with the same actionable error envelope.

**Cross-package ordering (IMPORTANT).** The initialize-time discipline (rule 14, which teaches
the nested shape) lives in `scripts/lib/discipline.mjs`, shipped **verbatim** by the upstream
`@ctxr/skill-llm-wiki` package. **Republish `@ctxr/skill-llm-wiki` FIRST**, then flip this repo,
so a model connecting to an upgraded server is also taught the upgraded shape.

## How to use this file

In a Claude Code (or any capable agent) session inside the target repo, do either:

- **Reference it:** "Fetch and follow the runbook at
  `https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/docs/releases/2026/07/13/update-prompt.md`,
  applying it to this project."
- **Paste it:** copy everything inside the `--- PROMPT ---` fence below.

If you want it run unattended, add: "I am AFK; go to the end without interruptions, take the
safe default for each decision, and surface anything that blocks instead of stalling."

--- PROMPT ---

Update this project's vendored llm-wiki-memory runtime to the latest upstream. Work
autonomously; only stop for the genuine decisions listed at the end.

WHAT'S NEW UPSTREAM (why this matters):

The 2026-07-13 release changes the MCP tool INPUT SHAPE: every tool now takes one nested,
strict context object. Writes send `write:{...}` (+ `gate:{userRequested}` for a
self_improvement write); mutates send `select:{...}`; consolidate/audit send
`consolidate:{...}` / `audit:{...}`; recall facets move under `filters:{...}`. `scopes` and
`target` stay top-level. Unknown or misplaced keys are rejected (strict schemas), so a flat
call from the old contract stops parsing. No on-disk migration; routing/placement behaviour and
the write-gate are unchanged.

PROCEDURE:

1. Update the runtime.
   ```
   git -C .llm-wiki-memory/src fetch origin
   git -C .llm-wiki-memory/src merge --ff-only origin/main
   ( cd .llm-wiki-memory/src && npm install --no-audit --no-fund ) ; echo "npm install exit=$?"
   ```
   Must be a clean fast-forward AND `npm install exit=0`. If `--ff-only` fails because files
   changed mode `100755 → 100644` (a cloud-sync daemon stripped the exec bit), run
   `git -C .llm-wiki-memory/src config core.fileMode false`, then
   `git -C .llm-wiki-memory/src checkout -- .`, then retry. A genuine CONTENT divergence →
   surface it; never force.

2. Re-run the bootstrap (idempotent; re-renders the updated discipline rules — including the
   new nested-shape rule 14 — into `.agents/rules`, `.claude/rules`, `.cursor/rules`).
   ```
   ./.llm-wiki-memory/src/bootstrap.sh
   ```

3. Run the test suite.
   ```
   ( cd .llm-wiki-memory/src && npm test )
   ```
   Expected: all tests pass (includes the A6 nested-wire acceptance tests in `mcp.test` — a
   legacy FLAT call rejected, an unknown top-level/nested key rejected, a valid nested
   round-trip accepted).

4. RESTART so the new schema is live. THIS IS A HARD STEP — the running MCP server still
   advertises the OLD flat schema and validates against it, so during the window between
   updating the code and restarting, a client following the new (nested) discipline sends a
   shape the old server rejects, and a client following the old (flat) discipline sends a shape
   the new server would reject. On Claude Code, restart the session (or `/mcp` reconnect);
   other clients re-launch the server. `mcp-server/index.mjs` and the tool `inputSchema`
   registrations do NOT hot-reload — a restart is required.

5. Post-restart schema round-trip check (proves the new wire is live):
   ```
   node .llm-wiki-memory/src/scripts/cli.mjs where >/dev/null 2>&1; echo "cli ok=$?"
   ```
   Then, from your MCP client, issue ONE nested write and confirm it succeeds, and ONE flat
   write and confirm it is refused (see VERIFICATION).

DECISIONS:

- `git merge --ff-only` fails on mode-only changes (`100755 → 100644`) → cloud-sync stripped
  the exec bit; safe fix is `git config core.fileMode false` + `git checkout -- .` + retry. A
  genuine CONTENT divergence → surface it; never force.
- A custom category keeps working IFF it is declared in `.layout/layout.yaml` — unchanged by
  this release. If a write starts getting rejected with a "not a category declared at the
  target level" envelope, the fix is the layout, not the wire shape.
- The restart window (step 4) is unavoidable with a hard-cut. SAFE DEFAULT: restart promptly
  after step 3 passes, and do the republish of `@ctxr/skill-llm-wiki` BEFORE flipping servers
  so the taught shape and the enforced shape line up.

VERIFICATION:

The upgrade is successful if and only if:

- `( cd .llm-wiki-memory/src && npm test )` is fully green.
- The discipline teaches the nested shape:
  `grep -q "INPUTS ARE ONE NESTED CONTEXT OBJECT" .llm-wiki-memory/src/scripts/lib/discipline.mjs`
  and the rendered `.agents/rules/tool-scopes.md` / `.claude/rules/tool-scopes.md` are present.
- Every tool registers a strict object: `grep -c ".strict()" .llm-wiki-memory/src/mcp-server/tools-*.mjs`
  is non-zero for each tool file.
- Live wire round-trip (after restart):
  - a NESTED write is accepted, e.g.
    `save_to_dataset({ scopes:[<cwd>], write:{ dataset:"knowledge", name:"upgrade-probe.md", text:"# probe\n\nnested wire ok" } })` returns `ok:true`;
  - a FLAT write is refused, e.g.
    `save_to_dataset({ scopes:[<cwd>], dataset:"knowledge", name:"flat.md", text:"# x\n\ny" })` returns an error (unknown keys `dataset`/`name`/`text` at top level).
- The project repo (`git status` at the workspace root) gained no commits or staged changes
  from the memory system.

When all of the above hold, the upgrade is complete. Do NOT auto-commit / push / open a PR.
Surface the change set to the user and let them gate the writes.

--- END PROMPT ---

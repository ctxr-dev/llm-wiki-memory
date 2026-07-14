# llm-wiki-memory: the write `target` is now REQUIRED + explicit (no brain default) (2026-07-14)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past the
**2026-07-14** release. Apply the 2026-07-13 releases (v1 nested wire, v2 identity,
v3 reference-only install) first if you have not.

**WHO IS AFFECTED — every MCP caller (the assistant), and any client that sent write
tool calls without a `target`.** This release makes the write/mutate `target` a
REQUIRED, explicit selector:

- **(breaking) `target` is required on every write and mutate** (`save_to_dataset`,
  `save_lesson`, `write_memory`, `disable_document`, `enable_document`,
  `delete_document`, `move_document`). Previously an omitted `target` silently defaulted
  to your brain (private memory). Now an omitted `target` is REJECTED at the wire. Pass
  the literal `"brain"` for private memory, or a shared repo's wiki root / mount directory
  to write there. This removes the implicit default so the destination is deterministic —
  which matters when two identical clones of one repo are in scope (they share a project
  identity and differ only by path, so only an explicit `target` can pick one).
- **(additive) `get_memory_config` now returns a `levels` array** — every level in your
  resolved scope chain as `{root, mountDir, projectModule, ownership, depth}` — so you can
  choose an explicit `target` by path, including between two same-identity siblings.
- **Consolidate is unchanged** (`consolidate_memory` stays brain-locked; its `target` is
  still optional).

No wiki DATA migration. This is purely an input-contract change (engine code + the
discipline the server teaches at connect); no on-disk artefact changes.

## How to use this file

In a Claude Code (or any capable agent) session inside the target repo, do either:

- **Reference it:** "Fetch and follow the runbook at
  `https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/docs/releases/2026/07/14/update-prompt.md`,
  applying it to this project."
- **Paste it:** copy everything inside the `--- PROMPT ---` fence below.

If you want it run unattended, add: "I am AFK; go to the end without interruptions, take
the safe default for each decision, and surface anything that blocks instead of stalling."

--- PROMPT ---

Update this project's vendored llm-wiki-memory runtime to the latest upstream. Work
autonomously; only stop for the genuine decisions listed at the end.

WHAT'S NEW UPSTREAM (why this matters):

The 2026-07-14 release makes the write/mutate `target` REQUIRED and explicit — there is
no implicit brain default any more. An omitted `target` on save_to_dataset / save_lesson /
write_memory / disable_document / enable_document / delete_document / move_document is
rejected by the tool's input schema. To write to private memory, pass `target: "brain"`;
to write to a shared repo, pass that repo's wiki root or mount directory. The available
targets are the new `levels` array returned by get_memory_config. This makes every write's
destination deterministic (important when two identical clones of one repo are both in
scope). consolidate_memory is unchanged (brain-locked, optional target).

PROCEDURE:

1. Update the runtime.
   ```
   git -C .llm-wiki-memory/src fetch origin
   git -C .llm-wiki-memory/src merge --ff-only origin/main
   ( cd .llm-wiki-memory/src && npm install --no-audit --no-fund ) ; echo "npm install exit=$?"
   ```
   Clean fast-forward AND `npm install exit=0`. Mode-only (`100755 → 100644`) `--ff-only`
   failures → `git -C .llm-wiki-memory/src config core.fileMode false` + `checkout -- .` +
   retry. A genuine CONTENT divergence → surface it; never force.

2. Re-run the bootstrap (idempotent; re-renders the discipline the server teaches at
   connect + the `tool-scopes` rule so the required-target contract is current).
   ```
   ./.llm-wiki-memory/src/bootstrap.sh
   ```

3. Run the test suite.
   ```
   ( cd .llm-wiki-memory/src && npm test )
   ```
   Expected: all tests pass.

4. RESTART so the new tool schemas are live. The running server still advertises the OLD
   (optional-target) input schema; a restart reloads it. On Claude Code, restart the
   session (or `/mcp` reconnect); other clients re-launch the server. IMPORTANT: until the
   restart, the server still accepts an omitted target (old schema), so verify AFTER
   restarting, not before.

5. Confirm the new contract after restart: from your MCP client, call `get_memory_config`
   and confirm the response has a `levels` array; then confirm a `save_to_dataset` call
   WITHOUT a `target` is rejected, and the SAME call with `target: "brain"` succeeds.

DECISIONS:

- **You (the assistant) now MUST pass `target` on every write/mutate.** SAFE DEFAULT for a
  private note: `target: "brain"`. For a project note: ask the user first, then pass that
  repo's wiki root / mount directory (from `get_memory_config` `levels`). Never omit it.
- **Two identical sibling clones of one repo:** they share a `projectModule` and differ
  only by `root`/`mountDir` in `levels`. Pick the one whose path matches the checkout you
  are working in; if genuinely ambiguous, ask the user which folder. The system will NOT
  guess.
- **A custom caller/script that relied on the omitted-target brain default** will now get a
  rejection. SAFE DEFAULT: add `target: "brain"` to those calls. (Internal engine writers —
  compile/flush/cron/hooks — are unaffected; they never used the MCP target boundary.)

VERIFICATION:

The upgrade is successful if and only if:

- `( cd .llm-wiki-memory/src && npm test )` is fully green.
- After restart, `get_memory_config` returns a `levels` array of
  `{root, mountDir, projectModule, ownership, depth}` entries.
- A write with NO `target` is rejected (an actionable error naming `target`); the same
  write with `target: "brain"` succeeds and lands in the brain.
- `consolidate_memory({ ifDue: true })` still runs without a `target` (unchanged).

--- END PROMPT ---

See `docs/releases/2026/07/13/` for the prior same-week releases this stacks on.

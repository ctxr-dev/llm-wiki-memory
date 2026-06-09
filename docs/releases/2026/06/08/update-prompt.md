# llm-wiki-memory topology-path enforcement + flat-issues re-nest runbook (2026-06-08)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past
the **2026-06-08** release.

**WHO IS AFFECTED — read this first.** This release only changes behaviour for
installs whose `<wiki>/.layout/layout.yaml` declares a **`topology:` block**
(the tracker-issues layout from `examples/layouts/tracker-issues/`). If your
layout is the shipped default (the 5 baseline categories: knowledge /
self_improvement / plans / investigations / daily — no `topology:` block), the
new guards are inert and there is **nothing to migrate**: just do the normal
fetch / merge / npm install / bootstrap and you're done.

**Target of this runbook** (topology-layout installs):

- **Force + validate `path` for topology categories.** A `save_to_dataset` /
  `write_memory` into a category with a `topology:` block now REQUIRES an
  explicit `path`, and the MCP server validates that the path round-trips
  through the topology for the leaf's file_kind. A missing path, or a path that
  doesn't match the topology, is REFUSED (deterministic). Previously a no-path
  write silently landed flat at the category root.
- **`cli.mjs nest` is now topology-aware.** It re-nests flat tracker leaves
  (e.g. `issues/DEV-129957-…​.plan.md`) into the topology tree
  (`issues/<tracker>/<prefix>/<buckets>/<lifecycle>/…`), deriving facets from the
  filename + plan body and failing loud per-file on anything it can't resolve.
- **`nest` no longer overwrites your layout.** It seeds the baseline contract
  only when absent; it will never clobber a customised (topology) layout.

## How to use this file

In a Claude Code (or any capable agent) session inside the target repo, do either:

- **Reference it:** "Fetch and follow the runbook at
  `https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/docs/releases/2026/06/08/update-prompt.md`,
  applying it to this project."
- **Paste it:** copy everything inside the `--- PROMPT ---` fence below.

If you want it run unattended, add: "I am AFK; go to the end without
interruptions, take the safe default for each decision, and surface anything
that blocks instead of stalling."

--- PROMPT ---

Update this project's vendored llm-wiki-memory runtime to the latest upstream.
Work autonomously; only stop for the genuine decisions listed at the end.

WHAT'S NEW UPSTREAM (why this matters):

The 2026-06-08 release closes a hole where a tracker-`issues` write without an
explicit `path` silently landed flat at the category root instead of nesting
under the topology tree. Writes to a topology category now REQUIRE a
layout-matched `path` (deterministically validated), and `cli.mjs nest`
re-nests any already-stranded flat leaves. Default-layout installs (no
`topology:` block) are unaffected.

PROCEDURE:

1. Update the runtime.
   ```
   git -C .llm-wiki-memory/src fetch origin
   git -C .llm-wiki-memory/src merge --ff-only origin/main
   ( cd .llm-wiki-memory/src && npm install --no-audit --no-fund )
   ```
   Must be a clean fast-forward. If not, surface the divergence to the user.

2. Re-run the bootstrap (idempotent — distributes the new `topology-path-routing`
   rule to `.agents/rules`, `.claude/rules`, `.cursor/rules`).
   ```
   ./.llm-wiki-memory/src/bootstrap.sh
   ```

3. Decide whether you have a topology layout.
   ```
   grep -q "topology:" .llm-wiki-memory/wiki/.layout/layout.yaml && echo "TOPOLOGY INSTALL" || echo "DEFAULT INSTALL — skip steps 4-5"
   ```

4. (Topology installs only) Re-nest any flat tracker leaves — dry-run first.
   ```
   node .llm-wiki-memory/src/scripts/cli.mjs nest --dry-run
   ```
   Review the `moves` and `unresolved`. Each move shows `from` (flat root) →
   `to` (topology path). `unresolved` lists any flat leaf whose facets can't be
   derived from its filename (see DECISIONS). When it looks right:
   ```
   node .llm-wiki-memory/src/scripts/cli.mjs nest
   ```
   Expected: JSON with `"mode": "migrate"`, `"moved": <N>`, `"ok": true`,
   `"conflicts": []`, `"unresolved": []`, and `"validate": { "ok": true }`. Each
   relocation is recorded in the wiki git log as `memory(migrate-nest): relocated <N>`.

5. (Topology installs only) Confirm the tree is clean.
   ```
   node .llm-wiki-memory/src/scripts/cli.mjs nest --check
   ```
   Expected: `"ok": true`, `"flatCount": 0`.

6. Run the test suite.
   ```
   ( cd .llm-wiki-memory/src && npm test )
   ```
   Expected: all tests pass.

DECISIONS:

- `git merge --ff-only origin/main` fails (working-tree divergence) → surface;
  do NOT force-merge.
- `nest` reports `unresolved` entries → those flat leaves have a filename that
  is not a parseable tracker key (e.g. not `PREFIX-NUMBER[-slug]`). nest left
  them in place (it never guesses). STOP and surface the list; rename or place
  them by hand.
- `nest` reports `conflicts` → a computed destination is already occupied by a
  different leaf. nest left the source in place. STOP and surface; resolve by
  hand.
- A tool of yours wrote to the `issues` tree without a `path` → it must now
  compute the topology `path` from `.layout/layout.yaml` and pass it (see the
  `topology-path-routing` rule); a no-path issues write is refused.

VERIFICATION:

The upgrade is successful if and only if:

- `( cd .llm-wiki-memory/src && npm test )` is fully green.
- Default install: `grep -c "topology:" .llm-wiki-memory/wiki/.layout/layout.yaml`
  is `0`, and a normal `save_to_dataset(dataset="knowledge", …)` (no path) still
  nests by facet — no behaviour change.
- Topology install: `node .llm-wiki-memory/src/scripts/cli.mjs nest --check`
  returns `"ok": true, "flatCount": 0`; the category root holds only `index.md`
  plus the topology subtree (e.g. `ls .llm-wiki-memory/wiki/issues` → `JIRA`,
  `index.md`); a no-path `save_to_dataset(dataset="issues", …)` is refused with
  a message naming `.layout/layout.yaml`.
- `.agents/rules/topology-path-routing.md` exists (the new discipline rule).
- The project repo (`git status` at the workspace root) gained no commits or
  staged changes from the memory system.

When all of the above hold, the upgrade is complete. Do NOT auto-commit / push /
open a PR — surface the change set to the user and let them gate the writes.

--- END PROMPT ---

# llm-wiki-memory search-excerpting + curated-move + doctor runbook (2026-06-11)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past
the **2026-06-11** release.

**WHO IS AFFECTED — read this first.** This release ships ONE behaviour change
that affects **every** install, plus three additive features. The behaviour
change is at the **MCP tool boundary only**: `search_memory` and `recall_lessons`
now **excerpt oversized hit bodies** in their JSON-RPC responses (a broad query
used to be able to dump 60-80KB into a single tool result). Any MCP client or
script that assumed `records[].content` is ALWAYS the complete leaf body will now
sometimes receive an excerpt with `truncated: true` and a `fullChars` count. The
search **library** (used internally by compile / consolidate / recall) is
unchanged and still returns full bodies — so no internal pipeline is affected.
There is no on-disk migration; agents adapt automatically (read the excerpt, then
`read_document` / pass `fullContent: true` for the whole leaf).

**What shipped:**

- **(breaking, MCP only) Search responses are excerpted.** `search_memory`
  clips each hit body to ~600 chars (recall_lessons ~1500) plus a total-response
  budget, dropping only the lowest-ranked tail bodies while KEEPING every hit's
  name + score + id. Clipped hits carry `truncated: true` + `fullChars`; the
  response carries top-level `truncated: true`. New optional inputs: `maxChars`
  (tune the per-hit width) and `fullContent: true` (opt out entirely).
- **(additive) `move_document` MCP tool + `cli.mjs move-leaf`.** Relocate a leaf
  in the CURATED human zone (a `consolidate: none`, non-facet category)
  preserving its content, embedding, and both index.md files. Facet categories
  (relocate via metadata) and topology categories (relocate via a compiler path)
  are REFUSED — this is layout-derived, not a hardcoded category list.
- **(additive) `cli.mjs doctor`.** Read-only, layout-derived health scan: broken
  index refs (all categories), plus stray / unlisted / orphan leaves for curated
  facet-free categories. Exits 3 on findings. Run it after any suspected
  cloud-sync event.
- **(additive) Two robustness guards.** A separator-only ATX heading
  (`# ===…`) no longer becomes a leaf's title (it falls back to the basename);
  and a new shipped `cloud-sync-safety` rule is rendered into every install.

## How to use this file

In a Claude Code (or any capable agent) session inside the target repo, do either:

- **Reference it:** "Fetch and follow the runbook at
  `https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main/docs/releases/2026/06/11/update-prompt.md`,
  applying it to this project."
- **Paste it:** copy everything inside the `--- PROMPT ---` fence below.

If you want it run unattended, add: "I am AFK; go to the end without
interruptions, take the safe default for each decision, and surface anything
that blocks instead of stalling."

--- PROMPT ---

Update this project's vendored llm-wiki-memory runtime to the latest upstream.
Work autonomously; only stop for the genuine decisions listed at the end.

WHAT'S NEW UPSTREAM (why this matters):

The 2026-06-11 release stops a broad `search_memory` / `recall_lessons` query from
overflowing the MCP response: hit bodies are now excerpted at the tool boundary
(per-hit + total budget), with `fullContent: true` to opt out. It also adds a
`move_document` tool + `move-leaf` CLI for relocating curated leaves, a read-only
`doctor` health scan, a guard so a `# ===` heading can't title a leaf "===", and
a shipped `cloud-sync-safety` rule for installs on Drive/Dropbox/iCloud/OneDrive.
Nothing on disk migrates.

PROCEDURE:

1. Update the runtime.
   ```
   git -C .llm-wiki-memory/src fetch origin
   git -C .llm-wiki-memory/src merge --ff-only origin/main
   ( cd .llm-wiki-memory/src && npm install --no-audit --no-fund )
   ```
   Must be a clean fast-forward. If `--ff-only` fails, see DECISIONS (the
   cloud-sync executable-bit case is common and recoverable).

2. Re-run the bootstrap (idempotent — renders the new `cloud-sync-safety` rule to
   `.agents/rules`, `.claude/rules`, `.cursor/rules`).
   ```
   ./.llm-wiki-memory/src/bootstrap.sh
   ```
   Expected log line: `Rendered shipped process rules to .agents/rules, .claude/rules, and .cursor/rules.`

3. Run the test suite.
   ```
   ( cd .llm-wiki-memory/src && npm test )
   ```
   Expected: all tests pass (includes new suites `search-snippet`,
   `wiki-store-move`, `doctor`, and extended `mcp` / `wiki-store`).

4. Run the new health scan (read-only; safe any time).
   ```
   node .llm-wiki-memory/src/scripts/cli.mjs doctor
   ```
   Expected on a healthy wiki: `"ok": true` and a `summary` of
   `{ brokenRefs: 0, unlisted: 0, strays: 0, orphans: 0 }` (exit 0). A non-zero
   exit (3) with non-empty `brokenRefs` / `strays` means the wiki needs repair —
   see DECISIONS.

DECISIONS:

- `git merge --ff-only origin/main` fails because files changed mode
  `100755 → 100644` → a cloud-sync daemon stripped the executable bit from shell
  scripts. SAFE FIX: `git -C .llm-wiki-memory/src config core.fileMode false`,
  then `git -C .llm-wiki-memory/src checkout -- .`, then retry the merge. Do NOT
  force-merge over a genuine content divergence — if the conflict is in file
  CONTENT (not mode), surface it.
- `git merge --ff-only` fails on genuine local edits to `src/` → surface the
  divergence; do not discard the user's changes.
- `doctor` exits 3 with findings → it is READ-ONLY (it changed nothing). Treat as
  a report: `brokenRefs` = an index.md references a child that doesn't exist;
  `strays` = a leaf with no frontmatter; `orphans` = a leaf not reachable from any
  index. If this followed a suspected cloud-sync scramble, recover from the wiki's
  git history (`git -C <wiki> reset --hard HEAD`) per the `cloud-sync-safety` rule,
  then re-run `doctor`. Otherwise surface the list to the user; do not auto-edit
  leaves.
- An MCP client of yours parsed `search_memory` results assuming full bodies →
  it must now handle `truncated: true` + `fullChars` on a record (fetch the whole
  leaf with `read_document`, or re-issue the query with `fullContent: true`).
  This is the one behaviour change in the release.

VERIFICATION:

The upgrade is successful if and only if:

- `( cd .llm-wiki-memory/src && npm test )` is fully green.
- `node .llm-wiki-memory/src/scripts/cli.mjs doctor` prints `"ok": true` on a
  healthy wiki and exits 0; on a wiki with a deliberately broken index ref it
  exits 3 and lists it under `brokenRefs`.
- The MCP server registers `move_document` (alongside the existing tools), and
  `node .llm-wiki-memory/src/scripts/cli.mjs move-leaf` exists (running it with no
  args prints a usage line and exits 64).
- A broad `search_memory` whose top hit has a large body returns that hit with
  `truncated: true` and `fullChars > content.length`; the same query with
  `fullContent: true` returns the full body and no `truncated` flag.
- `.agents/rules/cloud-sync-safety.md` exists (the new shipped rule).
- The project repo (`git status` at the workspace root) gained no commits or
  staged changes from the memory system.

When all of the above hold, the upgrade is complete. Do NOT auto-commit / push /
open a PR — surface the change set to the user and let them gate the writes.

--- END PROMPT ---

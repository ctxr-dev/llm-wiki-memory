---
name: current-work-context
description: Before answering "what should I look at next", "what was I doing", "where did we leave off", or any open-ended ask at the start of a session, or when the user switches git branch mid-session, fetch the active work context from the local LLM wiki via the MCP tools — derive the active branch + cwd, semantic-search the wiki, surface in-progress plans and recent investigations relevant to the branch. Tracker-agnostic (Jira / Linear / GitHub / no-tracker) — driven by semantic match against the branch text, not regex-extracted issue keys.
---

# Current-work context

The local LLM wiki accumulates per-issue knowledge files, in-progress plans
(with checkbox state), investigations, and daily atoms across every
session. At the start of a new session, **or when the user switches
branches mid-session**, your job is to surface the slice of that wiki
that's relevant to what the user is about to work on — so they never have
to re-explain "I'm continuing DEV-129957 on the Hermes timeout".

This skill is intentionally tracker-agnostic. The wiki may use the
`tracker-issues` topology (Jira / Linear / GitHub / etc.) or just the
default categories — either way the lookup is the same: **semantic
match against the active branch's name**.

## When to invoke

Run this skill (no special syntax — just follow the steps below before
responding):

- **Session start.** The user's first message in a new session, unless
  it's a completely fresh task with no context implication
  ("what's 2+2", "write a sonnet about cats", etc.).
- **"What should I look at?" / "Where were we?" / "What was I doing?"**
  Any open-ended ask about the current state of work.
- **Branch change mid-session.** If the user mentions switching branches,
  or you see file edits in a new repo, re-run the skill — the context
  has changed.
- **Before suggesting next steps.** If you're about to recommend an
  action and you don't already have wiki context loaded, fetch it.

Do NOT invoke when:

- The user gives an explicit task that's self-contained ("rename
  function X in file Y") — just do the task.
- The wiki is not initialised in this workspace (no
  `<workspace>/.llm-wiki-memory/wiki/layout/layout.yaml`).
- You've already fetched context in this turn and the branch hasn't
  changed.

## Steps

1. **Detect cwd + branch.** Use Bash:
   ```
   pwd
   git -C "$(pwd)" rev-parse --abbrev-ref HEAD 2>/dev/null || true
   git -C "$(pwd)" remote get-url origin 2>/dev/null || true
   ```
   `process.env.CLAUDE_PROJECT_DIR` and similar provider-specific
   variables are NOT reliable — llm-wiki-memory is provider-agnostic.
   `pwd` + git introspection are universal.

2. **Build the semantic query.** Use the branch name verbatim as the
   query — do NOT regex-extract issue keys. Xenova (the wiki's embedder)
   matches branch words against indexed wiki content; this works for
   `feature/DEV-129957-investigate-timeout` (Jira), `fix-hermes-timeout`
   (no tracker), `eng/eng-1234-cassandra-config` (Linear) — uniformly.

   If the branch is `main` / `master` / `develop`, fall back to the cwd's
   basename as the query, or skip if both are uninformative.

3. **Search the wiki.** Use the `search_memory` MCP tool:
   ```json
   { "query": "<branch text or basename>", "maxResults": 8 }
   ```
   Top-K hits (with cosine scores) are your candidate context. If no
   hits return, gracefully report "no recent wiki context for this
   branch" and stop — don't fabricate.

4. **Pull in-progress plans for the active issue (if any).** If any of
   the top hits live under `issues/<TRACKER>/<PREFIX>/<k>/<h>/<u>/`,
   look in the sibling `in-progress/` folder for `.plan.md` files and
   read them. Their `progress` and `status` frontmatter tell you where
   the work stands; their checkboxes tell you what's next.

5. **Optional: recent daily atoms.** List the 3 most recent files under
   `wiki/daily/<yyyy>/<mm>/<dd>/` for cross-session continuity. Skim,
   don't deep-read.

6. **Summarise for the user.** Compose a short markdown block (≤ 200
   words) covering:
   - Active issue / topic (one line)
   - In-progress plan progress (e.g. "4/12 done", last blocker)
   - 1-2 most-relevant wiki leaves with their paths
   - One concrete suggested next action

   Then answer the user's actual question, using that context.

## Output shape

```markdown
## Recent context

**Active**: <issue or topic> — derived from `<branch>` (cwd `<repo>`).

**Wiki hits** (top by cosine):
- `<path/to/leaf.md>` — <one-line focus>
- `<path/to/another.md>` — <one-line focus>

**In-progress plans**:
- `<plan-file>` — <done>/<total> checkboxes, last blocker: <reason tag>

**Suggested next**: <one concrete action>

---

<your actual answer to the user's question>
```

## Tracker-agnostic by construction

This skill never hardcodes a tracker prefix or path shape. The
`tracker-issues` topology (if installed) computes paths from facets at
write time; `search_memory` ranks by semantic content; we read whatever
top hits come back. New trackers (Linear, GitHub, …) work automatically
once their leaves are in the wiki — no skill update required.

## Reference

- MCP tools: `search_memory`, `recall_lessons`, `list_datasets`,
  `get_memory_config`
- Wiki layout: `<workspace>/.llm-wiki-memory/wiki/layout/layout.yaml`
- Topology helpers (if you need to compute paths programmatically):
  `import { loadTopology, pathFor } from "llm-wiki-memory/topology-runtime"`
- Companion skills:
  [`self-improvement`](./self-improvement.md) (memory routing rules),
  [`plan-capture`](./plan-capture.md) (writing plans),
  [`investigation-capture`](./investigation-capture.md) (writing investigations)

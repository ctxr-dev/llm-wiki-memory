# AI install / update prompt (canonical)

This file is the canonical procedure an AI coding agent follows to install or
update llm-wiki-memory in a project. Humans: the README's Install section has
the manual commands; this file is what the one-liner there points your agent
at. One prompt covers both a fresh install and an update of an existing one.

---

Install or update llm-wiki-memory (local LLM-wiki memory: capture/compile/recall
hooks, an hourly refinement cron, a local stdio MCP server; local embeddings,
no Docker) in this project. Follow these steps EXACTLY; do not improvise.

1. Check whether `./.llm-wiki-memory/src` exists in this project.

2. **It does NOT exist → fresh install.** Run
   `git clone https://github.com/ctxr-dev/llm-wiki-memory ./.llm-wiki-memory/src`
   then `./.llm-wiki-memory/src/bootstrap.sh` (idempotent). When it finishes: if
   the user is on Claude Code, tell them to restart the session; otherwise show
   them `./.llm-wiki-memory/src/scripts/mcp-config.sh <their-client>` so they
   can register the MCP server. Done — skip step 3.

3. **It DOES exist → update.** Releases may contain BREAKING changes; each
   ships a runbook at `docs/releases/<yyyy>/<mm>/<dd>[/vN]/update-prompt.md`.
   Never just pull and re-run bootstrap blindly. Procedure:
   1. Print the current local state — this is the last applied update:
      `git -C .llm-wiki-memory/src log -1 --format='%h %cI'`
   2. `git -C .llm-wiki-memory/src fetch origin`
   3. List exactly the runbooks NOT yet applied locally (released after the
      local state):
      `git -C .llm-wiki-memory/src diff --name-only HEAD origin/main -- docs/releases | grep 'update-prompt\.md$' | sort`
      Apply order = this sorted list: dates ascend, and within one day the bare
      folder comes before `v2`, `v3`, … (numeric `vN` order).
   4. Read EVERY listed runbook, oldest first, from the fetched ref (do NOT
      merge yet): `git -C .llm-wiki-memory/src show origin/main:<path>`
   5. Build ONE short consolidated update plan from all of them in that order:
      a later runbook supersedes an earlier one where they touch the same file
      or setting; keep every DECISIONS fork and every VERIFICATION block. Show
      the user the plan as a few bullets before executing.
   6. Execute the plan:
      `git -C .llm-wiki-memory/src merge --ff-only origin/main` — if it is not
      a clean fast-forward, STOP and show the user the divergence (never
      force); `( cd .llm-wiki-memory/src && npm install --no-audit --no-fund )`;
      then the consolidated runbook steps — typically a re-run of
      `./.llm-wiki-memory/src/bootstrap.sh` (idempotent) plus any one-shot
      migration commands the runbooks name.
   7. Verify with EVERY runbook's VERIFICATION block, oldest first; finish with
      `node .llm-wiki-memory/src/scripts/cli.mjs cron-health` reporting
      `healthy:true`. (On a box where daily docs are pending but NO LLM
      provider CLI is reachable, `healthy:false` with a
      `system:compile-llm-providers` escalation is the EXPECTED honest signal,
      not an install failure — fix provider availability, then re-check.)
   8. If step 3.3 lists nothing but HEAD differs from `origin/main`, it is a
      non-breaking update: ff-merge, npm install, re-run bootstrap, check
      cron-health. If HEAD already equals `origin/main`, say "already up to
      date" and stop.

4. **Offer self-observability (opt-in — ask once).** After bootstrap finishes,
   check whether `.llm-wiki-memory/settings/self-observability.enabled` exists.
   - If it does NOT, ASK the user once: "Enable llm-wiki-memory
     self-observability? The agent will watch the memory system while you work,
     record redacted anomaly captures under `.llm-wiki-memory/monitoring/`, and
     offer to plan engine fixes at session-end. Opt-in; default off." If they
     say yes, run `./.llm-wiki-memory/src/bootstrap.sh --enable-self-observability`
     (it references the `self-observability` rule into `.agents/rules`,
     `.claude/rules`, `.cursor/rules` and records consent in that sentinel). If
     they decline, do nothing.
   - If the sentinel ALREADY exists, consent was given previously — do NOT
     re-ask; the flag-less bootstrap re-run above already preserved it.

5. Never run `git add -A`, never commit or push anything; show the user the
   resulting change set and let them gate the git writes.

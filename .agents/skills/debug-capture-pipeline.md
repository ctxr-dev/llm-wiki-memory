# Skill: debug the capture pipeline (flush → daily → compile → recall)

Where to look, in order, when memory "didn't capture" or "doesn't recall". Paths are
relative to the install's data dir (`<workspace>/.llm-wiki-memory/`); commands run from
`src/`.

1. **Breadcrumbs first:** `state/.flush.log`. Every hook fire logs
   `hook <event>: spawned worker (pid …, session …, N turns)` then
   `worker <event> …: wrote N atom(s) → daily/….md` (or an explicit skip reason). Cron
   history: `state/.consolidate-attempts.log`; quick status:
   `node scripts/cli.mjs cron-health` — read the `summary` line first, pull the full
   `lastAttempt` only when actually digging.
2. **"No daily leaf for that day" is usually NOT a failure.** One session ID can span
   several calendar days (PreCompact re-opens included), and the daily memo files under
   the date SessionEnd actually fired. Check the session id in `.flush.log` before
   concluding a hook broke. Flush also skips sessions below `hook.sessionEndMinTurns`
   (settings.yaml).
3. **"Saved but recall can't find it":** daily leaves are NOT in the recall corpus.
   Compile promotes atoms into `knowledge/` and `self_improvement/` (next SessionStart in
   background, or the daily cron) and archives the sources (supersede-on-promote). Force
   it now: `node scripts/cli.mjs compile`.
4. **Distillation failed:** the full body is preserved at `state/failed-distill-*.json`
   with a structured audit (`chunks_total`, `failed_chunks`, `provider_chain_tried`).
   Recover with `node scripts/cli.mjs redistill --leaf <path> | --session <id> | --all`.
   Older leaves without a stash recover from their in-leaf `UNTRUSTED MEMORY BODY` block
   (same command, `--leaf`).
5. **Embedding staleness:** one vector per leaf cached in `index/embeddings.json`, keyed
   by content hash + model; a model change invalidates and recomputes lazily. Orphans are
   swept by `node scripts/cli.mjs gc-embeddings --if-due` (`state/.embed-gc.json` stamps
   the last run).
6. **Hook wiring:** hooks live in the workspace `.claude/settings.json`, merged by
   bootstrap via `merge-config.mjs`. If every session errors on a missing hook script, a
   tooling dir was deleted while settings still referenced it — strip those hook entries
   per workspace BEFORE deleting such dirs. On macOS, a launchd plist install failing with
   permission errors usually means `~/Library/LaunchAgents` has wrong ownership — an
   environment issue, not a bootstrap bug; fix ownership, then `cp` + `launchctl load`
   manually.

# Release runbooks (docs/releases) — authoring rules

This rule governs **developing llm-wiki-memory itself**. (`templates/rules/releases-docs.md`
is the consumer-side rule that bootstrap renders into installs; do not confuse the two.)

## When a runbook is mandatory

A change is breaking — and MUST ship a runbook in the same PR — if ANY of:

- An env var, config key, file path, or CLI flag that used to work silently stops working.
- The shape of an on-disk artifact (settings file, leaf frontmatter, stash, MCP tool
  response) changes in a way older parsers wouldn't understand.
- A renamed function, file, or module disappears from the public surface (anything
  importable from outside this package, or consumed by hooks / cron / MCP clients).
- A default value flips and the new default behaves materially differently for existing
  installs.
- A new mandatory installation step appears (dependency, credential, bootstrap argument).

If unsure: write the runbook. An unnecessary runbook costs minutes; a missing one strands
every existing install.

## Path & same-day stacking

`docs/releases/yyyy/mm/dd/update-prompt.md` (UTC date). A second release the same day goes
to `/v2`, the third to `/v3`, … The filename is ALWAYS `update-prompt.md`. Never change a
shipped runbook's semantics after release — fix forward with a new runbook (typo-only
fixes are fine).

## Runbooks are applied CUMULATIVELY

The README update prompt computes the unapplied set via
`git diff --name-only HEAD origin/main -- docs/releases` and applies them oldest → newest.
Therefore every runbook must:

- Assume the reader may be SEVERAL releases behind, not exactly one.
- Be self-contained — no "see the previous runbook" without its full path.
- Make every step idempotent or guarded, and describe what the already-applied state looks
  like (so a re-run or an overlapping later runbook is harmless).

## Mandatory structure (in this order)

1. Title + one-paragraph **WHAT'S NEW** naming the breaking change and why it shipped.
2. **How to use this file** — reference-or-paste instructions + the unattended/AFK line.
3. `--- PROMPT ---` fence opening the paste-ready agent prompt.
4. **PROCEDURE** — numbered, exact commands in code fences, runnable from the consumer
   **project root** (not from `src/`). Always includes: the
   `fetch` / `merge --ff-only` / `npm install` triplet; the idempotent `bootstrap.sh`
   re-run; every one-shot migration command; the expected log line after each mutating step.
5. **DECISIONS** — every fork the agent can hit, each with its safe default; genuine
   blockers say STOP and what to surface to the user.
6. **VERIFICATION** — concrete success criteria: files that must exist, keys/env vars that
   must NOT exist, exact breadcrumb log lines, commands with their expected output. "All
   tests pass" alone is not enough.
7. `--- END PROMPT ---`.

## Concreteness rules (each violation fails review)

- **Every quoted log string is grep-verified against the code at authoring time.** Cite
  only real strings, with their bracket/prefix form exact. (2026-06-03 incident: a
  DECISIONS stop-fork keyed on `migrate-settings: could not write settings.yaml`, a string
  emitted nowhere — the guard was unfollowable.)
- **If a stop-signal depends on an exit code, read the calling script and confirm nothing
  swallows it.** (`bootstrap.sh` had `|| true` around the migrator, making the same fork
  unreachable on the documented path.)
- Counts and shapes are checked against `templates/` at authoring time (e.g. settings.yaml
  top-level keys) — or phrased count-free ("the documented top-level keys") so they don't
  rot.
- Commands are copy-paste runnable with full relative paths from the project root.
- Each verification step states its exact expected output.
- Short and executable: if a step needs more than a short paragraph of explanation, write a
  migrator script and have the runbook call it instead.
- No secrets — not even realistic-looking placeholders.

## Release process (paired repos)

- `skill-llm-wiki` (npm `@ctxr/skill-llm-wiki`) provides the hosted-wiki layout contract;
  llm-wiki-memory consumes it. Cross-repo releases are ORDERED: publish the skill FIRST,
  then flip this repo's dependency from any local `file:` path to the published `^x.y.z`,
  regenerate the lockfile cleanly, and run unit + e2e against the PUBLISHED tarball — a
  `file:` path does not resolve off the dev machine, and tests must prove the artifact
  consumers actually download.
- Releases ship via release PRs (`release: vX.Y.Z`); a breaking release carries its
  runbook in the same PR.
- `<workspace>/.llm-wiki-memory/wiki` is the USER'S private memory data: its git repo has
  NO remote by design. Never add one, never push it, never reference it in a release.
  The only pushable repo is `src/`.

## Ship it

The release commit references the runbook in its footer
(`See docs/releases/yyyy/mm/dd[/vN]/update-prompt.md for upgrade.`) and the PR body carries
the `https://raw.githubusercontent.com/<org>/<repo>/main/docs/releases/...` URL so agents
can fetch it without cloning. A breaking PR without a runbook fails review on this rule
alone.

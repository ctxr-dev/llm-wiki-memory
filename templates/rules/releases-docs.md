---
name: releases-docs
description: Every BREAKING release of llm-wiki-memory (or any project using this rule) MUST ship a runbook at docs/releases/yyyy/mm/dd[/vN]/update-prompt.md. Shipped rule — bootstrap renders it to .agents/rules/, .claude/rules/, and .cursor/rules/.
---

# Release docs discipline

Every BREAKING change in this project — or in any project that consumes this rule — must come with a paste-ready upgrade runbook at:

```
docs/releases/yyyy/mm/dd[/vN]/update-prompt.md
```

Same-day releases stack via the `/vN` slot (`v2`, `v3`, …). The `update-prompt.md` filename is uniform across all releases.

## What counts as "breaking"

A change is breaking if **any** of the following are true:

- An env var, config key, file path, or CLI flag that USED TO WORK silently stops working.
- The shape of an on-disk artefact (settings file, daily leaf frontmatter, MCP tool response) changes in a way that older parsers wouldn't understand.
- A renamed function, file, or module disappears from the public surface (anything importable from outside this package, or anything consumed by hooks / cron / MCP clients).
- A default value flips (e.g. `intervalDays: 1 → 0`), and the new default produces materially different behaviour for existing users.
- A new mandatory installation step (a new dependency, a new credential, a new bootstrap argument) is introduced.

If you are NOT sure: write the runbook. Operators reading the diff months later thank a runbook they didn't strictly need; they curse the absence of one they did.

## Runbook structure

A runbook is a paste-ready prompt for an AI agent (or a human operator) to follow. It MUST cover:

1. **WHAT'S NEW** — one paragraph naming the breaking change and why it shipped.
2. **PROCEDURE** — ordered steps the agent follows to bring an existing install onto the new version. Always includes:
   - the `git fetch` / `merge --ff-only` / `npm install` triplet against the runtime clone;
   - the bootstrap re-run (idempotent — must handle the "already migrated" case);
   - any one-shot data-migration command;
   - a verification block (run tests, run `cli.mjs where` / `cron-health`, look at expected file shapes).
3. **DECISIONS** — explicit forks the agent might encounter and the safe-default answer for each. If the agent is genuinely blocked, it stops here and surfaces the unknown to the user.
4. **VERIFICATION** — concrete success criteria. "All tests pass" is not enough; name the files that should exist, the env vars that should NOT, the breadcrumb log lines that should appear.

Mirror the shape of any existing runbook in `docs/releases/` to keep style consistent.

## Surface the runbook in the release commit

The commit that ships the breaking change must reference its runbook in either:
- the commit message footer (`See docs/releases/yyyy/mm/dd/update-prompt.md for upgrade.`), OR
- the PR description.

Either way the URL should be `https://raw.githubusercontent.com/<org>/<repo>/main/docs/releases/yyyy/mm/dd[/vN]/update-prompt.md` so an agent or operator can fetch it without cloning.

## When to invoke the runbook

The discipline applies in BOTH directions:

- **Authors** of a breaking change write the runbook in the same PR that ships the change.
- **AI agents performing maintenance** (cron-job session-start, manual `bootstrap.sh` re-run, anything that reads upstream and applies it to an existing install) check `docs/releases/` for a newer `update-prompt.md` than the install's last-applied marker and follow it if found.

This rule is **mandatory** for every breaking change. A breaking PR without an `update-prompt.md` fails review on this rule alone.

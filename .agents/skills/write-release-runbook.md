# Skill: write a release runbook (docs/releases)

Use when shipping a breaking change (criteria in `rules/releases-docs-authoring.md`).
Output: a paste-ready `update-prompt.md` an agent can execute with zero context about this
repo.

1. Compute the slot: `date -u +%Y/%m/%d`. If `docs/releases/<that date>/update-prompt.md`
   already exists, take the next free `/vN` (`v2`, `v3`, … — numeric order).
2. Start from the newest existing runbook as the structural template:
   `find docs/releases -name update-prompt.md | sort | tail -1`. Keep the section order:
   WHAT'S NEW → How to use this file → `--- PROMPT ---` → PROCEDURE → DECISIONS →
   VERIFICATION → `--- END PROMPT ---`.
3. Write PROCEDURE as numbered copy-paste commands runnable from the consumer **project
   root**. Always include: the `fetch` / `merge --ff-only` / `npm install` triplet; the
   idempotent `bootstrap.sh` re-run; every one-shot migration command; the expected log
   line after each mutating step.
4. Verify every claim against the code — mandatory, failing review otherwise:
   - grep each quoted log string:
     `grep -rn "<string>" scripts/ mcp-server/ bootstrap.sh` — only real strings ship,
     in their exact bracket/prefix form.
   - For every exit-code-based stop signal, read the calling script and confirm nothing
     swallows it (`|| true`, `set +e`).
   - Check counts/shapes against `templates/` (e.g. settings.yaml top-level keys), or
     phrase them count-free so they don't rot.
5. Write DECISIONS: enumerate every fork an agent can hit; give each a safe default;
   genuine blockers say STOP plus exactly what to surface to the user.
6. Write VERIFICATION: named files that must exist / must NOT exist, exact log lines,
   commands with expected output — ending with
   `node .llm-wiki-memory/src/scripts/cli.mjs cron-health` → `healthy:true` and
   `( cd .llm-wiki-memory/src && npm test )` green.
7. Cold-read the finished prompt as an agent with no context: every step must be executable
   verbatim. Anything that needs tribal knowledge gets rewritten or scripted.
8. Reference the runbook in the release commit footer
   (`See docs/releases/.../update-prompt.md for upgrade.`) and put the
   `raw.githubusercontent.com` URL in the PR body. Hand the commit off to the user — never
   commit/push yourself.

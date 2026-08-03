# Skill: triage review findings without acting on false positives

Full criteria for the guard-deletion case below: `.agents/rules/defensive-invariants.md`.

Review output is INPUT, not truth. A 3-reviewer parallel pass over an embedding-stack
change produced 12 findings, and the self-rated confidence labels did not predict which
were real: a `speculative` finding (a missing `dispose()` on a rebuilt native session) was
real and worth fixing, while a `certain` one with a flawless derivation argued a defensive
check was unreachable and safe to delete — the "impossible" event then occurred in
production. Commands run from `src/`.

1. Read the finding. Do NOT edit anything yet.
2. Classify what it actually carries:
   - **ARGUMENT** — a derivation over modelled states. Weakest: the model may not be the
     code.
   - **OBSERVATION** — it read the code and cites real files and identifiers.
   - **EVIDENCE** — a measurement, probe, or failing test (e.g. a probe showing a
     5000-entry cache reduced to 32 entries after one call). Only these earned action.

   Escalate the bar with the cost of the fix. Two reviewers independently reporting the
   same defect raises confidence materially; a confidence label does not.
3. Verify against the CODE yourself, starting with the finding's own file and identifier
   claims — open the file, grep the symbol. A finding that misnames an identifier has not
   read what it claims to have read; treat the rest of it as unverified too.
4. For anything touching a durable artifact (wiki leaves, embedding caches,
   `state/*.json`), demand evidence, not derivation. Write the failing test FIRST and
   watch it go red: `node --import ./test/setup-guard.mjs --test test/<file>.test.mjs`.
   Then fix, and watch it go green. If you cannot make it fail, you have not understood
   it — either the finding is wrong or your reproduction is. Do not fix on faith.
5. Reject unsound findings EXPLICITLY and say why. "A reviewer said so" is not a reason to
   change code; neither is a confidence label.
6. After each fix, re-run the FULL chain: `npm run gates`. A fix derived from one finding
   routinely breaks assumptions elsewhere — one applied from an argument alone broke six
   existing tests whose assumptions the finding had not accounted for.
7. Never:
   - batch-apply findings — one finding, one test, one diff;
   - let a fix and a refactor share a diff; the "no behaviour change" claim then becomes
     unverifiable and neither half can be reviewed;
   - re-run the reviewers to break a tie. Reproduce it instead.

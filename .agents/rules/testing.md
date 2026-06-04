# Testing rules (developing llm-wiki-memory)

- Framework: `node:test` + `node:assert/strict`. Per-file temp workspaces come from
  `test/harness.mjs` (`setupWorkspace`/`cleanup`); the harness sets
  `MEMORY_EMBED_BACKEND=lexical` so no ~340MB embedding model is loaded — keep new tests on
  that path.
- LLM mocking: the ONLY sanctioned style is the mock-provider seam —
  `MEMORY_LLM_PROVIDER=mock`, `MEMORY_LLM_MOCK_RESPONSE`, `MEMORY_LLM_MOCK_FAIL_INDICES`
  (+ `llm.__resetMockCallIndex()` to neutralise counter drift between tests). Settings are
  overridden via `__setSettingsOverride` / `withSettingsOverride`. Never invent a one-off
  mocking style for a single test.
- **Before swapping a low-level primitive** (e.g. `fs.writeSync` → `fs.writeFileSync`),
  grep the tests for what they mock or inject on. A primitive swap silently disarms the
  injection: the test fails — or worse, passes vacuously. (Cost us a suite failure on
  2026-06-04: the mid-write-failure test patches `fs.writeSync`.)
- When unit-testing `redact()`, isolate the rule under test: a generic key/value rule can
  legitimately preempt a specific one (a leading "token " word routes a JWT to the generic
  rule's sentinel). A different sentinel is rule ORDERING, not a coverage gap — craft
  inputs that fire the intended rule, and don't "fix" the order to satisfy a sloppy input.
- **/tmp leak trap:** killed or crashed runs strand `/tmp/lwm-*` workspaces (their
  `after()` cleanup never fires); repeated full-suite runs have filled the disk to ENOSPC.
  Sweep `rm -rf /tmp/lwm-*` before a full run; iterate on SINGLE files
  (`node --test test/<file>.test.mjs`); never loop `npm test`. On ENOSPC, free `/tmp`
  first — the failing write path is usually a red herring.
- `node --check <file>` parse-validates without executing (creates no workspace) — use it
  as a cheap syntax gate before running anything.
- Every change ships tests: happy path, failure paths, edge cases (empty/missing input,
  malformed file, boundary values, concurrency where real). Assertions must be
  falsifiable — a test that cannot fail when its target bug regresses is noise. Never
  assert on the mock itself.
- Tests follow their code: engine behaviour is tested HERE; `@ctxr/skill-llm-wiki`
  behaviour is tested in that repo. Do not co-locate cross-repo tests.

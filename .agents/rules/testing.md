# Testing rules (developing llm-wiki-memory)

- Framework: `node:test` + `node:assert/strict`. Per-file temp workspaces come from
  `test/harness.mjs` (`setupWorkspace`/`cleanup`); the harness writes an
  `embed:\n  backend: lexical` `settings/settings.yaml` into each temp workspace so no
  ~340MB embedding model is loaded — keep new tests on that path. The env var
  `MEMORY_EMBED_BACKEND` is RETIRED (migrated to `embed.backend`; see
  `scripts/migrate-settings-constants.mjs`) and is read by nothing — the copies still set
  by some test files are vestigial and guarantee nothing. Never add a new one, and DELETE any
  you touch — the outstanding sweep is tracked in `.agents/rules/verification-completeness.md`.
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
- **/tmp leak trap** (procedure: `.agents/skills/run-tests-safely.md`): killed or crashed
  runs strand `/tmp/lwm-*` workspaces (their
  `after()` cleanup never fires); repeated full-suite runs have filled the disk to ENOSPC.
  Sweep `rm -rf /tmp/lwm-*` before a full run; iterate on SINGLE files
  (`node --import ./test/setup-guard.mjs --test test/<file>.test.mjs`); never loop
  `npm test`. On ENOSPC, free `/tmp` first — the failing write path is usually a red
  herring.
- **Always keep the `--import ./test/setup-guard.mjs` preload**, exactly as the npm scripts
  wire it. That preload is what redirects `MEMORY_DATA_DIR` away from the developer's REAL
  brain and arms `LWM_FORBID_REAL_BRAIN`, so `env.mjs` THROWS if anything still resolves
  there. A bare `node --test test/<file>.test.mjs` skips the preload, and running unguarded
  against real data is how a past incident hard-deleted ~590 real leaves.
- A SECOND signal backs the preload up: `env.mjs` also refuses the real brain whenever
  `NODE_TEST_CONTEXT` is set, which the node:test runner sets on every spawned test child.
  That narrows the hole but does NOT close it — the marker is absent under
  `--experimental-test-isolation=none` and when a test file runs as a plain script — so the
  preload stays the primary signal, not an optional extra.
- `node --check <file>` parse-validates without executing (creates no workspace) — use it
  as a cheap syntax gate before running anything.
- Every change ships tests: happy path, failure paths, edge cases (empty/missing input,
  malformed file, boundary values, concurrency where real). Assertions must be
  falsifiable — a test that cannot fail when its target bug regresses is noise. Never
  assert on the mock itself.
- Tests follow their code: engine behaviour is tested HERE; `@ctxr/skill-llm-wiki`
  behaviour is tested in that repo. Do not co-locate cross-repo tests.

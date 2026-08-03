# Verification completeness

What "verified" and "green" are allowed to mean in this repo. Every clause exists because a
check passed without exercising the thing it claimed to cover, or a partial run was reported
as a complete one. Complements `.agents/rules/testing.md` (frameworks, mocking seams, the
/tmp trap): that rule governs how a test is written, this one governs when you may call the
result verification.

## "Green" means the full chain on the full surface

- The only sanctioned claim of green is a clean `npm run gates`. It chains, in order:
  `typecheck` (tsc) → `npx eslint . --max-warnings 0` → `format:check` (prettier) →
  `deadcode` (knip) → `check:size` → `check:comments` → `test` → `test:e2e`. Anything outside
  that chain — `test:llm-live`, the webapp Playwright run — is NOT covered by it and must be
  named separately when it matters.
- Scoping a linter to a subtree hides every finding outside it. `npx eslint scripts/` stayed
  green for hours over an unused-variable warning in `test/`; only the full `.` run surfaced
  it. Two independent traps in one incident: the path scope, and SEVERITY — `no-unused-vars`
  is configured `warn`, so `npm run lint` exits 0 on it and only the gates' `--max-warnings 0`
  fails. Never substitute `npm run lint` for the gate.
- `check:size` and `check:comments` are whole-tree scans (`scripts`, `mcp-server`,
  `src/webapp`; plus `test` for comments). They have a verdict only over their whole glob, so
  running them "on your change" is meaningless. `check:size` fails the build for any
  `.mjs`/`.ts`/`.tsx` over 300 lines anywhere in that tree — including a file your change
  merely pushed over the line.
- `npm test` globs `test/*.test.mjs` only; the e2e suite under `test/e2e/` runs in the separate
  `test:e2e` step. "All tests pass" without both is a partial claim.
- Partial runs are for ITERATION SPEED, never for reporting. Iterate on single files, escalate
  to the full chain before calling anything done, and state which one you actually ran.

## Cheapest sufficient check while iterating

- `node --check <file>` parse-validates without executing and creates no workspace — the first
  gate after any edit.
- Then the one relevant test file, then the full chain. Skipping an intermediate rung only
  wastes time; skipping the LAST one is the false confidence this rule exists to stop.

## Test isolation is armed only through the npm scripts

- `test/setup-guard.mjs` is the `--import` preload that redirects `MEMORY_DATA_DIR` away from
  the developer's real brain and arms `LWM_FORBID_REAL_BRAIN`, so `env.mjs` throws if any
  module (or a child spawned with the inherited env) still resolves there. It is wired into
  `test`, `test:e2e`, and `test:llm-live` — nowhere else.
- `node --test test/foo.test.mjs` SKIPS the preload. `env.mjs` still refuses the real brain via
  the runner's own `NODE_TEST_CONTEXT` marker, but that backstop is absent in some runner modes,
  so it is not a licence to omit the preload. The
  correct single-file invocation is
  `node --import ./test/setup-guard.mjs --test test/<file>.test.mjs`.

## Falsifiability — did you watch it fail?

- Every test must be falsifiable against the bug it targets. Before claiming coverage, answer
  concretely: would this assertion fail if the bug came back, and was it seen RED before the
  fix? An assertion that cannot fail is noise dressed as a safety net.
- **Characterization tests must pass against the UNMODIFIED code first.** When refactoring, a
  test written to pin CURRENT behaviour has to be green before the change. One that only goes
  green after it describes the change, not the behaviour, and protects nothing.

## Assert that the fixture is in force

- Assert the fixture took effect, not only that the outcome looks right. A test workspace once
  emitted a duplicate top-level `quality:` key into its `settings.yaml`. YAML rejects a duplicate
  key outright, so the parse FAILED and `readEffectiveYaml` fell back to the shipped template —
  discarding EVERY section, not just the duplicated one. The workspace config was nothing the
  test had written, and the scenario passed for the wrong reason.
  `test/inline-body-size-gate.test.mjs` now REPLACES the default block when a caller supplies
  its own — copy that shape instead of concatenating YAML sections.
- `test/harness.mjs` already writes `embed.backend: lexical`, `consolidate.enabled: true`, and
  `quality.judgeEnabled: false` into every workspace's `settings.yaml`. A test adding any of
  those sections is duplicating them — check before you append.

## Pin every value duplicated between a gate and a real entrypoint

- A constant computed in BOTH a gate/test and a production entrypoint must be pinned by a test
  asserting the two are equal. The migrations directory resolved one level too high in the CLI
  while the gate computed it correctly: every unit-level gate passed and the real
  `cli.mjs migrations` crashed on a missing manifest, caught only by an isolated end-to-end
  run. `test/migrations-tree.test.mjs` now pins the CLI's exported dir to the one the gates
  check — reproduce that pattern for any new pair.
- A gate that recomputes what production computes is testing itself, not production.

## An overlay that copies keys explicitly drops the new ones

- `settings-overlay.mjs` applies most sections (`consolidate`, `flush`, `hook`, `embed`,
  `recall`, `compile`) with a generic loop over the defaults' keys, so a newly added key is
  picked up for free. `gate`, `quality`, `gc`, and `wiki` copy each key in its own explicit
  branch. For SOME of them (`gate.enabled`, `gate.claudeHookEnabled`, `gate.auditTrailEnabled`,
  `gate.perLessonConsent`, `quality.judgeEnabled`) that is deliberate — fail-closed uncoerced
  pass-through, so an empty or null value cannot disable a gate; others are simply explicit. Do
  not assume every branch encodes a safety property. Either way a new `gate.*`
  default with no branch NEVER reaches the section and silently reads its default no matter
  what the user sets. When adding a key to an explicitly-copied section, add its overlay
  branch AND a test that sets it from YAML and reads it back. Read the overlay before
  asserting either shape; the two styles live side by side.

## Sweep retired config keys from tests AND docs

- When a migration retires an env var, delete every setter and every doc mention in the same
  change. `MEMORY_EMBED_BACKEND` was migrated to `embed.backend` (the mapping lives in
  `scripts/migrate-settings-constants.mjs`) and NOTHING in the engine reads it any more — yet
  a dozen test files, two npm scripts, the CI workflow, and the webapp e2e setup still set it.
  `.agents/rules/testing.md` documented it as the mechanism keeping the ~340MB embedding model
  out of tests until that was corrected; the actual mechanism is `test/harness.mjs` writing
  `embed.backend: lexical` into each workspace's `settings.yaml`.
- KNOWN DEBT, not a sanctioned exception: those setters are still there. The policy is delete-on-
  sight — remove them from any of those files you edit for another reason, rather than scheduling
  a sweep nobody owns.
- A setter nobody reads is a FALSE GUARANTEE: it reads as protection and provides none. Grep
  for READERS before trusting any env var a test sets.

## Durable-artifact changes need a named before/after invariant

- Any change touching a persisted artifact (embedding caches, wiki leaves, ledgers, state
  files) is proven by a cheap invariant captured BEFORE and re-checked AFTER — and the
  invariant is NAMED in the report, never implied.
- Precedent: an embedding-stack refactor was validated by snapshotting every cache's stamp and
  entry count on both sides, plus `cli.mjs warm` reporting `embedded: 0` as proof nothing had
  been invalidated and silently re-embedded. That same snapshot is what later detected real
  data loss.

## Keeping this rule current

- When a gate is added to `package.json`'s `gates` chain, add it to the enumeration above in
  the same change. An enumeration that lags the chain teaches a partial run as a complete one.

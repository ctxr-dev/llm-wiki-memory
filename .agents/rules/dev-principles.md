# llm-wiki-memory development principles

Invariants for working on THIS codebase. Each exists because of a real incident — do not
relax one without a review and (if user-visible) a release runbook.

## Durability

- This tree is executed live by the MCP server, hooks and cron, so an EDIT can destroy data
  no bug would have touched — `.agents/rules/live-runtime-safety.md` is the P0 rule and
  governs on conflict.

- Every whole-file write of a durable artifact — wiki leaves, the failed-distill stash,
  gc-state, `settings.yaml`, the rewritten `.env`, merged client configs — goes through
  `writeFileAtomic` (`scripts/lib/atomic-write.mjs`): temp file in the SAME directory +
  fsync + rename. Bare `fs.writeFileSync` is acceptable only for non-durable scratch.
  Why: the 2026-06-03 disk-full incident NUL-corrupted a file via an interrupted bare write.
- Append-only logs append with `appendFileSync` (rename semantics would defeat an append);
  their full REWRITES (front-truncation) go through `writeFileAtomic`.

## Parsing

- Which posture applies to a NEW artifact — fail loud, or warn and fall back — is decided by
  cost asymmetry (how cheap the check is against how recoverable the artifact is), not by
  taste: `.agents/rules/defensive-invariants.md`.

- USER-supplied files (`settings.yaml`, `.env`, stash JSON, client configs): safe-parse →
  loud warning + fallback to the shipped template, or quarantine. Never throw-and-wedge the
  whole memory system on user data.
- A malformed SHIPPED template THROWS — that is a packaging bug, not recoverable user data.
  The asymmetry (user-malformed = warn+fallback, template-malformed = throw) is intentional
  and pinned by tests.

## LLM-driven loops

- Any recursion or loop wrapping LLM calls or file writes carries a hard depth/iteration
  cap AND a deterministic fallback (`reduceMerge`: `REDUCE_MAX_DEPTH` falls through to
  `deterministicDedup` — it does NOT throw and never drops atoms). Never trust a shrink
  invariant alone: an echoing mock/LLM defeats it; unbounded reduce recursion filled the
  disk twice.

## Prompt-injection

- Any LLM- or user-controlled value rendered at COLUMN 0 of a re-parseable document
  (titles, tags) is newline-collapsed before rendering. Untrusted bodies are wrapped in
  `UNTRUSTED ... BODY` fences; embedded markers in content are defanged via
  `scripts/lib/fence.mjs` (ZWSP insertion). Every new render format ships a render→parse
  round-trip test proving a forged `### Atom` / fence marker cannot survive.
- `redact()` every transcript-derived text before persisting. Never "test" the redactor by
  feeding it real secrets.

## Configuration

- Anything built from `settings()` is built from LIVE config and must be keyed on it; a
  retired key must be swept from tests and docs in the same change
  (`.agents/rules/module-state-ownership.md`, `.agents/rules/verification-completeness.md`).

- NO provider/model name string literals in `.mjs`. Chains and model lists live in
  `templates/settings.yaml` (user copy under `<data>/settings/`). The single sanctioned
  exception is `DEFAULT_EMBED_MODEL` in `scripts/lib/settings.mjs` (structural fallback for
  a broken template) — IMPORT it; never re-literal it. Verify with grep before calling work
  done.
- Shared constants (`KNOWN_PROVIDERS`, `DEFAULT_EMBED_MODEL`) have exactly ONE definition,
  exported from `settings.mjs`. A re-hardcoded copy is a review-failing drift hazard.

## Failure observability

- A check that should never fire is a TRIPWIRE, not dead code, and firing is an incident —
  `.agents/rules/defensive-invariants.md`.

- A failure that an operator or runbook is told to react to must be observable on the
  documented path: no `|| true` around a command whose non-zero exit is a documented
  stop-signal, and abort BEFORE any silently-degrading fallback (bootstrap aborts before
  the settings.yaml defaults copy, so a failed migration can't masquerade as a default
  config).

## ESM & style

- `.mjs` is ESM: static `import` only (`require` does not exist here). Every script guards
  its CLI entrypoint so importing it for exports has zero side effects.
- **That guard is `if (import.meta.main)` — never a path comparison.** Node resolves
  `import.meta.url` to the PHYSICAL path but leaves `process.argv[1]` exactly as typed, so any
  comparison of the two disagrees on a symlinked launch and the script SILENTLY DOES NOTHING
  while exiting 0. That reproduced through a symlinked install dir, an `npm link` / `npm i -g`
  bin shim, and every Windows launch; the worst case was the MCP server exiting 0 before the
  handshake, so every memory tool vanished with no error. The bare form
  (`pathToFileURL(process.argv[1])`) additionally THREW on import from `node -e` / piped stdin,
  where `argv[1]` is undefined. `import.meta.main` has neither failure and needs no
  `path.resolve`, no `|| ""`, and no try/catch. It requires **Node >=22.18** (added 24.2,
  backported 22.18) — the floor `package.json` declares, `scripts/lib/node-floor.mjs` refuses
  below at runtime, and both bootstrap scripts feature-test at install.
  `import.meta.main` is true for exactly what Node was HANDED as the entry: `argv[1]`, the
  `-e` / piped-stdin source **text**, or a **Worker's entry module**. A file that is *imported*
  is never main, however its importer was launched — so "an entrypoint imported as the `-e` main"
  cannot happen, and the `-e` inversion bites only if an entrypoint's own source text is fed to
  `-e`. The Worker case is the one to keep in mind: the guard means "I am an entry point", NOT
  "a human launched me", so moving an importer into a Worker, or converting a self-respawn to
  `worker_threads`, would run an imported entrypoint's body.
  Enforced by `test/entrypoint-main-guard.test.mjs`, which derives the entrypoint list rather
  than hard-coding it. A hook that must run unconditionally simply has no guard — do not add
  one to the PreToolUse gates, whose opposite fail modes are pinned by `test/fatal-guard.test.mjs`.
- **Never feature-test `import.meta.main` to detect an old Node.** A bundler erases it: Vite /
  Vitest's SSR transform replaces `import.meta` with a synthesised object holding only
  `{ url, env, filename, dirname }`, so the property reads `undefined` on a perfectly supported
  Node. "Too old" and "transformed source" are indistinguishable through that property, so a
  feature-test-only check would `process.exit` inside a vitest worker. `scripts/lib/node-floor.mjs`
  therefore requires the feature to be missing AND `process.versions.node` to be below the floor,
  and a test pins that nothing beyond the launch-policy owners imports it. (A shell probe has no
  bundler, so `bootstrap.*` may feature-test freely — and must, before any path that shells out to
  a guarded `.mjs`, including `--uninstall`.)
- Comments only where the code is genuinely non-obvious, and they explain WHY. No dead
  code, no banners.

## Cross-client portability

- The engine serves Claude Code, Cursor, Codex, and generic MCP clients UNIFORMLY. Never
  rely on a client-specific env var (e.g. `CLAUDE_PROJECT_DIR`) for project or branch
  detection — use `process.cwd()` and git introspection. Match branch text semantically
  (embeddings), never with hardcoded tracker-key regexes.
- Every automatic behaviour ships as a DUO: the Claude Code hook (auto-fires) AND a
  provider-agnostic skill/rule for hook-less clients (precedents: current-work-context,
  embed-gc, consolidate). Dropping either half is a regression, not a simplification.
- Discipline text lives on three surfaces that must change TOGETHER: the MCP server
  `initialize` instructions, `templates/rules/` + `templates/skills/` (rendered into
  consumer workspaces by bootstrap), and the README.

## Wiki placement & topology

- Placement is always NESTED by the facets a category is searched by, never a flat
  category root (`knowledge/<module>/<atom_type>/`,
  `self_improvement/<module>/<task_type>/`, `daily/<yyyy>/<mm>/<dd>/`); absent facets use
  the sentinels `unscoped` / `unknown` / `untyped`.
- When facet inputs fail the topology's criteria, FAIL LOUD (assert, log, abort). Never
  fall back to defaults that materialise directory trees — default-zero facets once
  created an orphan `issues/JIRA/DEV/0/0/1/` tree. The pathFor ↔ from_path round-trip
  checks enforce this; keep them.
- Never run skill-llm-wiki's topical `rebuild` on a memory wiki (it re-clusters by meaning
  and fights the facet layout). Re-nest deterministically with `node scripts/cli.mjs nest`.
- Leaf-name normalisation preserves compound extensions: `.plan.md` keys the plan
  lifecycle machinery, and a normaliser that assumes single-segment extensions silently
  breaks it (`normalizeLeafName` special-cases it — keep that).

## LLM-in-the-pipeline design

- "Deterministic across clients" means a reproducible SYSTEM CONTRACT, not "no LLM call".
  The sanctioned pattern (compile's `decideAction`): fixed prompt + strict JSON-schema
  output + deterministic validation that rejects hallucinated references and re-prompts +
  a structured decision the system applies. Consolidate's merge/refresh passes follow it.
  Reuse this pattern for new pipeline features; never have the system trust a raw score.

## Hooks & background work

- Capture/maintenance hooks are best-effort: always exit 0, never block or fail the
  session. Pair an event-driven matcher with a SessionEnd safety net when the event can be
  missed (plan-frontmatter-sync precedent).
- Recurring maintenance throttles itself via `--if-due` + a state file
  (`state/.embed-gc.json`, `consolidate.intervalDays` in settings.yaml). Callers never
  re-implement the interval.
- Anything a hook injects into agent context respects a hard context budget: one short
  summary line (cron-health caps it at 200 chars; a test pins the whole section under
  1KB), with the full structure available only on explicit fetch.
- Plan routing is INTENTIONAL design, not a bug: tracker-bound plans are saved manually to
  the `issues` tree; only custom plans flow through the ExitPlanMode hook into `plans/`.
  Do not "fix" one into the other, and confirm intent before filing any bug-root-cause
  about the memory system's own behaviour.
- Self-observability is the INTERACTIVE counterpart to the cron self-healing path: when an
  agent observes a confirmed llm-wiki-memory bug while working, the (opt-in) `self-observability`
  rule has it record a redacted capture under `<data>/monitoring/` (via `cli.mjs monitor`,
  reusing `redact` + `normalizeErrorSignature` + `writeFileAtomic`) and OFFER to plan an `src`
  fix at session-end. That capture store is disjoint from cron's `issues/` + `state/` — never
  cross-write them; cross-reference by signature only. The fix-PLANNING half lives here in the
  dev rules (this is where engine fixes get designed and committed by the user); the
  observe/capture/offer half ships as the rendered rule. See
  `.agents/rules/self-observability.md`.

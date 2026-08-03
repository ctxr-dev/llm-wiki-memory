# Module-state ownership & caches built from hot-reloading settings

How mutable module-scope state is owned here, and what caching anything derived from `settings()`
obliges. Each rule is the residue of a real defect and applies to ANY subsystem — the embed stack
is only where they were paid for.

## One module owns one state machine

- **File length is a symptom; the disease is plural ownership.** `embed.mjs` reached 543 lines and
  was the last file failing the 300-line `check:size` gate in `npm run gates`. It held four
  concerns, THREE of which owned independent mutable module state: the backend-fallback window,
  the worker handle plus the in-process embedder, and the parsed-cache memo. Concerns sharing a
  file share nothing else, so their interactions go unwatched — the persistence-suspended guard
  returned before the cache memo was refreshed, memoizing wrong-dimension vectors for the run.
- **The criterion: if you cannot name a module's single state machine in one phrase, it owns more
  than one.** `embed-backend-state.mjs` = "which backend is serving, and for how long";
  `embed-runner.mjs` = "turn texts into vectors" (worker handle AND in-process embedder — one job
  on one config, so separating them strands the decision from what it decides between);
  `embed-cache-guards.mjs` = "may this write proceed, and what do we tell the operator";
  `embed-cache-io.mjs` = "how the file is read and written". That question is what makes a split
  stable; a line count is not — `embed-cache-io.mjs` later crossed 300 and split cleanly again.
- **Keep the runtime dependency one-way and say so in the module header.** The cache layer imports
  the backend state machine (it must know the resolved backend to stamp and to refuse a downgrade);
  nothing in the state machine imports the cache. A JSDoc `import(...)` type is erased at compile
  time and creates no cycle, but a type back-edge reads as licence to make it a real import later —
  so a format's OWNER declares its types and the facade re-exports them.

## Anything built from `settings()` must be KEYED on the settings it captured

- **Use `keyedMemo` (`scripts/lib/keyed-memo.mjs`); do not hand-roll a fourth latch.** For
  inference artefacts the key is `inferenceKey(...)`, JSON-encoded rather than a joined string
  because a model id contains slashes and two distinct configs must never alias onto one key.
- **Key on the artefact's IDENTITY — what changes its output or the metadata stamped beside
  it — not on every input the build happens to read.** A field that changes neither buys a
  full rebuild for nothing, and every rebuild is itself an eviction event. `threads` is the
  worked example: it reaches only onnxruntime's `intraOpNumThreads`, never a vector and never
  `cacheStamp`, and `docs/embeddings.md` measures thread scaling as FLAT (44.5-45.4 ms/doc
  across 1-14 threads, benchmarked on the bge-large path; the shape carries over) — so keying
  on it forced a ~190MB model reload (q4 weights) for a knob with no
  measurable effect. It is still passed to the builder, so a later rebuild honours it.
- `settings()` re-stats its file on every call and rebuilds on an mtime or env-overlay change:
  config here is LIVE, not process-constant. An unkeyed `if (!promise) promise = build()` latch
  keeps serving an artefact built from config that no longer applies while the rest of the process
  has already moved on.
- Three such latches existed at once — the worker's embedder, the in-process embedder, the
  tokenizer — while `cacheStamp()` re-read the same settings on every save. Editing `embed.model`
  or `embed.dtype` on a running process changed the STAMP without changing the thing producing the
  vectors, writing (for example) q4 vectors labelled q8. A q4→q8 flip preserves the vector
  dimension, so the load-time validity check can NEVER catch it: the mislabelled cache validates
  forever and silently degrades ranking. Nothing crashes, which is why the class outlives others.
- **A derived value that re-reads live settings must key on the same inputs as the artefact it
  describes.** `embedWindow()` re-reads the model on every call, so an unkeyed tokenizer meant the
  window and the vocab came from DIFFERENT models — chunking against the wrong one, truncating.

## What keying obligates

- **Wrap `build` so a SYNCHRONOUS throw becomes a rejection.** Load-bearing, not style: the key is
  assigned before the slot, so a sync throw escapes with the key advanced while the slot still
  holds the OLD value — the next lookup for that key is a "hit" returning something built for a
  different config, exactly the bug class the memo exists to prevent. A test pins it; never
  "simplify" the async wrapper away.
- **A rejected build must not latch, and a late rejection must not evict a newer entry.** Clear the
  slot only when the rejecting build is still the current one: otherwise one transient failure (a
  half-written model file, a momentary OOM) disables the backend for the process lifetime, and an
  unconditional clear lets a stale failure wipe a valid newer entry and race a second model load
  against the one still running. Same reason `resetKey(key)` no-ops on a key mismatch.
- **Making a rebuild POSSIBLE creates a resource-lifecycle duty that did not exist before.** The
  embedder closes over an onnxruntime session whose memory is native and is freed only by an
  explicit `dispose()` — upstream ships no finalizer — so the memo grew an `onEvict` hook and the
  embedder a `dispose` seam. Generalize: adding a replace/reset path to something previously built
  once per process obliges you to ask what the replaced value holds that the GC does not manage —
  native memory, file handles, sockets, timers, worker threads, locks.
- **Eviction is best-effort and never fails the caller, but is never SILENT either.** A disposer
  that throws, or a superseded build that rejects, must not fail the `get()` that triggered it —
  yet a failed release leaks exactly what the GC cannot reclaim, and a leak presents as quiet
  degradation, so it warns once (the checklist below makes that mandatory, and
  `.agents/rules/dev-principles.md` § Failure observability requires it).

## Stamp/content coherence

- **Never re-label existing content with freshly-read metadata.** Metadata describing produced
  content is captured from the SAME read that produced it, or the drift is DETECTED. `saveCache`
  re-read the stamp from live settings and applied it to the ENTIRE entries map — including
  vectors loaded under a previous stamp.
- **Assume the window is wide.** The warm loop holds one cache object open for minutes BY DESIGN
  (small slices, duty-cycle pause between them), so a settings edit lands inside it routinely —
  never a microsecond race you can wave away.
- **The fix shape: compare the stamp recorded ON the object against the live one; on drift DROP the
  content, re-stamp the object** so the rest of the run accumulates cleanly, and report the discard
  once (`stampStillDescribes`, `warnStampDrift`). Dropping is affordable only because vectors are
  recomputable — assert that when true, and choose otherwise when not.
- **Per-field tolerance: an ABSENT field makes no claim and cannot be contradicted.** A file
  predating dtype stamping, or a caller-built map never stamped, is not drift.

## Facade for surface stability

- **When splitting a module with many importers, keep the original path as a facade re-exporting
  the public surface.** `embed.mjs` and `settings.mjs` both do this; the embed split left every
  production importer untouched, which is what made a four-way split a safe refactor at all.
- **Nothing is exported solely for tests.** A state machine's reset/inspect helpers belong on ITS
  module, where tests reach them directly — not punched through the subsystem's public API. Where
  such a mutator must live on a production module, prefix it `__` and state in a comment what
  calling it from production would silently break (`__resetForTest`, `__setWorkerFactoryForTest`).

## Checklist — adding module-scope state or a cache

- **What is the key?** Every input the build reads. "No key" needs a process-constant value —
  settings-derived never is.
- **What invalidates it?** An mtime, env overlay, config edit, external writer — and which of those
  the check actually observes.
- **What does eviction owe?** An explicit, best-effort release seam for anything the GC ignores.
- **Who else reads the same source of truth, on what cadence?** Per-call vs build-once readers of
  live settings ARE the drift generator: share a key, or detect the divergence.
- **How does the failure present?** Quietly wrong results rather than a crash make both the guard
  and a one-shot operator-visible diagnostic mandatory.
- **Which module owns it?** One phrase — or split before adding the state.

## Known hazard, deliberately unfixed

- **A burst of key changes starts unbounded concurrent builds.** `get()` begins a build per
  changed key and cancels nothing, so N rapid `settings.yaml` edits inside one model-load
  window mean N concurrent model loads (~190MB each; measured: 4 keys in one tick → 4
  concurrent builds).
  Serialising them is NOT a safe fix: two tests — *"a late rejection never clears a NEWER memo
  entry"* and *"a KEY CHANGE cannot release a value a borrower is still awaiting"* — require a
  new key's build to START AND COMPLETE while an older key's build is still in flight, so any
  cross-key mutex deadlocks both. The spike is transient (the memo retains one entry) and the
  trigger is rare. If this ever needs fixing, it needs an admission gate that preserves those
  two properties, not a mutex.

## Keeping this rule current

Extend this rule when a change teaches something new about module state, caching, or resource
lifecycles: a fresh drift class, another artefact that must be keyed, a disposal duty for a non-GC
resource. Keep entries short, imperative, anchored to the defect that produced them; drop one only
when the code it protects is gone. A second state machine in a module that already owns one, or an
unkeyed memo over live settings, is a review-failing regression, not a simplification.

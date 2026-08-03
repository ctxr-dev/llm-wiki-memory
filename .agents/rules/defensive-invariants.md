# Defensive invariants — when a check may be deleted

Deleting a defensive check because a proof says it cannot fire is the most expensive class of
mistake made in this codebase. The proof is usually correct; the process it describes is not
the process that runs. Read this before removing any guard, and before accepting a review
finding that one is dead code.

**The gate, up front: no check is deleted without a test that FAILS if the thing it prevented
happens again.** Everything below is why that is not bureaucracy.

## The incident that grounds this rule (2026-08-02)

- `persistBlockReason` (`scripts/lib/embed-cache-guards.mjs`) once carried TWO independent
  refusals before the embedding cache could be persisted: a STATE-MACHINE check —
  `persistSuspended(configuredBackend(), resolvedBackend())`, refusing when the process fell
  back to lexical although a model backend was configured — and an ON-DISK EVIDENCE check,
  refusing to stamp `lexical` over a file whose recorded backend is `transformers`.
- The on-disk check was removed after three independent reviewers derived it unreachable. That
  derivation was sound and still is: with a non-lexical config, `activeBackend()` returns
  `"lexical"` only when the resolved backend is `"lexical"` — already blocked above.
- After removal the forbidden event occurred on the live brain: 908 transformer vectors
  (dim 768) were replaced by 646 lexical ones (dim 256) with `embed.backend: transformers`
  configured. Impossible on paper; it happened, because module state desynced while the live
  tree was being edited under a running process.
- The resolution was NOT a revert. The check came back as a TRIPWIRE scoped to the case that
  had made it wrong. Both directions are pinned in `test/embed-backend-guard.test.mjs`.

## "Unreachable by derivation" is not "unreachable in fact"

- A derivation is valid only over the states it modelled. Module reload, a partially-applied
  edit to a live tree, concurrent writers, a future refactor, and an in-memory state machine
  that desynced from disk all sit outside the model — and none of them announce themselves.
- Weight a derivation by the COST OF BEING WRONG, not by how many reviewers agreed. Three
  people agreeing on the same model does not widen the model.
- A check that cannot fire costs nothing at runtime. That is an argument for keeping it, not
  for deleting it.

## Name the independent signal before you delete

- Before removing any check, state which SOURCE it reads. Two checks on the same source are
  redundant and one may go. Two on DIFFERENT sources — in-memory state vs bytes on disk,
  declared config vs observed artefact — are defence in depth, and the second is precisely what
  survives when the first's assumptions break.
- Here: the state-machine check reads `configuredBackend()` / `resolvedBackend()` from the
  process; `existingCacheBackend` reads the backend recorded in the file about to be
  overwritten. Removing the second left one signal covering two failure modes, and the mode
  it did not cover is the one that fired.
- "Both checks refuse in the same scenario" is NOT "both checks read the same thing" —
  overlapping outcomes are the point of layered defence.

## Guard vs tripwire — classify, then scope

- A **guard** is policy: it shapes normal behaviour, fires routinely, and must be correct in
  the common case. Its cost is paid on every call.
- A **tripwire** is integrity: it should NEVER fire, is cheap precisely because it never fires,
  and must be LOUD when it does.
- A guard whose cost you resent is usually a tripwire that was scoped too broadly. Narrow the
  scope instead of deleting it. The performance objection that motivated the removal here was
  real — a full read + JSON.parse of a multi-MB cache on every save, on the search path — and
  it evaporated once the file read sat behind the branch the derivation calls dead.
- Classify before arguing about cost: judging a tripwire by guard economics ("it never fires,
  so it earns nothing") inverts its whole value.

## If a check is genuinely wrong, fix the SCOPE, not the existence

- The removed check DID have a real defect worth the attention it got: when an operator
  deliberately set `embed.backend: lexical`, the refusal was self-perpetuating — the write was
  blocked, so the on-disk stamp never updated, so every later save was blocked too, freezing that
  wiki's cache forever while recall re-embedded at most `embed.maxColdPerRead` leaves per read.
- The pattern: identify the exact case where the check misfires, exclude exactly that case, keep
  everything else. The reinstated tripwire fires only when the operator did NOT configure
  lexical — a deliberately-lexical wiki is never frozen, the corrupting overwrite is still refused.
- Deleting a check to fix its false positives trades a visible bug for an invisible one.

## A removal requires a test that would fail if the event recurs

- No check is deleted without a test that fails when the thing it prevented happens again.
  Otherwise the check was the only part of the system that knew, and the knowledge leaves with
  it — which is exactly how the incident above reached a live wiki.
- Pin BOTH directions: that the forbidden write is still refused, and that the legitimate case
  the scope-fix unblocked still lands. A one-directional test invites the next reviewer to
  re-break the other side.
- Assert against real on-disk state, never the mock (`.agents/rules/testing.md`): the
  reinstated tripwire is pinned by reading the cache file back and checking whose vectors
  survived.

## Cost asymmetry decides the call

- Cheap check + expensive or irrecoverable artefact = KEEP IT, even when provably dead.
  Expensive check + trivially recomputable artefact = the derivation may win.
- Artefacts here that qualify: **wiki leaves** — git-backed with no remote by design, so the
  local history is the only backup of record; and **embedding caches** — recomputable, but the
  price is a full cold re-warm of the corpus, which is why every persistence path refuses rather
  than degrades. The durable-write list in `.agents/rules/dev-principles.md` approximates the set.
- State the asymmetry explicitly in the review. "It cannot fire" is not a decision until it is
  paired with "and if it did, we would lose X".

## A firing tripwire is an incident, not a success

- If a tripwire fires, an invariant broke. Do not treat the refusal as the system working and
  move on — find out how the impossible state was reached.
- Its message must name the FILE it protected and WHAT it refused: `saveCache` reports the
  block reason, the cache path, the invoking process, and that the on-disk cache is left
  authoritative — actionable without a debugger.
- Record it. A confirmed engine invariant break is exactly the evidence-backed case the
  capture path exists for — see `.agents/rules/self-observability.md`.

## Keeping this rule current

When a defensive check is added, narrowed, or removed in this repo, update the incident list
here in the same change — one line naming what broke and which signal caught it. A rule that
stops accumulating incidents decays into style advice, and style advice loses to a confident
derivation every time.

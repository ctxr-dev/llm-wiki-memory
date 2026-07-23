---
name: content-quality
description: Saved memory in the curated categories (knowledge, self_improvement, plans, investigations, issues) is polished, self-contained, professional documentation — never quoting or attributing the user, and stripped of irrelevant/unprofessional off-topic specifics, while KEEPING the substantive technical evidence (tickets, root cause, versions, stable contract identifiers) as DURABLE fact — never pinned to a volatile code position (line numbers; and file paths / internal symbol names only as re-verifiable hints). EXEMPT — daily (raw capture layer) and absorb (verbatim external imports).
---

<!-- CANONICAL SOURCE: .llm-wiki-memory/src/templates/rules/content-quality.md
     bootstrap.sh wires an @-pointer to this file into .agents/rules/, .claude/rules/,
     and .cursor/rules/ (reference-only — no copies, no symlinks). Edit this canonical
     template; do NOT hand-edit a pointer. -->

# Content quality — polished, de-personalized, professional

Every leaf you SAVE into a curated category — `knowledge`, `self_improvement`, `plans`,
`investigations`, `issues` — is a permanent, reusable document that other agents (and future
you) read cold, with none of this conversation's context. Write it as **professional
documentation of the fact or principle**, not as a transcript of the exchange that produced it.

## The rule

> Saved memory content (title + body + evidence) is **polished, self-contained, and
> professional**. It NEVER quotes the user or attributes anything to a person — no "the user
> said…", no "you told me…", no names, no verbatim quotes of the conversation. It carries **no
> irrelevant, off-topic, or unprofessional specifics**. It DOES keep the substantive technical
> evidence — ticket keys, the actual root cause, versions, and stable contract identifiers
> (schema fields, public APIs, config keys) — stated as impersonal fact, and DURABLY: never
> pinned to a volatile code position (see Durability below).

Write the reusable principle, not the incident-as-chat.

## Do / Don't

- **Do:** "Kafka partition key must derive from the original `WebhooksOrder.id`; routing broke
  when it was keyed on the optional `eventContext`. **Why:** … **How to apply:** …"
- **Don't:** "The user got annoyed that I keyed the partition on eventContext and told me to
  use WebhooksOrder.id instead."
- **Do (evidence):** de-personalize to the technical fact — "`DEV-129957`: request_id diverged
  because it was pinned to a fresh trace_id".
- **Don't (evidence):** store the raw correction excerpt, profanity, or conversational asides.

## Keep the evidence, drop the attribution

De-personalizing is NOT reducing technical specificity. Keep every DURABLE technical anchor
that makes the atom clear and retrievable (see Durability below for which anchors are durable) —
that is what the quality rubric and investigations require. Remove only *who said it* and the
irrelevant/unprofessional noise.

## Durability — write knowledge that survives refactors, never volatile locators

Code shape changes constantly; anything that pins a memory to a CODE POSITION rots and becomes
actively false the moment someone edits nearby. So write the DURABLE concept, and never let a
leaf's correctness depend on a locator that a routine edit invalidates.

- **NEVER** record a line number, `~line N`, `Lnn`, a byte offset, or any position-based locator
  ("the third function", "at the top of the file") as a KNOWLEDGE CLAIM. One edit above it makes
  the leaf a lie. This is absolute for facts. The sole exception is a regenerated, point-in-time
  **navigation index** — e.g. the clickable `#Lnn` links the `topology-tree` rule mandates in a
  plan / investigation / issue doc: that is a disposable wayfinding aid, not a durable fact, so
  it is allowed, but treat its line anchors as re-verifiable (see `recall-validation`) and prefer
  symbol anchors where the renderer permits.
- **AVOID depending on file paths or internal symbol names** (private helper / method / function
  names, module paths) — ordinary refactors rename and move them. State the point CONCEPTUALLY:
  what the behaviour / rule / root cause IS and WHY, so the leaf stays true after a rename. If a
  concrete pointer genuinely aids navigation, include it only as a clearly-subordinate, dated
  HINT ("as of 2026-07, in the webhooks fetcher"), never as the load-bearing fact — and a reader
  MUST re-verify it before relying on it (see the `recall-validation` rule).
- **KEEP the truly immutable anchors** that do NOT drift: ticket keys (`DEV-129957`), released
  versions, commit SHAs (as historical markers), stable published/contract identifiers (an Avro
  field name, a public API, a config key), and reproducible error messages / patterns. These are
  facts, not positions.

Litmus test: *if a teammate refactored this code next week without changing its behaviour, would
the leaf still be true and useful?* If a rename or a shifted line would falsify it, rewrite it
conceptually.

## Scope — what this does NOT govern

- **`daily`** is the RAW pre-distill capture layer by design; it is EXEMPT. Polish is applied
  when content is promoted OUT of daily into a curated category (by compile / consolidate).
- **`absorb`** imports whole external documents VERBATIM; it is EXEMPT — never rewrite an
  absorbed document to "polish" it.

## Enforcement

The auto-distillation prompts (flush / compile / consolidate) instruct de-personalization, and
an always-on guard neutralizes obvious attribution that slips into an auto-distilled atom. An
interactive `save_lesson` is human-reviewed at the consent step (the per-lesson AskUserQuestion),
so the proposed content must already follow this rule before it is offered.

---
name: self-observability
description: Opt-in. While working in a project that uses llm-wiki-memory, watch the memory system itself. On a likely/confirmed bug in llm-wiki-memory (with evidence), record a redacted capture via `cli.mjs monitor`; when the main work wraps, OFFER to review open captures and plan fixes for .llm-wiki-memory/src. Never auto-fix.
---

<!-- CANONICAL SOURCE: .llm-wiki-memory/src/.agents/rules/self-observability.md
     This is an OPT-IN rule. When the user consents (bootstrap --enable-self-observability),
     it is REFERENCED into .agents/rules/, .claude/rules/, .cursor/rules/ via @-include
     pointers that track THIS file. Edit this canonical copy; never hand-edit a pointer. -->

# Self-observability (watch llm-wiki-memory while you work; offer fixes)

This rule applies to every AI agent (Claude Code, Cursor, Codex, generic MCP clients) working
in a project that has **opted in** to llm-wiki-memory self-observability. It governs how you
react when the *memory system itself* misbehaves while you are doing other work. It is the
INTERACTIVE counterpart to the background cron self-healing path; it does not replace it.

## The invariant

> While working with llm-wiki-memory, if you observe it behave **wrongly** — a CLI error, a
> malformed MCP response, a corrupted/mis-placed leaf, an index/embedding drift, a hook that
> silently no-ops — and you are reasonably confident it is a real bug (not expected design),
> RECORD a redacted forensic capture under `.llm-wiki-memory/monitoring/…` the moment you see
> it. Then, when the **main task is complete**, OFFER the user — in one short line — to review
> the open captures and plan fixes for `.llm-wiki-memory/src`. Never silently fix the engine,
> never commit `src` on the user's behalf.

## When to capture (confirmed/likely bugs only)

Capture when BOTH hold: it is about **llm-wiki-memory** (the engine, its MCP tools, hooks, CLI,
wiki tree, or indexes — not the user's own project), AND it is a **likely-bug or confirmed-bug
with evidence** (an error message, a stack trace, a reproduced wrong result, a diff between
expected and actual on-disk state).

- **Do capture:** a tool/CLI threw or returned a wrong shape; a save landed in the wrong place;
  `validate`/`doctor` reports drift you can tie to engine behaviour; a hook didn't fire when it
  should; recall returned obviously-broken content.
- **Do NOT capture (just MENTION at session-end if relevant):** a vague hunch with no evidence;
  a one-off you immediately disproved; behaviour that is actually intended design (see
  cross-references — confirm intent first); a problem in the user's project unrelated to memory.

A mere suspicion is surfaced verbally at session-end, not persisted. The floor keeps the trail
high-signal.

## How to capture

Prefer the engine helper (it redacts secrets, writes atomically, and assigns a stable signature):

```
node .llm-wiki-memory/src/scripts/cli.mjs monitor \
  --title "<short anomaly title>" \
  --severity likely-bug|confirmed-bug \
  --surface "<e.g. cli.mjs compile | MCP save_to_dataset | wiki-store walk>" \
  --observed "<2-4 sentences: symptom, the command/tool call, expected vs actual>" \
  --evidence "<stderr / stack / tool-response excerpt / file paths+lines>" \
  --suspected "<comma-separated best-guess src files>" \
  --cwd "$(pwd)" --branch "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
```

It writes `.llm-wiki-memory/monitoring/<yyyy>/<mm>/<dd>/<slug>-<ts>.md` (status `open`). The path
is OUTSIDE the wiki: it is **gitignored**, never indexed by `search_memory`, and therefore **not
subject to the self_improvement write-gate** — recording a capture needs no user confirmation.

**Fallback (no Node CLI reachable, e.g. a restricted client):** write the file yourself at the
same path, following the helper's shape (frontmatter `status: open`, `severity`, `signature`,
`observed`; then `## What I observed / ## Evidence / ## Suspected area in src/ / ## Related`).
**You must redact secrets yourself** before writing — never paste tokens, keys, JWTs, PEM blocks,
or connection URLs into a capture.

## At the end of the main work

When the primary task is done (or the session is wrapping), check
`node .llm-wiki-memory/src/scripts/cli.mjs monitoring-health`. If `open > 0`, OFFER in one line,
e.g. *"I logged N llm-wiki-memory anomalies this session — want to review them and plan engine
fixes?"* Then:

- **User says yes** → read the open captures, and help **plan** the fix for `.llm-wiki-memory/src`
  via normal plan routing (ExitPlanMode → `plans/`, or the `issues` tree if a tracker issue
  exists). Implement only what the user approves; do **not** commit/push `src` unless they ask.
- After a capture is reviewed/handled, mark it triaged:
  `node .llm-wiki-memory/src/scripts/cli.mjs monitor --resolve <path>`.
- **User says no / not now** → leave the captures `open`; the next session's SessionStart line
  re-surfaces them. Do not delete them.

## Boundaries and cross-references

- **Distinct from the cron self-healing path.** The hourly cron escalates compile/consolidate
  failures to `.llm-wiki-memory/issues/…` automatically. This rule covers anomalies *you* notice
  interactively. The two share the signature vocabulary, so a capture may *cross-reference* an
  open cron escalation in its `## Related` section, but a capture NEVER writes cron's stores
  (`state/.issues-index.json`, `state/.consolidate-entities.json`).
- **Confirm intent before filing.** Some memory-system behaviour is intentional design (e.g.
  tracker-bound plans route to the `issues` tree, not `plans/`). Defer to
  `dev-principles.md` → "Hooks & background work": confirm intent before treating expected
  behaviour as a bug.
- **Durable forensic narrative → `investigation-capture`.** If the anomaly turns into a long
  multi-hypothesis debugging session with a real root cause, write that up as an `investigations`
  leaf. A monitoring capture is the lighter, ongoing layer beneath an investigation.
- **Generalisable lesson → write-gated.** If the episode yields a behavioural lesson, propose it
  (propose-then-confirm, `userRequested:true`); that path IS gated. The monitoring capture itself
  is not.

## Quick reference

| Situation | Do |
|---|---|
| Confirmed/likely llm-wiki-memory bug, with evidence | `cli.mjs monitor --title … --severity … --evidence …` |
| Vague hunch, no evidence | mention at session-end; do not persist |
| Main work finished, `monitoring-health` shows open captures | OFFER to review + plan `src` fixes (one line); never auto-fix |
| Capture reviewed/handled | `cli.mjs monitor --resolve <path>` |
| Behaviour might be intended design | confirm intent first (dev-principles) before capturing |
| Episode warrants a durable narrative | write an `investigations` leaf instead |

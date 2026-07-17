---
name: absorb
description: How to absorb / import existing markdown documents into a wiki as WHOLE (full) leaves — one file, a directory tree, or a glob — using the absorb_document MCP tool (single inline doc) or the `cli.mjs absorb` command (filesystem batch). Covers picking a full category, refusing gated/topology categories, dry-run-then-confirm for batches, and the shared-repo commit note.
---

# Absorb (import whole documents into a wiki)

`absorb` pulls EXISTING markdown into a wiki as **full leaves**: stored verbatim
(never shortened into an atomic note) and embedded whole (all of it searchable).
This is different from the capture→distill pipeline, which makes short atomic
`knowledge`/`self_improvement` notes. Reach for `absorb` when the user has real
documents — a design doc, an RFC, a runbook, an onboarding guide, a spec — that
should live in the wiki as-is.

Two surfaces, by shape of the input:

- **One inline document** → the `absorb_document` MCP tool. It takes the document
  `text` directly (it does NOT read the filesystem — relative paths would resolve
  against the server, not your shell).
- **A file, a directory tree, or a glob** → the `cli.mjs absorb` command. It reads
  the filesystem, so a whole directory is ONE invocation, not N tool calls.

## Trigger

The user asks to "absorb / import / ingest / pull in / load" a file, a folder, or
"our docs" into a (shared or private) wiki.

## Procedure

1. **Resolve scope + target.** Call `get_memory_config` (and `list_datasets`) to
   see the `levels`: each has a `root` / `mountDir` / `ownership`. Map the user's
   words to a level — "shared" / "team" / "the repo" → the `ownership: repo` level;
   "my" / "private" / "personal" → the brain. If the target is ambiguous, propose
   the level you inferred and CONFIRM before writing.

2. **Pick a `full` category** in that target wiki. Prefer an existing facet-placed
   category whose leaves are whole documents (the shared `repo` template ships a
   `full` `knowledge` category). If the target has no suitable full category,
   propose creating one (or note that a per-document `memory.full` override will
   mark just these leaves full) and CONFIRM. **Refuse** gated (`self_improvement`)
   and topology (`issues`) categories — absorb cannot auto-place into them, and it
   errors if you try. Absorb targets FACET-PLACED, non-gated categories only.

3. **Batch (directory / glob) → dry-run first.** Run the CLI with `--dry-run` to
   get the file→category/dir table WITHOUT writing:
   `node .llm-wiki-memory/src/scripts/cli.mjs absorb <path…> --category=<name> [--match=<glob>]… [--target=<selector>] --dry-run`
   (flags are equals-form; repeat `--match=` for multiple masks; default masks are
   markdown). Show the user the proposed placements, get an OK, and apply any
   overrides they want (`--area=`, `--subject=`, `--atom-type=` are batch-wide),
   then re-run WITHOUT `--dry-run`.

4. **Single document → absorb directly.** Call
   `absorb_document({ scopes, target, write: { text, name, category, metadata?, dryRun? } })`
   with the document text inline. `write.name` is the leaf filename; `write.metadata`
   overrides any inferred facet. Report where it landed.

5. **Understand each leaf.** The per-file classifier infers `area` / `subject`
   from the content; trust it, but eyeball the dry-run for obvious misplacements
   and override `--area=` / `--subject=` when a file is clearly in the wrong place.

6. **Be efficient + idempotent.** Absorb a whole tree in ONE CLI call, not one
   tool call per file. Re-absorbing is idempotent: a leaf's name is derived from
   its source path, so re-running overwrites in place (no duplicates) even if the
   model now infers a different area/subject. Don't re-absorb unchanged files
   needlessly.

7. **Shared-repo write note.** Absorbing into a `ownership: repo` (shared) wiki
   only STAGES the leaves in that repo's working tree — the engine runs NO git.
   After a shared absorb, tell the user: commit and push the staged memory changes
   in that repo to share them.

8. **Report.** Summarise what landed (count + a few paths), what was skipped (a
   non-matching mask), and what FAILED (per-file errors — a batch continues past a
   bad file rather than aborting).

## Notes

- A full leaf is stored verbatim and embedded whole (uncapped chunking), so deep
  content is findable — unlike an atomic note capped to a short body.
- LLM offline? Absorb still works: a file with no classification lands under a
  sentinel area (`unscoped`) with the subject fallback, rather than failing.
- `absorb` never targets `self_improvement`, so it never touches the write-gate.

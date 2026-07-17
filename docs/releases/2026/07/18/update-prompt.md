# llm-wiki-memory: configurable FULL leaves + `absorb` (import whole docs) (2026-07-18)

A paste-ready prompt for upgrading an **existing** llm-wiki-memory install past the
**2026-07-18** release. Apply the earlier 2026-07-13/14/15/17 releases first if you
have not.

**WHO IS AFFECTED — everyone, but this is ADDITIVE and needs no manual data step.**
A new way to keep WHOLE documents in a wiki (never shortened, embedded whole), plus a
tool + command to import existing markdown. Nothing about existing atomic notes,
recall, the write-gate, or consolidate changes.

## WHAT'S NEW

- **(layout) a category can be marked `full: true`.** A full category's leaves are
  stored VERBATIM (never distilled to an atomic body) and embedded WHOLE (uncapped
  chunking — all of a long doc is searchable, not just the first ~6 chunks). A whole
  wiki can default to full (`full: true` at the layout root) and a single leaf can
  force it (`memory.full: true` in its frontmatter). Precedence: leaf > category >
  wiki-default > false. Omitting `full` everywhere = today's exact behavior.
- **(tool) `absorb_document`** — a new MCP write tool that absorbs ONE inline markdown
  document (`write:{ text, name, category, metadata?, dryRun? }`) into a facet-placed
  category as a full leaf; the model infers `area`/`subject`, you override via
  `write.metadata`. Refuses gated (`self_improvement`) + topology (`issues`)
  categories. (Tool count is not hardcoded anywhere — no bump needed.)
- **(CLI) `cli.mjs absorb <path…>`** — the filesystem/batch entry: absorb a file, a
  directory tree, or a `*`/`**` glob. Flags are **equals-form**:
  `--category=<name>` (required), repeatable `--match=<glob>` (default markdown),
  `--area=`/`--subject=`/`--atom-type=` (batch-wide overrides), `--target=<selector>`
  (default: the brain/local wiki), `--dry-run`. Files are processed sequentially and
  continue-on-error; the leaf name is derived from the source path (re-absorb is
  idempotent).
- **(template) the shared `repo` layout is now a FULL-doc team wiki.** Its `knowledge`
  category is `full: true`, nests subject-ONLY two levels deep
  (`knowledge/<domain>/<subtopic>`; no `atom_type` folder), over a UNIVERSAL team
  `subject_domains` vocabulary (architecture, product, operations, data, security,
  process, onboarding, integrations, decisions, reference, general). **Existing
  shared wikis keep their own committed `layout.yaml`** — only NEWLY seeded ones get
  the new template. The private `default` layout is byte-unchanged.
- **(config) new `embed.chunk.fullMaxChunks` (256) + `embed.chunk.fullPenalty` (0)**
  in `settings.yaml`. Omit them to accept the defaults.
- **(on-disk, additive) `memory.full: true`** now round-trips in leaf frontmatter. An
  older engine reads such a leaf fine (it just ignores the flag); only `validate_layout`
  on an OLD engine would flag the new `full:` layout key as unknown.

## PROCEDURE

1. Standard update against the runtime clone:
   ```
   cd ~/.llm-wiki-memory/src
   git fetch origin && git merge --ff-only origin/main && npm install
   ```
2. **RESTART your MCP client** (Claude Code / Cursor / Codex / Claude Desktop) so the
   server registers the `absorb_document` tool and the full-aware scorer.
3. **No data migration.** Existing leaves are untouched. `full` only takes effect for a
   category/leaf you explicitly mark; absorbed leaves get `memory.full` on write.
4. (optional) To make an EXISTING shared wiki full-doc, edit its committed
   `wiki/.layout/layout.yaml`: add `full: true` to the `knowledge` category (and, if you
   want subject-only nesting, set `placement_facets: [subject]` + refresh
   `subject_domains`). Run `node scripts/cli.mjs validate-layout <wiki>/.layout/layout.yaml`
   and commit it. This is a choice, not required.

## DECISIONS

- **Which categories should be full?** Only whole-document ones. Leave the private
  brain's `knowledge`/`self_improvement` atomic (the default) — the capture pipeline
  targets only those and never writes a full category anyway.
- **Absorb into a shared repo?** ASK the user, then pass `--target=<repo selector>`
  (CLI) or `target: "<repo>"` (MCP). A shared absorb only STAGES the leaves — the
  engine runs no git — so tell the user to commit + push them.
- **Absorb a whole directory?** Use the CLI (it reads the filesystem). Dry-run first
  (`--dry-run`), confirm the file→placement table, then run for real. The MCP tool is
  for ONE inline document only (it does not read paths).
- **Custom full ceiling?** `embed.chunk.fullMaxChunks` bounds a pathological huge file;
  raise it only if a real document exceeds ~120k tokens. `fullPenalty` should stay 0.

## VERIFICATION

- `absorb_document` is registered: it appears in your client's tool list after restart.
- Absorb a doc and confirm it's full + verbatim:
  ```
  node scripts/cli.mjs absorb /path/to/doc.md --category=knowledge --dry-run   # shows the proposed dir
  ```
  After a real run, the leaf's frontmatter has `memory:\n  full: true` and its body is
  the source document unchanged.
- New `repo` template: `node scripts/cli.mjs validate-layout examples/layouts/repo/layout.yaml`
  → "layout valid"; a fresh `mount-init` seeds `placement_facets: [subject]` + `full: true`.
- The private `default` layout is byte-unchanged; existing shared wikis keep their
  committed layout.
- `node scripts/cli.mjs doctor` is clean; `npm run gates` (in the src clone) is green.

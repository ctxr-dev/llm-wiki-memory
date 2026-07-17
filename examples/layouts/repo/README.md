# repo layout

A shared, repo-tracked brain: a single `knowledge` category, owned by the
consuming repository and committed by the user, so everyone who clones the repo
inherits its knowledge. Its leaves are **full** — whole documents stored
verbatim and embedded whole — which is what makes it the natural home for
`absorb` (importing existing markdown files as-is).

## When to use

Pick this template when the memory should be SHARED across a team through the
project's own git history, rather than living only in one developer's private
brain, AND when the knowledge is WHOLE DOCUMENTS (design docs, RFCs, runbooks,
onboarding guides) rather than short distilled atoms. Federation mounts it as a
wiki root beside the private brain; `scripts/mount-init.mjs` wires the mount's
git surfaces (a negated `.gitignore` that tracks only the shared category, a
private personal git repo, and a chained sync-embeddings hook). The engine never
commits a repo-owned category itself (R11) — the user commits it with the rest
of the project.

## What it adds beyond default

- Exactly ONE category, `knowledge`, marked `ownership: repo`.
- `full: true` — every leaf is stored VERBATIM (never shortened into an atomic
  note) and embedded WHOLE (all of it searchable, not just the first ~6 chunks).
- No `self_improvement` / `plans` / `investigations` / `daily` categories — a
  shared repo brain holds durable, whole-document knowledge only.

## Nesting (subject-only, 2 levels)

`knowledge/<domain>/<subtopic>/<leaf>.md` — `subject` is the ONLY path facet.
There is no `atom_type` folder (a whole document is not a typed atom), so every
path segment after `knowledge` IS subject and the path inverts trivially.
`subject` is broad→narrow, capped at two segments (a domain + an optional
subtopic).

Path examples:

- `subject: [architecture, payments]`
  -> `knowledge/architecture/payments/<leaf>.md`
- `subject: [operations]`
  -> `knowledge/operations/<leaf>.md`
- `subject` absent -> `knowledge/general/<leaf>.md`

## Caller contract

- `subject`: a broad→narrow array (or `/`-joined string), ideally ≤2 segments.
  The FIRST segment must be one of the `subject_domains` vocabulary declared in
  `layout.yaml` (a UNIVERSAL team vocabulary: architecture, product, operations,
  data, security, process, onboarding, integrations, decisions, reference,
  general); an out-of-vocabulary first segment is remapped to `general` on the
  write/absorb path, and a deep placement with no valid domain fails loud.
- `atom_type`: optional — kept in frontmatter for filtering, but it does NOT
  shape the tree.

## When NOT to use

- For a private, per-developer brain that should stay out of the repo — use the
  `default` template (gitignored install, atomic distilled notes).
- When you need lessons, plans, investigations, dailies, or a tracker `issues`
  tree — use `default` or `tracker-issues`. This template is knowledge-only by
  design.

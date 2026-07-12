# repo layout

A shared, repo-tracked brain: a single `knowledge` category, owned by the
consuming repository and committed by the user, so everyone who clones the repo
inherits its knowledge.

## When to use

Pick this template when the memory should be SHARED across a team through the
project's own git history, rather than living only in one developer's private
brain. Federation (Phase G) mounts it as a wiki root beside the private brain;
`scripts/mount-init.mjs` wires the mount's git surfaces (a negated `.gitignore`
that tracks only the shared category, a private personal git repo, and a chained
sync-embeddings hook). The engine never commits a repo-owned category itself
(R11) — the user commits it with the rest of the project.

## What it adds beyond default

- Exactly ONE category, `knowledge`, marked `ownership: repo`.
- No `self_improvement` / `plans` / `investigations` / `daily` categories — a
  shared repo brain holds durable knowledge only.

## Nesting (subject-first)

`knowledge/<subject…>/<atom_type>/<leaf>.md` — the mirror of the default layout,
which leads with `area`/`atom_type` and trails `subject`. A repo brain has one
implicit area (the repo), so leading with the semantic `subject` axis keeps the
tree tidy.

Path examples:

- `subject: [frameworks, react]`, `atom_type: pattern-gotcha`
  -> `knowledge/frameworks/react/pattern-gotcha/<leaf>.md`
- `subject: [languages, scala, cats-effect]`, `atom_type: reference`
  -> `knowledge/languages/scala/cats-effect/reference/<leaf>.md`
- `subject` absent -> `knowledge/general/<atom_type>/<leaf>.md`

The trailing `atom_type` is a single fixed segment, so the path inverts
unambiguously over a variable-depth subject (last segment is `atom_type`,
everything before it is the subject array).

## Caller contract

- `subject`: a broad->narrow array (or `/`-joined string). The FIRST segment
  must be one of the `subject_domains` vocabulary declared in `layout.yaml`; an
  out-of-vocabulary first segment is remapped to `general` on the write path,
  and a deep placement with no valid domain fails loud.
- `atom_type`: the leaf-tier segment (e.g. `pattern-gotcha`, `reference`).

## When NOT to use

- For a private, per-developer brain that should stay out of the repo — use the
  `default` template (gitignored install).
- When you need lessons, plans, investigations, dailies, or a tracker `issues`
  tree — use `default` or `tracker-issues`. This template is knowledge-only by
  design.

# Layout templates

Each folder in this directory is a **layout template** — a complete
`layout.yaml` plus any sibling helper files (`.mjs` path compilers,
README) describing when to choose it.

During installation (or any time later), copy the WHOLE template folder
into the wiki:

```bash
cp -r examples/layouts/<name>  <wiki-root>/layout
node scripts/cli.mjs validate-layout
```

Everything that defines the layout lives inside the resulting
`<wiki-root>/layout/` folder — the contract YAML and its sibling helpers
are next to each other. No symlinks, no second copy at the wiki root.
The skill (`skill-llm-wiki`) recognises this canonical location natively;
the older `<wiki-root>/.llmwiki.layout.yaml` placement still works as a
fallback for pre-existing wikis.

Then bootstrap or rebuild the wiki as usual.

## Available templates

| Template | Best for | Adds beyond default |
|---|---|---|
| [`default/`](./default/README.md) | A fresh install with no custom topology requirements. The historical 5 categories: knowledge, self_improvement, plans, investigations, daily. | (baseline) |
| [`tracker-issues/`](./tracker-issues/README.md) | Workspaces that track issues in Jira, GitHub, Linear, ZenDesk, or any prefix-`N`-style tracker. Adds a deterministic digit-bucketed `issues/<TRACKER>/<PREFIX>/<thousands>/<hundreds_tens>/<units>/...` tree with optional lifecycle subfolders for plans. | `issues` category with the `tracker-issue` topology helper |

## Authoring a new template

1. Create a new folder under `examples/layouts/<name>/`.
2. Add `layout.yaml` (a complete layout file).
3. Add `README.md` covering:
   - **When to use** — one-line summary + a paragraph of trade-offs.
   - **What it adds** — bullet list of new categories / topologies.
   - **Path examples** — concrete paths your topology produces.
   - **Caller contract** — which facets callers must supply on writes.
   - **When NOT to use** — disclaimers / limits.
4. Run `node scripts/cli.mjs validate-layout examples/layouts/<name>/layout.yaml`
   and make sure it exits 0. The same validator runs in CI. The validator
   also accepts a wiki root (it will discover the contract automatically),
   so post-install `validate-layout` against your wiki just works.

The README is the file an LLM (or a human) reads during install to match the
right template to a workspace, so write it tightly and concretely. No prose
rules — use structured fields in the YAML for anything the runtime needs.

## Validator

`node scripts/cli.mjs validate-layout [path]` parses the YAML, checks it
against the layout schema, and prints any errors as
`<file>:<line>:<col>  [<json-path>]  <message>`. Exit code is `0` on success,
`2` on validation failure. With no `path`, it discovers and validates the
live wiki's contract (canonical `<wikiRoot>/layout/layout.yaml`, with
legacy fallbacks to `<wikiRoot>/layout/.llmwiki.layout.yaml` and
`<wikiRoot>/.llmwiki.layout.yaml`).

# Layout templates

Each folder in this directory is a **layout template** — a complete
`.llmwiki.layout.yaml` file plus a `README.md` describing when to choose it.

During installation (or any time later), copy the template you want into the
wiki root:

```bash
cp examples/layouts/<name>/.llmwiki.layout.yaml <wiki-root>/.llmwiki.layout.yaml
node scripts/cli.mjs validate-layout <wiki-root>/.llmwiki.layout.yaml
```

Then bootstrap or rebuild the wiki as usual.

## Available templates

| Template | Best for | Adds beyond default |
|---|---|---|
| [`default/`](./default/README.md) | A fresh install with no custom topology requirements. The historical 5 categories: knowledge, self_improvement, plans, investigations, daily. | (baseline) |
| [`tracker-issues/`](./tracker-issues/README.md) | Workspaces that track issues in Jira, GitHub, Linear, ZenDesk, or any prefix-`N`-style tracker. Adds a deterministic digit-bucketed `issues/<TRACKER>/<PREFIX>/<thousands>/<hundreds_tens>/<units>/...` tree with optional lifecycle subfolders for plans. | `issues` category with the `tracker-issue` topology helper |

## Authoring a new template

1. Create a new folder under `examples/layouts/<name>/`.
2. Add `.llmwiki.layout.yaml` (a complete layout file).
3. Add `README.md` covering:
   - **When to use** — one-line summary + a paragraph of trade-offs.
   - **What it adds** — bullet list of new categories / topologies.
   - **Path examples** — concrete paths your topology produces.
   - **Caller contract** — which facets callers must supply on writes.
   - **When NOT to use** — disclaimers / limits.
4. Run `node scripts/cli.mjs validate-layout examples/layouts/<name>/.llmwiki.layout.yaml`
   and make sure it exits 0. The same validator runs in CI.

The README is the file an LLM (or a human) reads during install to match the
right template to a workspace, so write it tightly and concretely. No prose
rules — use structured fields in the YAML for anything the runtime needs.

## Validator

`node scripts/cli.mjs validate-layout [path]` parses the YAML, checks it
against the layout schema, and prints any errors as
`<file>:<line>:<col>  [<json-path>]  <message>`. Exit code is `0` on success,
`2` on validation failure. With no `path`, it validates the live wiki's
`<wikiRoot>/.llmwiki.layout.yaml`.

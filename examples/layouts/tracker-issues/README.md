# `tracker-issues` layout

Extends the default 5 categories with a deterministic, digit-bucketed tree
for issues tracked in Jira, GitHub, Linear, ZenDesk, or any system with a
`{PREFIX}-{N}` issue-key shape.

## When to use

Your workspace already (or will soon) accumulate per-issue knowledge and
plans. You want:

- O(1) lookup by issue key — paths are computed deterministically from the
  number, so given `DEV-129957` you immediately know the file lives at
  `issues/JIRA/DEV/129/95/7/DEV-129957.md`.
- Folders stay balanced as you scale — digit bucketing caps any one folder's
  fan-out at ~100 issues even at 100k+ issues per tracker.
- A clean place for plan files attached to issues, with lifecycle subfolders
  (`pending/in-progress/done/archived/`) reflecting status from a single
  glance.

## What it adds

A sixth category, `issues/`, with a `caller_path` topology and a structured
schema (no prose rules) that the generic
[`topology-runtime`](../../../scripts/lib/topology-runtime.mjs) helper
applies at runtime. The digit-bucket path math lives in this template's
sibling `to_path.mjs` / `from_path.mjs` files — the runtime is generic
across topologies.

Two file kinds:

- **`knowledge`** — one per issue. Path:
  `issues/<TRACKER>/<PREFIX>/<thousands>/<hundreds_tens>/<units>/<PREFIX>-<N>.md`
- **`plan`** — zero or more per issue. Path:
  `issues/<TRACKER>/<PREFIX>/<thousands>/<hundreds_tens>/<units>/<lifecycle>/<PREFIX>-<N>-<slug>.plan.md`

The digit buckets are computed deterministically from the issue number:

```
thousands     = floor(number / 1000)
hundreds_tens = floor((number % 1000) / 10)
units         = number % 10
```

| Issue | thousands | hundreds_tens | units |
|---|---|---|---|
| `DEV-1` | 0 | 0 | 1 |
| `DEV-42` | 0 | 4 | 2 |
| `DEV-957` | 0 | 95 | 7 |
| `DEV-129957` | 129 | 95 | 7 |
| `DEV-1234567` | 1234 | 56 | 7 |

The skill's native `index.md` generator auto-runs at every level of the
tree on each write, so navigation across the issue tree works without any
custom scaffolding.

## Caller contract

Callers write through the MCP `write_memory` / `save_to_dataset` tools (or
`writeMemory()` / `saveDocument()` libs) using the optional `path` parameter
as the placementOverride. Don't compute paths by hand — load the topology
and let the generic runtime execute the `path_compiler` declared in this
YAML:

```javascript
import { loadTopology, pathFor } from "llm-wiki-memory/topology-runtime";

const topo = await loadTopology(wikiRoot);

const knowledgePath = pathFor(topo, "knowledge", {
  tracker: "JIRA",
  prefix: "DEV",
  number: 129957,
});
// -> "issues/JIRA/DEV/129/95/7/DEV-129957.md"

const planPath = pathFor(topo, "plan", {
  tracker: "JIRA",
  prefix: "DEV",
  number: 129957,
  lifecycle: "in-progress",
  slug: "investigate-timeout",
});
// -> "issues/JIRA/DEV/129/95/7/in-progress/DEV-129957-investigate-timeout.plan.md"
```

Then pass the **directory** (path minus the trailing filename) as the
`path` parameter on the MCP tool, with the leaf's basename as `name`.

The digit-bucket math lives in this YAML's `path_compiler` (sandboxed
inline JS), not in the runtime — the runtime is generic across topologies.
See [`../PROTOCOL.md`](../PROTOCOL.md) for the full schema, the sandbox
rules, and the `path_compiler_file` alternative for moving logic into a
sibling .mjs file.

## Required facets

| Facet | Type | Used by | Notes |
|---|---|---|---|
| `tracker` | string | both | Used verbatim as a directory segment; pick a stable identifier per tracker system (`JIRA`, `GITHUB`, `LINEAR`, …) |
| `prefix` | string | both | Tracker-specific project key (Jira project, github `org-repo` slug, etc.) |
| `number` | integer ≥ 1 | both | The numeric portion of the issue key |
| `lifecycle` | enum | `plan` only | One of `pending`, `in-progress`, `done`, `archived` |
| `slug` | string `^[A-Za-z0-9-]+$` | `plan` only | Plan title slug; distinguishes multiple plans per issue |

## Path examples

```
issues/JIRA/DEV/129/95/7/DEV-129957.md
issues/JIRA/DEV/129/95/7/in-progress/DEV-129957-investigate-timeout.plan.md
issues/JIRA/DEV/129/95/7/done/DEV-129957-add-circuit-breaker.plan.md
issues/GITHUB/my-org-my-repo/0/4/2/my-org-my-repo-42.md
issues/LINEAR/ENG/1/23/4/ENG-1234.md
```

## When NOT to use

- Your tracker keys don't fit the `{PREFIX}-{N}` shape (e.g. UUID-based
  Notion, ULID-based linear-but-without-integers). For those, write a
  sibling helper (e.g. `topologies/uuid-issue.mjs`) following the same
  pattern.
- You have a single, monolithic issue store with no need for tree
  navigation. The default `investigations/` category is simpler.

## Install

```bash
cp -r examples/layouts/tracker-issues  <wiki-root>/.layout
node scripts/cli.mjs validate-layout
```

Everything that defines the layout — the contract YAML, the `to_path.mjs`
and `from_path.mjs` helpers, and this README — ends up inside
`<wiki-root>/.layout/` in a single copy. The skill recognises the canonical
`<wiki-root>/.layout/layout.yaml` location natively; no symlinks. The
`issues/` category appears automatically on the first write.

## Reference

- Generic topology runtime: [`scripts/lib/topology-runtime.mjs`](../../../scripts/lib/topology-runtime.mjs)
- Path-compiler sandbox: [`scripts/lib/path-compiler.mjs`](../../../scripts/lib/path-compiler.mjs)
- Protocol spec (this YAML's contract): [`../PROTOCOL.md`](../PROTOCOL.md)
- Tests: [`test/topology-runtime.test.mjs`](../../../test/topology-runtime.test.mjs), [`test/path-compiler.test.mjs`](../../../test/path-compiler.test.mjs)
- Layout validator: `node scripts/cli.mjs validate-layout examples/layouts/tracker-issues/layout.yaml`
- Compiler dry-run: `node scripts/cli.mjs test-path-compiler knowledge tracker=JIRA prefix=DEV number=129957`

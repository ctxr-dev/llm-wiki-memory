# Layout file protocol (`layout.yaml`)

> **Round-trip principle (enforced at runtime).** Every `pathFor(...)` call
> immediately runs `parsePath(...)` against its own output and refuses if
> the recovered facets don't match the input. Compilers MUST be
> **invertible**: if you can't get back the same `{tracker, prefix, number,
> lifecycle, slug}` from the path that `to_path` produced, the topology
> is rejected — no leaf is ever written under an ambiguous path. This is
> defence-in-depth against:
>
> - Ambiguous `from_path` regexes (`[^/]+` matched greedily on a filename
>   containing extra digits could pull the wrong `(\d+)` into `number`,
>   sending `DEV-122648-mirror-apisix-1-and-2.plan.md` to
>   `issues/JIRA/DEV/0/0/1/...` instead of `issues/JIRA/DEV/122/64/8/...`).
> - Compilers that drop or reshape facet values silently.
> - Topologies where two different facet sets produce the same path.
>
> If you see `pathFor: round-trip ...` errors in the logs, fix the
> `from_path` / `path_template` regex (or the `to_path` body) so the
> forward and reverse functions agree. **We never create garbage paths.**



This document is the **machine-checkable contract** for the layout YAML.
Every shipped template (under `examples/layouts/`) and every user wiki must
conform. The validator at `scripts/lib/layout-validator.mjs` enforces it; the
runtime at `scripts/lib/topology-runtime.mjs` executes it.

## Top-level shape

```yaml
mode: hosted                       # informational; mirrors the skill's mode
versioning:                        # informational; skill-managed
  style: in-place
  backup_before_mutate: false
purpose: "..."                     # human description (optional)
layout:                            # REQUIRED, non-empty list of LayoutEntry
  - path: ...
    ...
```

Unknown top-level keys are tolerated. Unknown keys inside a `LayoutEntry` are
REJECTED with a precise line:col by the validator — typos surface as errors,
not silent ignores.

## LayoutEntry

```yaml
- path: <safe-dir-name>            # REQUIRED, single safe segment
                                   #   ^[a-zA-Z0-9_-]+$
  purpose: "..."                   # optional human description
  placement_facets: [<key>, ...]   # optional; for the historical facet-based
                                   #   categories (knowledge / self_improvement
                                   #   / plans / investigations). Each leaf
                                   #   nests under these facets in order.
  placement_strategy: daily-date   # optional; the only recognised value is
                                   #   `daily-date` (used by the `daily`
                                   #   category to nest by yyyy/mm/dd)
  allow_entry_types: [primary]     # forwarded to skill-llm-wiki validate
  max_depth: 5                     # forwarded to skill-llm-wiki validate
  topology:                        # optional — see below
    ...
```

A LayoutEntry can use `placement_facets`, `placement_strategy: daily-date`,
or `topology:` to control where leaves land. These are mutually exclusive in
practice (a `topology` block supersedes the others if present).

## Topology block (custom-topology categories)

```yaml
topology:
  strategy: caller_path            # REQUIRED. The only recognised value
                                   #   today. Other strategies may land in
                                   #   future skill versions.
  helper:                          # REQUIRED. Identifies the runtime that
                                   #   knows how to load and execute this
                                   #   topology. For the bundled runtime,
                                   #   use:
    module: scripts/lib/topology-runtime.mjs
    package: llm-wiki-memory       # informational; helps external consumers
                                   #   resolve the helper as an npm import
    schema_version: 1
  file_kinds:                      # REQUIRED, non-empty map of FileKind
    <name>:
      ...
  facet_inputs:                    # optional; per-facet contract for the
                                   #   facets callers supply at write time
    <facet>:
      type: string|integer
      minimum: 1                   # for integer facets
      pattern: "^...$"             # for string facets
      description: "..."           # optional
      examples: ["..."]            # optional
```

## FileKind

Exactly ONE of the three forward mechanisms is required. The validator
rejects a FileKind that declares none, and one that declares more than one.

```yaml
<file_kind_name>:
  required_facets: [<key>, ...]    # REQUIRED, non-empty
  enums:                           # optional
    <facet>: [<value>, ...]
  # --- forward (facets -> relative path), pick ONE ---
  path_template: "issues/{var}.md" # simple string substitution. All vars
                                   #   must appear in facet_inputs.
  to_path: |                       # inline sandboxed JS (see "Path
    function to_path(facets) { ... }
                                   #   compiler protocol" below)
  to_path_file: ./layout/...mjs    # sibling .mjs file (preferred default)
  # --- reverse (relative path -> facets), pick AT MOST ONE ---
  from_path: |                     # inline sandboxed JS
    function from_path(rel) { ... }
  from_path_file: ./layout/...mjs  # sibling .mjs file
```

Reverse is optional. If absent, `parsePath()` falls back to deriving a regex
from `path_template`. If neither a reverse function nor a `path_template`
is supplied, `parsePath()` returns `null` for paths of this kind.

## Path compiler protocol

A path compiler is a JS function with one of these signatures:

```ts
// Forward
type ForwardCompiler = (facets: Record<string, string|number>) => string;

// Reverse
type ParseCompiler = (relPath: string) =>
  | Record<string, string|number>
  | null;
```

### Inline source (`to_path`, `from_path`)

The YAML value is multi-line JS source. Two accepted shapes:

**Named function declaration** — preferred when the body needs multiple
statements:

```yaml
to_path: |
  function to_path({ tracker, prefix, number }) {
    const n = Number(number);
    return `issues/${tracker}/${prefix}/${prefix}-${n}.md`;
  }
```

The function MUST be named `to_path` (for forward) or `from_path` (for
reverse). Other names are not recognised.

**Arrow expression** — preferred for one-liners:

```yaml
to_path: |
  ({ tracker, prefix, number }) =>
    `issues/${tracker}/${prefix}/${prefix}-${number}.md`
```

### Sandboxing

Inline compilers run in a `vm.createContext()` sandbox. Available globals:

```
Math, String, Number, Boolean, Array, Object, JSON, RegExp, Date
```

Everything else (`require`, `process`, `globalThis`, `Buffer`, `console`,
`setTimeout`, `fs`, …) returns `undefined`. The compiler is pure-JS and
cannot reach the host filesystem, network, or environment.

`codeGeneration.strings` is disabled in the sandbox: the compiler cannot
build new code with `eval()` / `new Function()` from inside.

### Sibling-file source (`to_path_file`, `from_path_file`) — the default

The value is a path relative to the wiki root (where the layout YAML lives).
By convention the files live in a `layout/` subfolder so that copying an
example template into a wiki is a single `cp -a` of both the YAML and the
helper subfolder:

```
wiki/
├── layout.yaml          # references ./layout/to_path.mjs etc.
└── layout/
    ├── to_path.mjs               # one file per direction, multiple kinds
    └── from_path.mjs
```

Each `.mjs` file is a normal Node module. The loader picks an export in
this order:

1. **Named export matching the file_kind name.** Convention: ONE file per
   direction, with ONE named export per file_kind. The same
   `./layout/to_path.mjs` can serve every file_kind by exporting
   `knowledge`, `plan`, etc.
2. **`default` export** (single-purpose files).
3. **Named `to_path` / `from_path` export**.

```javascript
// ./layout/to_path.mjs  (referenced by two file_kinds)
export function knowledge({ tracker, prefix, number }) {
  return `issues/${tracker}/${prefix}/${prefix}-${number}.md`;
}
export function plan({ tracker, prefix, number, lifecycle, slug }) {
  return `issues/${tracker}/${prefix}/${lifecycle}/${prefix}-${number}-${slug}.plan.md`;
}
```

Sibling files are dynamically `import()`-ed by the runtime. Trust level
matches the YAML itself — these are part of the user's configuration tree.
They are NOT sandboxed (the user already controls the config).

A FileKind must declare AT MOST ONE of `to_path` / `to_path_file`, and AT
MOST ONE of `from_path` / `from_path_file`. The validator rejects the
over-specified case.

### Precedence

For the forward direction:
`to_path_file > to_path > path_template`

For the reverse direction:
`from_path_file > from_path > regex_from(path_template)`

## Required-vs-derived facets

Only facets the CALLER supplies need to appear in `facet_inputs` and
`required_facets`. Anything the compiler computes internally (e.g. digit
buckets derived from a `number` facet) is the compiler's business — those
intermediate values do not need to be declared anywhere.

## Validation

```bash
node scripts/cli.mjs validate-layout [path]   # defaults to live wiki
```

Output format:

```
<file>:<line>:<col>  [<json.path>]  <message>
N error(s).
```

Exit code: `0` on success, `2` on validation failure.

The validator catches:
- YAML parse errors with line info
- Unknown keys (strict mode), with the key's location
- Type mismatches (`type: integer` violations, etc.)
- Missing required keys (reported on the parent node's line)
- Out-of-set enum values (`placement_strategy`, `strategy`)
- Empty `required_facets`, empty path templates
- `path_template` without any `{var}` placeholder
- FileKind declaring zero forward mechanisms (or more than one)
- FileKind declaring both `from_path` and `from_path_file`

## Runtime testing

```bash
node scripts/cli.mjs test-path-compiler <file_kind> \
    [--category issues] [--layout <wiki-root>] key=val key=val ...
```

Loads the topology, validates the facets, runs the forward compiler, and
prints the resulting path plus any unresolved `{variable}` placeholders.
Exit code `0` on a clean result, `2` on validation / compile / placeholder
failure.

The MCP tool `test_path_compiler` exposes the same operation to agents:

```json
{
  "file_kind": "knowledge",
  "facets": { "tracker": "JIRA", "prefix": "DEV", "number": 129957 },
  "category": "issues",                    // optional, defaults to "issues"
  "wiki_root": "/path/to/wiki"             // optional, defaults to env-resolved
}
```

Returns:

```json
{
  "ok": true,
  "file_kind": "knowledge",
  "facets": { ... },
  "path": "issues/JIRA/DEV/129/95/7/DEV-129957.md",
  "unresolved_placeholders": [],
  "warnings": []
}
```

On failure, `stage` (`validate_facets` | `compile`) plus `errors[]` /
`error` indicate where in the pipeline the call failed.

## When to use what

| Mechanism | Use when |
|---|---|
| `placement_facets` | Default categories — facet-driven nesting (knowledge / self_improvement / plans / investigations). |
| `placement_strategy: daily-date` | The `daily` category. |
| `path_template` (only) | Topology nests are trivial substitutions of caller-supplied facets — no math, no conditionals. |
| `to_path` / `from_path` (inline) | Quick prototypes; one-liner arrows. Keeps all logic in the YAML for grep-ability. |
| `to_path_file` / `from_path_file` (default, recommended) | Logic is more than a one-liner, deserves its own file with unit tests, and can be shared across file_kinds via named exports. Drop the file into `wiki/layout/`. |

## Index leaf contract (`index.md`)

Every directory that holds leaves carries exactly **one** `index.md` — a thin
navigation node, not a content page. `cli.mjs doctor` checks this contract;
violations surface as `brokenRefs` / `unlisted` / `orphans`.

- **One per directory.** A directory has at most one `index.md`; it is the
  parent every sibling leaf points at.
- **`parents: ["index.md"]`.** Each non-index leaf declares its directory's
  index as its parent. The index itself points at its own parent index (or none
  at the wiki root).
- **Every reference resolves.** A name listed under the index's children (or in
  the engine's index records) must correspond to a leaf that exists on disk. A
  dangling reference is a `brokenRef` — the usual cause is an out-of-band file
  move (a manual `mv`, a `git` operation, or a cloud-sync daemon relocating the
  leaf). See the `cloud-sync-safety` rule.
- **Thin authored zone.** The human-authored part of an index is a short nav
  blurb plus links: keep it under ~2 KB and **free of fenced code blocks** (a
  fence can swallow following list items in some markdown parsers and confuses
  the thin-node heuristic). Substantial content belongs in its own leaf, linked
  from the index — never inlined into it.

`doctor` is layout-derived: it runs the broken-reference check on every
non-topology category and the stray / unlisted / orphan heuristics only on
curated, facet-free categories (it skips topology and `daily-date` categories,
which nest by a compiler / by date rather than by a hand-authored index).

## Filename constraints

A leaf's **filename** is also a URL component (Obsidian `obsidian://open?file=…`
deep-links, web exports, some MCP clients), so keep URI-reserved and
shell-hostile characters OUT of filenames — put the decorative symbols in the
note's `# H1` / `title`, not the filename.

- **Avoid in filenames:** `& # ? % / \ : < > " | *`, control characters, and a
  leading `.` or `..`. An `&` is the worst offender: an `obsidian://` link to
  `Enable & Verify.md` truncates at the `&` and silently opens/creates a blank
  `Enable ` note. (Percent-encoding the `&` as `%26` does NOT help — the issue is
  the raw filename, and a double-encoded link is worse.)
- **Prefer:** spaces or `-` as separators, ASCII words; write `Enable and Verify`,
  not `Enable & Verify`. Deep-links then need only space-encoding (`%20`).
- The engine's `normalizeLeafNamePreservingCase` already throws on
  `[<>:"/\|?*]`, control characters, and `..`; this constraint extends the same
  hygiene to the human-authored Title-Case names that bypass slugification.
- A separator-only `# ===…` ATX heading is treated as decoration, not a title:
  the engine derives the leaf's title from the basename instead, so a divider
  line can't become the note's name.

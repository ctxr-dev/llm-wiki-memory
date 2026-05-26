# Layout file protocol (`.llmwiki.layout.yaml`)

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
  path_compiler: |                 # inline sandboxed JS; see "Path
    function path_template(facets) { ... }
                                   #   compiler protocol" below
  path_compiler_file: ./fn.mjs     # sibling .mjs file with default export
  # --- reverse (relative path -> facets), pick AT MOST ONE ---
  parse_compiler: |                # inline sandboxed JS
    function parse_template(rel) { ... }
  parse_compiler_file: ./fn.mjs    # sibling .mjs file
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

### Inline source (`path_compiler`, `parse_compiler`)

The YAML value is multi-line JS source. Two accepted shapes:

**Named function declaration** — preferred when the body needs multiple
statements:

```yaml
path_compiler: |
  function path_template({ tracker, prefix, number }) {
    const n = Number(number);
    return `issues/${tracker}/${prefix}/${prefix}-${n}.md`;
  }
```

The function MUST be named `path_template` (for forward) or `parse_template`
(for reverse). Other names are not recognised.

**Arrow expression** — preferred for one-liners:

```yaml
path_compiler: |
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

### Sibling-file source (`path_compiler_file`, `parse_compiler_file`)

The value is a path relative to the wiki root (where the layout YAML lives).
The file is a normal Node `.mjs` module whose default export is the
function:

```javascript
// ./knowledge-path.mjs (sibling of .llmwiki.layout.yaml)
export default function path_template({ tracker, prefix, number }) {
  return `issues/${tracker}/${prefix}/${prefix}-${number}.md`;
}
```

Sibling files are dynamically `import()`-ed by the runtime. Trust level
matches the YAML itself — these are part of the user's configuration tree.
They are NOT sandboxed (the user already controls the config).

A FileKind must declare at most ONE of `path_compiler` / `path_compiler_file`,
and at most ONE of `parse_compiler` / `parse_compiler_file`. The validator
rejects the over-specified case.

### Precedence

For the forward direction:
`path_compiler_file > path_compiler > path_template`

For the reverse direction:
`parse_compiler_file > parse_compiler > regex_from(path_template)`

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
- FileKind declaring both `parse_compiler` and `parse_compiler_file`

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
| `path_compiler` (inline) | Topology needs computed values (digit buckets, encoded ids, etc.). Keep all logic in the YAML for grep-ability. |
| `path_compiler_file` (sibling .mjs) | Compiler is long enough to warrant its own file, has unit tests, or is shared across multiple layouts. |

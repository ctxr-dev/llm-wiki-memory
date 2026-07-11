// topology-runtime — generic loader + executor for custom-topology layouts.
//
// Reads a layout YAML's `topology:` block and prepares each file_kind for
// forward (facets → path) and reverse (path → facets) operation. Forward
// computation is delegated to one of three mechanisms per file_kind, in
// order of precedence:
//
//   to_path_file > to_path > path_template
//
// Reverse computation mirrors this:
//
//   from_path_file > from_path > regex_from(path_template)
//
// The convention (encouraged by both the example layouts and the file
// loader's named-export fallback): the .mjs / inline JS defines a function
// named `to_path` (forward) or `from_path` (reverse), with signature
//   to_path(facets: Record<string, any>) -> string
//   from_path(relPath: string) -> Record<string, any> | null
//
// The runtime is FILE-SYSTEM-PURE after `loadTopology()`; pathFor() and
// parsePath() do not touch disk. Generic across any topology: there is no
// hardcoded knowledge of facets like `thousands` / `units` / etc. — that
// logic, if needed, lives in the layout's path_compiler.
//
// API:
//   loadTopology(wikiRoot, opts?) -> Promise<Topology>
//   pathFor(topology, kind, facets) -> string
//   parsePath(topology, relPath) -> { kind, facets } | null
//   validateFacets(topology, kind, facets) -> { ok, errors }
//
// Lower-level escape hatches (re-exported from path-compiler.mjs):
//   compileInlineFunction, loadCompilerFile, findUnresolvedPlaceholders
//
// This module is a barrel: the implementation lives in cohesive siblings
// (topology-cache / topology-loader / topology-validate / topology-parse /
// topology-forward). The public surface below is the stable import contract
// consumed by @ctxr/skill-llm-wiki and the tracker-issues helpers.

export {
  compileInlineFunction,
  loadCompilerFile,
  findUnresolvedPlaceholders,
  PathCompilerError,
} from "./path-compiler.mjs";

export { resetTopologyCache, _resetCacheForTests } from "./topology-cache.mjs";

export { loadTopology } from "./topology-loader.mjs";
export { validateFacets } from "./topology-validate.mjs";
export { pathFor } from "./topology-forward.mjs";
export { parsePath } from "./topology-parse.mjs";

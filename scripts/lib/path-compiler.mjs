// path-compiler — sandboxed JS execution for caller-supplied path computers.
//
// A topology can declare its forward (facets → relative path) and reverse
// (relative path → facets) logic inline in YAML, or in a sibling .mjs file:
//
//   path_compiler / parse_compiler          : inline JS source (string)
//   path_compiler_file / parse_compiler_file: relative path to an .mjs file
//                                             whose default export is the
//                                             function
//
// Inline source MUST evaluate to a function. Two accepted shapes:
//
//   (1) Named function declaration:
//         function path_template(facets) { ... return string; }
//         // Anything else may follow, but `path_template` must end up bound
//         // to a function in the evaluation scope.
//
//   (2) Arrow function expression:
//         (facets) => `issues/${facets.tracker}/...`
//
// In both forms the call signature is `fn(facets) -> string` for forward
// compilers, and `fn(relPath) -> { ...facets } | null` for parse compilers.
//
// Inline compilers run in a vm.createContext() sandbox with no `require`,
// `process`, `fs`, `globalThis`, or any other host machinery. The sandbox
// exposes a small whitelist of pure JS globals: Math, String, Number, Boolean,
// Array, Object, JSON, RegExp, Date. A wall-clock timeout (default 1000ms)
// halts pathological inputs.
//
// File-based compilers (`*_compiler_file`) are dynamically `import()`-ed.
// They share trust with the layout YAML itself (both live in the same
// configuration tree), so the import is NOT sandboxed.
//
// This module is a barrel re-exporting the cohesive internals split into
// siblings; the public surface (imported by topology-runtime and the tests)
// is preserved exactly.

export { PathCompilerError } from "./path-compiler-error.mjs";
export { compileInlineFunction } from "./path-compiler-sandbox.mjs";
export { loadCompilerFile } from "./path-compiler-loader.mjs";
export { callForwardCompiler, callParseCompiler } from "./path-compiler-invoke.mjs";
export { findUnresolvedPlaceholders, substituteTemplate } from "./path-compiler-template.mjs";
export { resolveCompiler } from "./path-compiler-resolve.mjs";

/**
 * A user-supplied path compiler. Forward compilers are invoked with a facets
 * object and expected to return a string; parse compilers are invoked with a
 * relative path string and expected to return a facets object (or null). The
 * return value is validated at call time, so it is typed `unknown`.
 * @typedef {(input: unknown) => unknown} CompilerFn
 */

/**
 * @typedef {Object} ForwardResult
 * @property {boolean} ok
 * @property {string | null} path
 * @property {string | null} error
 */

/**
 * @typedef {Object} ParseResult
 * @property {boolean} ok
 * @property {Record<string, unknown> | null} facets
 * @property {string | null} error
 */

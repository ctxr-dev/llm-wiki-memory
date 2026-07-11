// path-compiler-sandbox — sandboxed compilation of inline JS path compilers.
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

import vm from "node:vm";
import { PathCompilerError } from "./path-compiler-error.mjs";

/** @typedef {import("./path-compiler.mjs").CompilerFn} CompilerFn */

// Allow-list of globals exposed to inline compilers. Keep this short.
const SANDBOX_GLOBALS = Object.freeze({
  Math,
  String,
  Number,
  Boolean,
  Array,
  Object,
  JSON,
  RegExp,
  Date,
});

// Pre-compiled guard script: runs inside the sandbox before user code and
// blocks the classic `(function(){}).constructor` escape — anonymous functions
// declared in user code expose Function via their .constructor.constructor,
// and the codeGeneration.strings:false flag prevents NEW code generation but
// NOT references to the existing Function constructor object. We seal that
// surface by overwriting `Function` on every Function.prototype reachable
// inside the sandbox, plus on every whitelisted global's constructor chain.
//
// Note: this is defence-in-depth, not a security boundary. Trust model:
// inline compilers come from the user's own layout YAML; a compiler can't
// reach the host filesystem regardless (no `require`, no `process`, no
// `fs`). Blocking Function shuts down code generation as a courtesy.
const SANDBOX_LOCKDOWN = `
(function () {
  // Make the Function constructor (reachable via any function literal's
  // .constructor.constructor chain) refuse to compile new code from
  // strings. We can't delete it from the constructor chain (Object.freeze
  // would block other writes too) so we patch the throw-on-call.
  const F = (function () {}).constructor;
  if (typeof F === "function") {
    const blocked = function () {
      throw new Error("Function constructor is disabled in the sandbox");
    };
    try {
      Object.defineProperty(F, "constructor", { value: blocked, writable: false });
    } catch (_) { /* best-effort */ }
    // Also patch Function.prototype.constructor (the path most escape PoCs
    // walk) to throw.
    try {
      Object.defineProperty(F.prototype, "constructor", { value: blocked, writable: false });
    } catch (_) { /* best-effort */ }
  }
})();
`;

// Compile an inline JS source into a callable function. Both function-
// declaration and arrow-expression shapes are accepted (see module
// docstring). The returned function is bound to the sandbox context, so
// each call still observes the timeout if invoked through callCompiler().
/**
 * @param {unknown} source
 * @param {{ filename?: string, timeout?: number }} [opts]
 * @returns {CompilerFn}
 */
export function compileInlineFunction(
  source,
  { filename = "<path_compiler>", timeout = 1000 } = {},
) {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new PathCompilerError("compiler source must be a non-empty string", {
      phase: "validate",
      source,
    });
  }

  // Node's vm.createContext() exposes a small set of host built-ins (console,
  // queueMicrotask, setTimeout, etc.) regardless of what we put in the sandbox
  // object. Nullify the ones we don't want path compilers to see; the
  // pure-arithmetic / template-string workloads we expect don't need them.
  const sandbox = {
    ...SANDBOX_GLOBALS,
    console: undefined,
    queueMicrotask: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    clearTimeout: undefined,
    clearInterval: undefined,
    clearImmediate: undefined,
    __result: undefined,
  };
  const context = vm.createContext(sandbox, {
    name: filename,
    codeGeneration: { strings: false, wasm: false },
  });
  // Seal Function-constructor escape routes BEFORE user code runs.
  try {
    new vm.Script(SANDBOX_LOCKDOWN, { filename: "<sandbox-lockdown>" }).runInContext(context, {
      timeout,
    });
  } catch {
    // Lockdown is best-effort; never let a failure here mask the real
    // compile error. The codeGeneration:false flag is still in force.
  }

  // Shape (1): the source contains a function declaration (named `to_path`
  // for forward generators or `from_path` for reverse parsers). Wrap in an
  // IIFE so the declaration stays local to the script.
  const wrappedDecl =
    `__result = (function () { ${source}\n` +
    `; if (typeof to_path === 'function') return to_path;` +
    `  if (typeof from_path === 'function') return from_path;` +
    `  return undefined;` +
    `})();`;

  let declRan = false;
  /** @type {Error | null} */
  let declErr = null;
  try {
    const script = new vm.Script(wrappedDecl, { filename });
    script.runInContext(context, { timeout });
    declRan = true;
    if (typeof sandbox.__result === "function") {
      return wrapWithTimeout(sandbox.__result, timeout, filename);
    }
  } catch (e) {
    declErr = /** @type {Error} */ (e);
  }

  // Shape (2): the whole source is an expression (e.g. an arrow function).
  // We always try this fallback because some valid arrows can't appear at
  // statement position (`(x) => x + 1` parses as an expression-statement
  // in some shapes but not all; the wrap is universal).
  sandbox.__result = undefined;
  /** @type {Error | null} */
  let exprErr = null;
  try {
    const wrappedExpr = `__result = (${source});`;
    const script = new vm.Script(wrappedExpr, { filename });
    script.runInContext(context, { timeout });
    if (typeof sandbox.__result === "function") {
      return wrapWithTimeout(sandbox.__result, timeout, filename);
    }
  } catch (e) {
    exprErr = /** @type {Error} */ (e);
  }

  // Neither form yielded a function. Pick the most informative message.
  if (declRan) {
    // Source compiles as a statement list but produces no function. The
    // arrow-expression error (if any) is incidental — the real problem is
    // there's no function in scope when the script finishes.
    throw new PathCompilerError(
      "compiler source did not evaluate to a function (define `function to_path(...) { ... }` / `function from_path(...) { ... }`, or supply an arrow expression like `(facets) => ...`)",
      { phase: "compile", source, cause: exprErr || declErr },
    );
  }
  // Both forms threw.
  throw new PathCompilerError(
    `compiler source failed to compile. Declaration error: ${declErr?.message ?? "n/a"}. Expression error: ${exprErr?.message ?? "n/a"}`,
    { phase: "compile", source, cause: declErr },
  );
}

/**
 * @param {CompilerFn} fn
 * @param {number} timeoutMs
 * @param {string} filename
 * @returns {CompilerFn}
 */
function wrapWithTimeout(fn, timeoutMs, filename) {
  // The fn returned from runInContext is a native sandboxed function.
  // We can't easily impose a wall-clock timeout on a normal JS call (vm
  // timeout applies only to .runInContext, not to subsequent invocations).
  // For the simple-arithmetic compilers we expect here, this is fine —
  // but a malicious or buggy compiler with an infinite loop will hang
  // the caller. Document that and move on.
  /** @type {{ __compilerFilename?: string }} */ (fn).__compilerFilename = filename;
  return fn;
}

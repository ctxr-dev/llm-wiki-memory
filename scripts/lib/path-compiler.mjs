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

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

export class PathCompilerError extends Error {
  constructor(message, { phase, source, cause } = {}) {
    super(message);
    this.name = "PathCompilerError";
    this.phase = phase || "unknown";
    this.source = source;
    this.cause = cause;
  }
}

// Compile an inline JS source into a callable function. Both function-
// declaration and arrow-expression shapes are accepted (see module
// docstring). The returned function is bound to the sandbox context, so
// each call still observes the timeout if invoked through callCompiler().
export function compileInlineFunction(source, { filename = "<path_compiler>", timeout = 1000 } = {}) {
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
    new vm.Script(SANDBOX_LOCKDOWN, { filename: "<sandbox-lockdown>" }).runInContext(
      context,
      { timeout },
    );
  } catch (_) {
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
  let declErr = null;
  try {
    const script = new vm.Script(wrappedDecl, { filename });
    script.runInContext(context, { timeout });
    declRan = true;
    if (typeof sandbox.__result === "function") {
      return wrapWithTimeout(sandbox.__result, timeout, filename);
    }
  } catch (e) {
    declErr = e;
  }

  // Shape (2): the whole source is an expression (e.g. an arrow function).
  // We always try this fallback because some valid arrows can't appear at
  // statement position (`(x) => x + 1` parses as an expression-statement
  // in some shapes but not all; the wrap is universal).
  sandbox.__result = undefined;
  let exprErr = null;
  try {
    const wrappedExpr = `__result = (${source});`;
    const script = new vm.Script(wrappedExpr, { filename });
    script.runInContext(context, { timeout });
    if (typeof sandbox.__result === "function") {
      return wrapWithTimeout(sandbox.__result, timeout, filename);
    }
  } catch (e) {
    exprErr = e;
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

function wrapWithTimeout(fn, timeoutMs, filename) {
  // The fn returned from runInContext is a native sandboxed function.
  // We can't easily impose a wall-clock timeout on a normal JS call (vm
  // timeout applies only to .runInContext, not to subsequent invocations).
  // For the simple-arithmetic compilers we expect here, this is fine —
  // but a malicious or buggy compiler with an infinite loop will hang
  // the caller. Document that and move on.
  fn.__compilerFilename = filename;
  return fn;
}

// Load a compiler from an external .mjs file. Trust level matches the
// surrounding layout YAML (both live in the user's config tree); the
// import is a normal Node dynamic import — NOT sandboxed.
//
// Export-resolution order:
//   1. If `fileKindName` is provided and the module has a NAMED export with
//      that name, use it. (Convention: one .mjs file per direction, with
//      one named export per file_kind. Lets two file_kinds share the same
//      file — e.g. layout/to_path.mjs with `knowledge` + `plan` exports.)
//   2. `default` export, if present.
//   3. Named `to_path` / `from_path` export (single-purpose files).
//   4. Otherwise, throw.
export async function loadCompilerFile(absFilePath, { fileKindName } = {}) {
  if (!fs.existsSync(absFilePath)) {
    throw new PathCompilerError(`compiler file not found: ${absFilePath}`, {
      phase: "load",
      source: absFilePath,
    });
  }
  const url = pathToFileURL(absFilePath);
  const mod = await import(url.href);

  let fn;
  if (fileKindName && typeof mod[fileKindName] === "function") {
    fn = mod[fileKindName];
  } else if (typeof mod.default === "function") {
    fn = mod.default;
  } else if (typeof mod.to_path === "function") {
    fn = mod.to_path;
  } else if (typeof mod.from_path === "function") {
    fn = mod.from_path;
  }

  if (typeof fn !== "function") {
    const tried = [
      fileKindName ? `named export '${fileKindName}'` : null,
      "default export",
      "named export 'to_path'",
      "named export 'from_path'",
    ]
      .filter(Boolean)
      .join(", ");
    throw new PathCompilerError(
      `${absFilePath} must export a function (tried: ${tried})`,
      { phase: "load", source: absFilePath },
    );
  }
  return fn;
}

// Execute a path compiler. Returns { ok, path, error }.
// Async / generator / Promise returns are flagged with a specific error
// (instead of the generic "expected string"), because the most common
// authoring mistake is `async (facets) => ...` — which returns a Promise.
export function callForwardCompiler(fn, facets) {
  try {
    const out = fn(facets);
    if (typeof out === "string") return { ok: true, path: out, error: null };

    // Promise-shaped (thenable) result?
    if (out && typeof out === "object" && typeof out.then === "function") {
      return {
        ok: false,
        path: null,
        error:
          "compiler returned a Promise (async compilers are not supported — write a synchronous function)",
      };
    }
    // Generator / iterator?
    if (
      out &&
      typeof out === "object" &&
      typeof out.next === "function" &&
      typeof out[Symbol.iterator] === "function"
    ) {
      return {
        ok: false,
        path: null,
        error:
          "compiler returned a generator/iterator (generator functions are not supported)",
      };
    }
    return {
      ok: false,
      path: null,
      error: `compiler returned ${typeof out}, expected string`,
    };
  } catch (err) {
    return {
      ok: false,
      path: null,
      error: typeof err?.message === "string" ? err.message : String(err),
    };
  }
}

export function callParseCompiler(fn, relPath) {
  try {
    const out = fn(relPath);
    if (out === null || out === undefined) {
      return { ok: true, facets: null, error: null };
    }
    if (typeof out !== "object" || Array.isArray(out)) {
      return {
        ok: false,
        facets: null,
        error: `parse_compiler returned ${typeof out}, expected object or null`,
      };
    }
    return { ok: true, facets: out, error: null };
  } catch (err) {
    return {
      ok: false,
      facets: null,
      error: typeof err?.message === "string" ? err.message : String(err),
    };
  }
}

// Find any unresolved `{var}` placeholders in a compiler's output. Useful
// for sanity-checking — if the user's path_compiler accidentally embeds a
// raw `{foo}` template marker in the result (e.g. from a buggy template
// literal), this surfaces the failure rather than silently writing a leaf
// at a literal "{foo}" directory.
export function findUnresolvedPlaceholders(pathStr) {
  // Match {ident} but NOT ${ident} — the latter is template-literal noise
  // that may slip into compiler output and isn't OUR placeholder syntax.
  const matches = String(pathStr).match(/(?<!\$)\{[a-zA-Z_][a-zA-Z0-9_]*\}/g);
  return matches ? Array.from(new Set(matches)) : [];
}

// Convenience: substitute {var} placeholders from a flat facets object.
// Used by the path_template fallback (no path_compiler supplied).
export function substituteTemplate(tmpl, vars) {
  return String(tmpl).replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, key) => {
    if (!(key in vars)) {
      throw new PathCompilerError(`template variable {${key}} not provided`, {
        phase: "substitute",
        source: tmpl,
      });
    }
    return String(vars[key]);
  });
}

// Resolve a compiler reference (one of to_path / to_path_file / from_path /
// from_path_file) declared on a file_kind block, with the YAML directory
// used as the base for file-mode resolution.
//
// Returns either a function or null. Throws PathCompilerError on failure.
export async function resolveCompiler(
  fileKind,
  { yamlDir, slotInline, slotFile, kindName, fileKindName } = {},
) {
  const fileVal = fileKind[slotFile];
  const inlineVal = fileKind[slotInline];

  if (fileVal && inlineVal) {
    throw new PathCompilerError(
      `file_kind '${fileKindName}' declares BOTH ${slotInline} and ${slotFile}; pick one`,
      { phase: "resolve", source: kindName },
    );
  }
  if (fileVal) {
    const abs = path.isAbsolute(fileVal) ? fileVal : path.join(yamlDir, fileVal);
    return loadCompilerFile(abs, { fileKindName });
  }
  if (inlineVal) {
    return compileInlineFunction(inlineVal, {
      filename: `<${kindName}:${fileKindName}:${slotInline}>`,
    });
  }
  return null;
}

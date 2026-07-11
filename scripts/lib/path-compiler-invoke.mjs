// path-compiler-invoke — execute forward / reverse path compilers safely.

/** @typedef {import("./path-compiler.mjs").CompilerFn} CompilerFn */
/** @typedef {import("./path-compiler.mjs").ForwardResult} ForwardResult */
/** @typedef {import("./path-compiler.mjs").ParseResult} ParseResult */

// Execute a path compiler. Returns { ok, path, error }.
// Async / generator / Promise returns are flagged with a specific error
// (instead of the generic "expected string"), because the most common
// authoring mistake is `async (facets) => ...` — which returns a Promise.
/**
 * @param {CompilerFn} fn
 * @param {Record<string, unknown>} facets
 * @returns {ForwardResult}
 */
export function callForwardCompiler(fn, facets) {
  try {
    const out = fn(facets);
    if (typeof out === "string") return { ok: true, path: out, error: null };

    // Promise-shaped (thenable) result?
    if (
      out &&
      typeof out === "object" &&
      typeof (/** @type {Record<PropertyKey, unknown>} */ (out).then) === "function"
    ) {
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
      typeof (/** @type {Record<PropertyKey, unknown>} */ (out).next) === "function" &&
      typeof (/** @type {Record<PropertyKey, unknown>} */ (out)[Symbol.iterator]) === "function"
    ) {
      return {
        ok: false,
        path: null,
        error: "compiler returned a generator/iterator (generator functions are not supported)",
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
      error:
        typeof (/** @type {Error} */ (err)?.message) === "string"
          ? /** @type {Error} */ (err).message
          : String(err),
    };
  }
}

/**
 * @param {CompilerFn} fn
 * @param {string} relPath
 * @returns {ParseResult}
 */
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
    return { ok: true, facets: /** @type {Record<string, unknown>} */ (out), error: null };
  } catch (err) {
    return {
      ok: false,
      facets: null,
      error:
        typeof (/** @type {Error} */ (err)?.message) === "string"
          ? /** @type {Error} */ (err).message
          : String(err),
    };
  }
}

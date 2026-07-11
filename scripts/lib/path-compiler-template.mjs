// path-compiler-template — `{var}` placeholder helpers for the template
// fallback path (used when no path_compiler is supplied).

import { PathCompilerError } from "./path-compiler-error.mjs";

// Find any unresolved `{var}` placeholders in a compiler's output. Useful
// for sanity-checking — if the user's path_compiler accidentally embeds a
// raw `{foo}` template marker in the result (e.g. from a buggy template
// literal), this surfaces the failure rather than silently writing a leaf
// at a literal "{foo}" directory.
/**
 * @param {unknown} pathStr
 * @returns {string[]}
 */
export function findUnresolvedPlaceholders(pathStr) {
  // Match {ident} but NOT ${ident} — the latter is template-literal noise
  // that may slip into compiler output and isn't OUR placeholder syntax.
  const matches = String(pathStr).match(/(?<!\$)\{[a-zA-Z_][a-zA-Z0-9_]*\}/g);
  return matches ? Array.from(new Set(matches)) : [];
}

// Convenience: substitute {var} placeholders from a flat facets object.
// Used by the path_template fallback (no path_compiler supplied).
/**
 * @param {unknown} tmpl
 * @param {Record<string, unknown>} vars
 * @returns {string}
 */
export function substituteTemplate(tmpl, vars) {
  return String(tmpl).replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, /** @type {string} */ key) => {
    if (!(key in vars)) {
      throw new PathCompilerError(`template variable {${key}} not provided`, {
        phase: "substitute",
        source: tmpl,
      });
    }
    return String(vars[key]);
  });
}

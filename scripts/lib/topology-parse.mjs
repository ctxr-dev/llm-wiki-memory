// topology-parse — reverse direction (relative path → { kind, facets }) plus
// the string-only path_template regex fallback used when no parse_compiler is
// declared.

import path from "node:path";
import { callParseCompiler } from "./path-compiler.mjs";

/** @typedef {import("./topology-loader.mjs").Topology} Topology */
/** @typedef {import("./topology-loader.mjs").Facets} Facets */

/**
 * @param {Topology} topology
 * @param {unknown} relPath
 * @returns {{ kind: string, facets: Facets } | null}
 */
export function parsePath(topology, relPath) {
  // Reject obviously-broken inputs rather than coercing them to "null" /
  // "undefined" strings (which would then "successfully" return null after a
  // useless regex scan).
  if (relPath === null || relPath === undefined || typeof relPath !== "string") {
    return null;
  }
  if (relPath.includes("\0")) return null;
  const norm = relPath.split(path.sep).join("/").replace(/^\/+/, "");

  for (const [kindName, kind] of Object.entries(topology.fileKinds)) {
    // Prefer the explicit parse_compiler[_file] if present.
    if (kind.parseFn) {
      const r = callParseCompiler(kind.parseFn, norm);
      if (r.ok && r.facets) {
        return { kind: kindName, facets: r.facets };
      }
      continue;
    }
    // Fall back to deriving a regex from path_template (substitution).
    if (kind.path_template) {
      const compiled = templateToRegex(kind.path_template);
      const m = compiled.regex.exec(norm);
      if (!m) continue;
      /** @type {Facets} */
      const facets = {};
      compiled.varNames.forEach((name, idx) => {
        facets[name] = m[idx + 1];
      });
      // Coerce known integer facets back to numbers via facet_inputs hints.
      for (const [k, spec] of Object.entries(topology.facetInputs || {})) {
        if (spec.type === "integer" && facets[k] !== undefined) {
          const n = Number.parseInt(/** @type {string} */ (facets[k]), 10);
          if (Number.isFinite(n)) facets[k] = n;
        }
      }
      return { kind: kindName, facets };
    }
  }
  return null;
}

/** @type {Record<string, string>} */
const NUMERIC_VAR_PATTERNS = {
  // Common digit-bucket var names — give them digit-only patterns so
  // dash-rich templates parse unambiguously. This is a HEURISTIC for the
  // path_template fallback only; topologies needing full control should
  // use path_compiler / parse_compiler.
  number: "[0-9]+",
  thousands: "[0-9]+",
  hundreds_tens: "[0-9]+",
  units: "[0-9]+",
};

/**
 * @param {string} tmpl
 * @returns {{ regex: RegExp, varNames: string[] }}
 */
function templateToRegex(tmpl) {
  /** @type {string[]} */
  const varNames = [];
  /** @type {Map<string, number>} */
  const firstIdx = new Map();
  const escaped = String(tmpl).replace(
    /\{([a-zA-Z_][a-zA-Z0-9_]*)\}|([\^$.*+?()|[\]{}\\])/g,
    (_, varName, special) => {
      if (varName) {
        const seen = firstIdx.get(varName);
        if (seen !== undefined) {
          return `\\${seen + 1}`;
        }
        firstIdx.set(varName, varNames.length);
        varNames.push(varName);
        const pattern = NUMERIC_VAR_PATTERNS[varName] || "[^/]+";
        return `(${pattern})`;
      }
      return `\\${special}`;
    },
  );
  return { regex: new RegExp(`^${escaped}$`), varNames };
}

// topology-forward — forward direction (facets → relative path) with the
// round-trip safety check that guarantees every path we emit parses back to
// the caller's facets.

import {
  callForwardCompiler,
  findUnresolvedPlaceholders,
  substituteTemplate,
} from "./path-compiler.mjs";
import { validateFacets } from "./topology-validate.mjs";
import { parsePath } from "./topology-parse.mjs";

/** @typedef {import("./topology-loader.mjs").Topology} Topology */
/** @typedef {import("./topology-loader.mjs").Facets} Facets */

/**
 * @param {Topology} topology
 * @param {string} kindName
 * @param {Facets} facets
 * @param {{ skipRoundTripCheck?: boolean }} [opts]
 * @returns {string}
 */
export function pathFor(topology, kindName, facets, { skipRoundTripCheck = false } = {}) {
  const v = validateFacets(topology, kindName, facets);
  if (!v.ok) {
    throw new Error(`pathFor: invalid facets for kind '${kindName}': ${v.errors.join("; ")}`);
  }

  const kind = topology.fileKinds[kindName];

  // Preference order: pathFn (path_compiler[_file]) > path_template.
  /** @type {string} */
  let out;
  if (kind.pathFn) {
    const r = callForwardCompiler(kind.pathFn, facets);
    if (!r.ok) {
      throw new Error(`pathFor: compiler error for '${kindName}': ${r.error}`);
    }
    const left = findUnresolvedPlaceholders(r.path);
    if (left.length > 0) {
      throw new Error(
        `pathFor: compiler for '${kindName}' returned unresolved placeholders ${JSON.stringify(left)} — the returned path was: ${r.path}`,
      );
    }
    out = /** @type {string} */ (r.path);
  } else if (kind.path_template) {
    out = substituteTemplate(kind.path_template, facets);
  } else {
    throw new Error(`file_kind '${kindName}' has neither to_path, to_path_file, nor path_template`);
  }

  // Round-trip safety check: parse the path we just computed and verify the
  // recovered facets match the input. This catches the "two different
  // facet sets compute to the same path" class of bug (e.g. ambiguous
  // from_path regex with greedy `[^/]+` matchers), as well as compilers
  // that drop or reshape facet values silently. Failing loud here is the
  // explicit principle: we NEVER create a path that doesn't round-trip,
  // even if the forward compiler returns a syntactically valid string.
  if (!skipRoundTripCheck && (kind.parseFn || kind.path_template)) {
    const parsed = parsePath(topology, out);
    if (parsed === null || parsed.kind !== kindName) {
      throw new Error(
        `pathFor: round-trip failure for '${kindName}' — the computed path ${JSON.stringify(out)} does not parse back to a ${kindName} via from_path/regex. Topology compilers must be invertible. See examples/layouts/PROTOCOL.md → "Round-trip principle".`,
      );
    }
    // Strict facet check: every REQUIRED facet the caller supplied must
    // appear in parsed.facets AND match by string-equality. A required
    // facet that's missing from the parse is treated as a round-trip
    // failure — the path doesn't carry enough info to recover the
    // caller's intent, which means two different inputs can produce
    // the same path (the degenerate-topology case).
    for (const required of kind.required_facets || []) {
      const inputVal = facets[required];
      if (inputVal === undefined || inputVal === null || inputVal === "") continue;
      const parsedVal = parsed.facets[required];
      if (parsedVal === undefined || parsedVal === null) {
        throw new Error(
          `pathFor: round-trip failure for '${kindName}' — required facet '${required}' is NOT recovered from the computed path ${JSON.stringify(out)}. The from_path / path_template doesn't carry '${required}' through. See examples/layouts/PROTOCOL.md → "Round-trip principle".`,
        );
      }
      if (String(parsedVal) !== String(inputVal)) {
        throw new Error(
          `pathFor: round-trip mismatch for '${kindName}' facet '${required}' — input=${JSON.stringify(inputVal)}, parsed-back=${JSON.stringify(parsedVal)}. The forward/reverse compilers disagree.`,
        );
      }
    }
    // Soft check: non-required facets that DID survive must also match.
    for (const [k, v] of Object.entries(facets)) {
      if ((kind.required_facets || []).includes(k)) continue;
      if (parsed.facets[k] === undefined) continue;
      if (String(parsed.facets[k]) !== String(v)) {
        throw new Error(
          `pathFor: round-trip mismatch for '${kindName}' optional facet '${k}' — input=${JSON.stringify(v)}, parsed-back=${JSON.stringify(parsed.facets[k])}.`,
        );
      }
    }
  }

  return out;
}

// topology-validate — structural facet validation for a file_kind. Purely
// structural: it never invokes the forward/reverse compilers.

/** @typedef {import("./topology-loader.mjs").Topology} Topology */
/** @typedef {import("./topology-loader.mjs").Facets} Facets */

/**
 * @param {Topology} topology
 * @param {string} kindName
 * @param {Facets} facets
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateFacets(topology, kindName, facets) {
  const kind = topology.fileKinds[kindName];
  if (!kind) {
    return { ok: false, errors: [`unknown file_kind '${kindName}'`] };
  }
  // facets MUST be a plain non-null object. null / primitives / arrays are
  // not valid and would otherwise crash on property access below.
  if (facets === null || typeof facets !== "object" || Array.isArray(facets)) {
    return {
      ok: false,
      errors: [
        `facets must be a plain object; got ${facets === null ? "null" : Array.isArray(facets) ? "array" : typeof facets}`,
      ],
    };
  }
  const errors = [];
  for (const key of kind.required_facets || []) {
    if (facets[key] === undefined || facets[key] === null || facets[key] === "") {
      errors.push(`missing required facet '${key}'`);
    }
  }
  for (const [key, allowed] of Object.entries(kind.enums || {})) {
    if (!Array.isArray(allowed)) {
      errors.push(`enums.${key} must be an array in the layout YAML; got ${typeof allowed}`);
      continue;
    }
    if (facets[key] !== undefined && !allowed.includes(/** @type {string} */ (facets[key]))) {
      errors.push(`facet '${key}' value '${facets[key]}' not in ${JSON.stringify(allowed)}`);
    }
  }
  for (const [key, spec] of Object.entries(topology.facetInputs || {})) {
    if (facets[key] === undefined) continue;
    if (spec.type === "integer") {
      // Reject booleans (typeof "boolean") even though Number(true)===1 would
      // pass the integer check otherwise — silent boolean→int coercion is a
      // bug source, not a feature.
      if (typeof facets[key] === "boolean") {
        errors.push(`facet '${key}' must be an integer; got boolean ${facets[key]}`);
      } else {
        const n = Number(facets[key]);
        if (!Number.isInteger(n) || n < 0) {
          errors.push(
            `facet '${key}' must be a non-negative integer; got ${JSON.stringify(facets[key])}`,
          );
        } else if (typeof spec.minimum === "number" && n < spec.minimum) {
          errors.push(`facet '${key}' must be >= ${spec.minimum}; got ${n}`);
        }
      }
    }
    if (spec.pattern !== undefined) {
      // Pattern MUST be checked on string values; numeric/boolean facets with
      // a pattern declared are a layout-side bug and we surface it explicitly.
      if (typeof facets[key] !== "string") {
        errors.push(
          `facet '${key}' has a pattern but value is ${typeof facets[key]}; pattern requires a string`,
        );
      } else {
        let re;
        try {
          re = new RegExp(spec.pattern);
        } catch (err) {
          errors.push(
            `facet '${key}' pattern is not a valid regex (${/** @type {Error} */ (err).message}); fix the layout YAML`,
          );
          continue;
        }
        if (!re.test(/** @type {string} */ (facets[key]))) {
          errors.push(`facet '${key}' value '${facets[key]}' does not match /${spec.pattern}/`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

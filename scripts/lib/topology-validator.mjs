// topology-validator — pre-flight gate that runs the round-trip check
// against every declared file_kind in a topology, using sample facets
// derived from facet_inputs. Catches BAD layouts at install time (or
// any time the user edits the layout) before any leaf is written.
//
// Public API:
//   validateTopologyAgainstSamples(wikiRoot, opts) ->
//     { ok, perKind: [{kind, ok, error?, samplePath?, sampleFacets}, ...] }
//
// Used by:
//   - `node scripts/cli.mjs validate-topology [wikiRoot]` (CLI surface)
//   - the `validate_topology` MCP tool
//   - tests

import { loadTopology, pathFor } from "./topology-runtime.mjs";

/** @typedef {import("./topology-loader.mjs").Facets} Facets */
/** @typedef {import("./topology-loader.mjs").FacetInputSpec} FacetInputSpec */
/** @typedef {import("./topology-loader.mjs").CompiledFileKind} CompiledFileKind */

/**
 * @typedef {Object} PerKindResult
 * @property {string} kind
 * @property {boolean} ok
 * @property {string | null} error
 * @property {string | null} samplePath
 * @property {Facets} sampleFacets
 */

/**
 * @typedef {Object} TopologyValidationResult
 * @property {boolean} ok
 * @property {PerKindResult[]} perKind
 * @property {string} [error]
 */

// Pick a sample value for a facet based on its facet_inputs spec. If the
// caller passes overrides, those win. The goal is "any valid value that
// the topology will accept" — we're testing the path-compute logic, not
// the value semantics.
/**
 * @param {string} name
 * @param {FacetInputSpec | undefined} spec
 * @param {Record<string, unknown> | undefined} overrides
 * @returns {unknown}
 */
function sampleForFacet(name, spec, overrides) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) {
    return overrides[name];
  }
  if (!spec) return `sample-${name}`;
  if (Array.isArray(spec.examples) && spec.examples.length > 0) return spec.examples[0];
  if (spec.type === "integer") {
    const min = typeof spec.minimum === "number" ? spec.minimum : 1;
    return min;
  }
  if (spec.pattern) {
    // Try a spread of canned values covering the common facet-pattern shapes
    // (slugs, digits, single tokens, alphanumerics). If none match, fall back
    // to a name-derived value; pathFor->validateFacets then reports a precise
    // "value 'X' does not match pattern 'Y'" so the layout author can supply a
    // matching `examples:` entry for that facet.
    const candidates = [
      "sample",
      "sample-slug",
      "a-b-c",
      "sample123",
      "1",
      "42",
      "abc",
      `${name}-sample`,
    ];
    try {
      const re = new RegExp(spec.pattern);
      for (const c of candidates) if (re.test(c)) return c;
    } catch {
      // bad regex — the round-trip check will fail with the runtime
      // error from validateFacets
    }
    return `${name}-sample`;
  }
  return `${name}-sample`;
}

// Pick sample facets for one file_kind. Precedence per required facet:
//   1. caller override (overrides[facet])
//   2. file_kind's enum constraint (first allowed value) — must win over
//      the generic facet_inputs spec, otherwise the sample fails validation
//      against the kind's own enum
//   3. facet_inputs spec (examples / type defaults / pattern)
// Optional facets that have enums also get the first enum value so the
// resulting path is deterministic.
/**
 * @param {CompiledFileKind} kind
 * @param {Record<string, FacetInputSpec>} facetInputs
 * @param {Record<string, unknown> | undefined} overrides
 * @returns {Facets}
 */
function sampleFacetsFor(kind, facetInputs, overrides) {
  /** @type {Facets} */
  const out = {};
  const enums = kind.enums || {};
  const ov = overrides || {};
  for (const req of kind.required_facets || []) {
    if (Object.prototype.hasOwnProperty.call(ov, req)) {
      out[req] = ov[req];
    } else if (Array.isArray(enums[req]) && enums[req].length > 0) {
      out[req] = enums[req][0];
    } else {
      out[req] = sampleForFacet(req, facetInputs[req], ov);
    }
  }
  for (const [k, allowed] of Object.entries(enums)) {
    if (out[k] !== undefined) continue;
    if (Array.isArray(allowed) && allowed.length > 0) out[k] = allowed[0];
  }
  return out;
}

/**
 * @param {string} wikiRoot
 * @param {{ categoryPath?: string, overrides?: Record<string, Record<string, unknown>> }} [opts]
 * @returns {Promise<TopologyValidationResult>}
 */
export async function validateTopologyAgainstSamples(
  wikiRoot,
  { categoryPath = "issues", overrides = {} } = {},
) {
  let topology;
  try {
    topology = await loadTopology(wikiRoot, { categoryPath });
  } catch (err) {
    return {
      ok: false,
      perKind: [],
      error: `loadTopology failed: ${/** @type {Error} */ (err).message}`,
    };
  }

  const perKind = [];
  for (const [kindName, kind] of Object.entries(topology.fileKinds)) {
    const sampleFacets = sampleFacetsFor(kind, topology.facetInputs || {}, overrides[kindName]);
    let samplePath = null;
    let ok = true;
    let error = null;
    try {
      samplePath = pathFor(topology, kindName, sampleFacets);
    } catch (err) {
      ok = false;
      error = /** @type {Error} */ (err).message;
    }
    perKind.push({ kind: kindName, ok, error, samplePath, sampleFacets });
  }
  return {
    ok: perKind.every((k) => k.ok),
    perKind,
  };
}

// Pretty-print for CLI output.
/**
 * @param {TopologyValidationResult} result
 * @returns {string}
 */
export function formatValidationReport(result) {
  if (result.error) {
    return `topology validation failed: ${result.error}\n`;
  }
  const lines = [];
  for (const k of result.perKind) {
    if (k.ok) {
      lines.push(`  ✓ ${k.kind}  → ${k.samplePath}`);
    } else {
      lines.push(`  ✗ ${k.kind}  ${k.error}`);
      lines.push(`      sample facets: ${JSON.stringify(k.sampleFacets)}`);
    }
  }
  const totalOk = result.perKind.filter((k) => k.ok).length;
  const totalFail = result.perKind.length - totalOk;
  lines.push("");
  lines.push(`${totalOk} kind(s) passed, ${totalFail} failed.`);
  return lines.join("\n") + "\n";
}

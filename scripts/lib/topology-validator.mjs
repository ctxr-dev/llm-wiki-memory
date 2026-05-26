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

// Pick a sample value for a facet based on its facet_inputs spec. If the
// caller passes overrides, those win. The goal is "any valid value that
// the topology will accept" — we're testing the path-compute logic, not
// the value semantics.
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
    // Try a few canned values that match common patterns. If none match,
    // fall back to facet name lowercased; the validator will report the
    // pattern mismatch as a layout problem.
    const candidates = ["sample", "sample-slug", "a-b-c", `${name}-sample`];
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
function sampleFacetsFor(kind, facetInputs, overrides) {
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
      error: `loadTopology failed: ${err.message}`,
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
      error = err.message;
    }
    perKind.push({ kind: kindName, ok, error, samplePath, sampleFacets });
  }
  return {
    ok: perKind.every((k) => k.ok),
    perKind,
  };
}

// Pretty-print for CLI output.
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

// tracker-issue topology helper
//
// Deterministic path resolver for tracker-system (JIRA, GitHub, Linear, …)
// issue trees in the llm-wiki-memory wiki. Universal functions; no LLM
// interpretation, no prose rules.
//
// Reads the topology schema from <wiki>/.llmwiki.layout.yaml entry `issues`
// (the part under `.topology`). The schema declares:
//   - file_kinds.<kind>.required_facets  (string[])
//   - file_kinds.<kind>.enums.<facet>    (string[])  — value must be in set
//   - file_kinds.<kind>.path_template    (string)    — "{var}" placeholders
//   - facet_inputs.<facet>.{type,minimum,pattern}    — caller-supplied facet contract
//
// The path_template substitutes:
//   * caller-supplied facets (e.g. tracker, prefix, number, lifecycle, slug)
//   * derived facets the helper computes from `number`:
//       thousands     = floor(number / 1000)
//       hundreds_tens = floor((number % 1000) / 10)
//       units         = number % 10
//
// Exports:
//   loadTopology(wikiRoot)            -> Topology       (parses YAML once per root)
//   pathFor(topology, kind, facets)   -> string         (validated relative path)
//   parsePath(topology, relPath)      -> {kind, facets} (reverse lookup)
//   validateFacets(topology, kind, f) -> {ok, errors}   (pure validator)
//
// Determinism guarantees:
//   - Same inputs always produce the same path
//   - No filesystem I/O during pathFor / parsePath (only loadTopology touches disk)
//   - No external services, no LLM calls

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// --- schema loading ---

const _topologyCache = new Map(); // wikiRoot -> Topology

export function loadTopology(wikiRoot, { categoryPath = "issues" } = {}) {
  const key = `${wikiRoot}::${categoryPath}`;
  if (_topologyCache.has(key)) return _topologyCache.get(key);
  const layoutPath = path.join(wikiRoot, ".llmwiki.layout.yaml");
  if (!fs.existsSync(layoutPath)) {
    throw new Error(`.llmwiki.layout.yaml not found at ${layoutPath}`);
  }
  const parsed = parseYaml(fs.readFileSync(layoutPath, "utf8")) || {};
  const entries = Array.isArray(parsed.layout) ? parsed.layout : [];
  const entry = entries.find((e) => e && e.path === categoryPath);
  if (!entry || !entry.topology) {
    throw new Error(
      `layout entry '${categoryPath}' has no .topology declaration in ${layoutPath}`,
    );
  }
  const topo = Object.freeze({
    categoryPath,
    strategy: entry.topology.strategy,
    fileKinds: entry.topology.file_kinds || {},
    facetInputs: entry.topology.facet_inputs || {},
    helper: entry.topology.helper || null,
  });
  _topologyCache.set(key, topo);
  return topo;
}

export function _resetCacheForTests() {
  _topologyCache.clear();
}

// --- derived facets (deterministic; no I/O) ---

export function deriveDigitBuckets(number) {
  const n = toPositiveInteger(number, "number");
  return {
    thousands: Math.floor(n / 1000),
    hundreds_tens: Math.floor((n % 1000) / 10),
    units: n % 10,
  };
}

function toPositiveInteger(v, label) {
  if (typeof v === "string" && /^[0-9]+$/.test(v)) v = Number(v);
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`${label} must be a non-negative integer; got: ${JSON.stringify(v)}`);
  }
  return v;
}

// --- public API ---

export function validateFacets(topology, kind, facets) {
  const kindSchema = topology.fileKinds[kind];
  if (!kindSchema) {
    return { ok: false, errors: [`unknown file_kind '${kind}'`] };
  }
  const errors = [];
  for (const key of kindSchema.required_facets || []) {
    if (facets[key] === undefined || facets[key] === null || facets[key] === "") {
      errors.push(`missing required facet '${key}'`);
    }
  }
  for (const [key, allowed] of Object.entries(kindSchema.enums || {})) {
    if (facets[key] !== undefined && !allowed.includes(facets[key])) {
      errors.push(
        `facet '${key}' value '${facets[key]}' not in ${JSON.stringify(allowed)}`,
      );
    }
  }
  for (const [key, spec] of Object.entries(topology.facetInputs || {})) {
    if (facets[key] === undefined) continue;
    if (spec.type === "integer") {
      try {
        const n = toPositiveInteger(facets[key], key);
        if (typeof spec.minimum === "number" && n < spec.minimum) {
          errors.push(`facet '${key}' must be >= ${spec.minimum}; got ${n}`);
        }
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (spec.pattern && typeof facets[key] === "string") {
      if (!new RegExp(spec.pattern).test(facets[key])) {
        errors.push(`facet '${key}' value '${facets[key]}' does not match /${spec.pattern}/`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function pathFor(topology, kind, facets) {
  const v = validateFacets(topology, kind, facets);
  if (!v.ok) {
    throw new Error(
      `tracker-issue.pathFor: invalid facets for kind '${kind}': ${v.errors.join("; ")}`,
    );
  }
  const kindSchema = topology.fileKinds[kind];
  const tmpl = String(kindSchema.path_template);
  const merged = { ...facets, ...deriveDigitBuckets(facets.number) };
  return substituteTemplate(tmpl, merged);
}

function substituteTemplate(tmpl, vars) {
  return tmpl.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, key) => {
    if (!(key in vars)) {
      throw new Error(`template variable '{${key}}' not provided`);
    }
    return String(vars[key]);
  });
}

export function parsePath(topology, relPath) {
  const norm = String(relPath).split(path.sep).join("/").replace(/^\/+/, "");
  for (const [kind, schema] of Object.entries(topology.fileKinds)) {
    const re = templateToRegex(schema.path_template);
    const m = re.regex.exec(norm);
    if (!m) continue;
    const facets = {};
    re.varNames.forEach((name, idx) => {
      facets[name] = m[idx + 1];
    });
    // Coerce `number` back to int (template captures it as a string).
    if (facets.number !== undefined) {
      facets.number = Number.parseInt(facets.number, 10);
    }
    // Verify the digit buckets reconstruct correctly (defence against malformed paths).
    if (facets.number !== undefined) {
      const buckets = deriveDigitBuckets(facets.number);
      for (const k of ["thousands", "hundreds_tens", "units"]) {
        if (facets[k] !== undefined && Number(facets[k]) !== buckets[k]) {
          // Skip: the captured digit-bucket doesn't agree with the issue number.
          continue;
        }
      }
    }
    return { kind, facets };
  }
  return null;
}

// Per-var capture pattern. Numeric vars get [0-9]+ so a template like
// `{prefix}-{number}-{slug}.plan.md` parses unambiguously even when prefix and
// slug both contain hyphens. Anything else gets the path-segment default.
const VAR_PATTERNS = {
  number: "[0-9]+",
  thousands: "[0-9]+",
  hundreds_tens: "[0-9]+",
  units: "[0-9]+",
};
function patternForVar(name) {
  return VAR_PATTERNS[name] || "[^/]+";
}

// Compile "{a}/{b}/literal/{c}.md" into a regex. Returns { regex, varNames }
// where varNames is the ordered list of FIRST-OCCURRENCE variables; repeated
// vars become backreferences (\1, \2, ...) so the same {var} appearing twice
// in a template MUST match the same captured value. Numeric vars get the
// [0-9]+ pattern so dash-separated templates parse unambiguously.
function templateToRegex(tmpl) {
  const varNames = [];
  const indexOf = new Map(); // first-occurrence index per var name
  const escaped = String(tmpl).replace(
    /\{([a-zA-Z_][a-zA-Z0-9_]*)\}|([\^$.*+?()|[\]{}\\])/g,
    (_, varName, special) => {
      if (varName) {
        if (indexOf.has(varName)) {
          // backreference to the first capture for this name
          return `\\${indexOf.get(varName) + 1}`;
        }
        indexOf.set(varName, varNames.length);
        varNames.push(varName);
        return `(${patternForVar(varName)})`;
      }
      return `\\${special}`;
    },
  );
  return { regex: new RegExp(`^${escaped}$`), varNames };
}

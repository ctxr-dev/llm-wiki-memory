// topology-runtime — generic loader + executor for custom-topology layouts.
//
// Reads a layout YAML's `topology:` block and prepares each file_kind for
// forward (facets → path) and reverse (path → facets) operation. Forward
// computation is delegated to one of three mechanisms per file_kind, in
// order of precedence:
//
//   to_path_file > to_path > path_template
//
// Reverse computation mirrors this:
//
//   from_path_file > from_path > regex_from(path_template)
//
// The convention (encouraged by both the example layouts and the file
// loader's named-export fallback): the .mjs / inline JS defines a function
// named `to_path` (forward) or `from_path` (reverse), with signature
//   to_path(facets: Record<string, any>) -> string
//   from_path(relPath: string) -> Record<string, any> | null
//
// The runtime is FILE-SYSTEM-PURE after `loadTopology()`; pathFor() and
// parsePath() do not touch disk. Generic across any topology: there is no
// hardcoded knowledge of facets like `thousands` / `units` / etc. — that
// logic, if needed, lives in the layout's path_compiler.
//
// API:
//   loadTopology(wikiRoot, opts?) -> Promise<Topology>
//   pathFor(topology, kind, facets) -> string
//   parsePath(topology, relPath) -> { kind, facets } | null
//   validateFacets(topology, kind, facets) -> { ok, errors }
//
// Lower-level escape hatches (re-exported from path-compiler.mjs):
//   compileInlineFunction, loadCompilerFile, findUnresolvedPlaceholders

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  compileInlineFunction,
  loadCompilerFile,
  callForwardCompiler,
  callParseCompiler,
  findUnresolvedPlaceholders,
  substituteTemplate,
  resolveCompiler,
  PathCompilerError,
} from "./path-compiler.mjs";

export {
  compileInlineFunction,
  loadCompilerFile,
  findUnresolvedPlaceholders,
  PathCompilerError,
};

// --- topology cache (keyed by wikiRoot + categoryPath) ---

const _topologyCache = new Map();

export function _resetCacheForTests() {
  _topologyCache.clear();
}

// --- loader ---

// Resolve the layout YAML's canonical location. The user-facing source of
// truth is `<wiki>/layout/layout.yaml` — everything that makes up a layout
// (yaml + sibling .mjs helpers) lives in that one folder, so a template
// can be copied with a single `cp -r examples/layouts/<name>  <wiki>/layout`.
function resolveLayoutYamlPath(wikiRoot) {
  const p = path.join(wikiRoot, "layout", "layout.yaml");
  return fs.existsSync(p) ? p : null;
}

export async function loadTopology(wikiRoot, { categoryPath = "issues" } = {}) {
  const cacheKey = `${wikiRoot}::${categoryPath}`;
  if (_topologyCache.has(cacheKey)) return _topologyCache.get(cacheKey);

  const layoutPath = resolveLayoutYamlPath(wikiRoot);
  if (!layoutPath) {
    throw new Error(`layout.yaml not found at ${wikiRoot}/layout/layout.yaml`);
  }
  const yamlDir = path.dirname(layoutPath);

  const parsed = parseYaml(fs.readFileSync(layoutPath, "utf8")) || {};
  const entries = Array.isArray(parsed.layout) ? parsed.layout : [];
  const entry = entries.find((e) => e && e.path === categoryPath);
  if (!entry || !entry.topology) {
    throw new Error(
      `layout entry '${categoryPath}' has no .topology declaration in ${layoutPath}`,
    );
  }

  const fileKindNames = Object.keys(entry.topology.file_kinds || {});
  if (fileKindNames.length === 0) {
    throw new Error(
      `layout entry '${categoryPath}' declares topology but no file_kinds`,
    );
  }

  // Compile every file_kind's forward + reverse functions up front so
  // hot paths (write / search) don't pay compilation cost per call.
  const compiled = {};
  for (const fkName of fileKindNames) {
    const fk = entry.topology.file_kinds[fkName];
    if (!fk || typeof fk !== "object") continue;

    const pathFn = await resolveCompiler(fk, {
      yamlDir,
      slotInline: "to_path",
      slotFile: "to_path_file",
      kindName: categoryPath,
      fileKindName: fkName,
    });
    const parseFn = await resolveCompiler(fk, {
      yamlDir,
      slotInline: "from_path",
      slotFile: "from_path_file",
      kindName: categoryPath,
      fileKindName: fkName,
    });

    compiled[fkName] = {
      ...fk,
      pathFn, // null if path_template was supplied instead
      parseFn,
    };
  }

  const topo = Object.freeze({
    categoryPath,
    yamlDir,
    layoutPath,
    strategy: entry.topology.strategy,
    helper: entry.topology.helper || null,
    fileKinds: compiled,
    facetInputs: entry.topology.facet_inputs || {},
  });

  _topologyCache.set(cacheKey, topo);
  return topo;
}

// --- validation (purely structural; doesn't invoke compilers) ---

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
      errors.push(
        `enums.${key} must be an array in the layout YAML; got ${typeof allowed}`,
      );
      continue;
    }
    if (facets[key] !== undefined && !allowed.includes(facets[key])) {
      errors.push(
        `facet '${key}' value '${facets[key]}' not in ${JSON.stringify(allowed)}`,
      );
    }
  }
  for (const [key, spec] of Object.entries(topology.facetInputs || {})) {
    if (facets[key] === undefined) continue;
    if (spec.type === "integer") {
      // Reject booleans (typeof "boolean") even though Number(true)===1 would
      // pass the integer check otherwise — silent boolean→int coercion is a
      // bug source, not a feature.
      if (typeof facets[key] === "boolean") {
        errors.push(
          `facet '${key}' must be an integer; got boolean ${facets[key]}`,
        );
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
            `facet '${key}' pattern is not a valid regex (${err.message}); fix the layout YAML`,
          );
          continue;
        }
        if (!re.test(facets[key])) {
          errors.push(
            `facet '${key}' value '${facets[key]}' does not match /${spec.pattern}/`,
          );
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// --- forward (facets -> relative path) ---

export function pathFor(topology, kindName, facets, { skipRoundTripCheck = false } = {}) {
  const v = validateFacets(topology, kindName, facets);
  if (!v.ok) {
    throw new Error(
      `pathFor: invalid facets for kind '${kindName}': ${v.errors.join("; ")}`,
    );
  }

  const kind = topology.fileKinds[kindName];

  // Preference order: pathFn (path_compiler[_file]) > path_template.
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
    out = r.path;
  } else if (kind.path_template) {
    out = substituteTemplate(kind.path_template, facets);
  } else {
    throw new Error(
      `file_kind '${kindName}' has neither to_path, to_path_file, nor path_template`,
    );
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

// --- reverse (relative path -> { kind, facets }) ---

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
      const facets = {};
      compiled.varNames.forEach((name, idx) => {
        facets[name] = m[idx + 1];
      });
      // Coerce known integer facets back to numbers via facet_inputs hints.
      for (const [k, spec] of Object.entries(topology.facetInputs || {})) {
        if (spec.type === "integer" && facets[k] !== undefined) {
          const n = Number.parseInt(facets[k], 10);
          if (Number.isFinite(n)) facets[k] = n;
        }
      }
      return { kind: kindName, facets };
    }
  }
  return null;
}

// --- template fallback (string-only) ---

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

function templateToRegex(tmpl) {
  const varNames = [];
  const firstIdx = new Map();
  const escaped = String(tmpl).replace(
    /\{([a-zA-Z_][a-zA-Z0-9_]*)\}|([\^$.*+?()|[\]{}\\])/g,
    (_, varName, special) => {
      if (varName) {
        if (firstIdx.has(varName)) {
          return `\\${firstIdx.get(varName) + 1}`;
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

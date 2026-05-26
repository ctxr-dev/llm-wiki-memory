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
// truth is `<wiki>/layout/.llmwiki.layout.yaml` (everything that makes up a
// layout — yaml + sibling .mjs helpers — lives in that one folder, so a
// template can be copied with a single `cp -r examples/layouts/<name>/
// <wiki>/layout`). For backward compatibility (and the brief windows when
// only the skill's root copy exists), we fall back to
// `<wiki>/.llmwiki.layout.yaml`.
function resolveLayoutYamlPath(wikiRoot) {
  const inLayoutDir = path.join(wikiRoot, "layout", ".llmwiki.layout.yaml");
  if (fs.existsSync(inLayoutDir)) return inLayoutDir;
  const atRoot = path.join(wikiRoot, ".llmwiki.layout.yaml");
  if (fs.existsSync(atRoot)) return atRoot;
  return null;
}

export async function loadTopology(wikiRoot, { categoryPath = "issues" } = {}) {
  const cacheKey = `${wikiRoot}::${categoryPath}`;
  if (_topologyCache.has(cacheKey)) return _topologyCache.get(cacheKey);

  const layoutPath = resolveLayoutYamlPath(wikiRoot);
  if (!layoutPath) {
    throw new Error(
      `.llmwiki.layout.yaml not found at ${wikiRoot}/layout/ or ${wikiRoot}/`,
    );
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
  const errors = [];
  for (const key of kind.required_facets || []) {
    if (facets[key] === undefined || facets[key] === null || facets[key] === "") {
      errors.push(`missing required facet '${key}'`);
    }
  }
  for (const [key, allowed] of Object.entries(kind.enums || {})) {
    if (facets[key] !== undefined && !allowed.includes(facets[key])) {
      errors.push(
        `facet '${key}' value '${facets[key]}' not in ${JSON.stringify(allowed)}`,
      );
    }
  }
  for (const [key, spec] of Object.entries(topology.facetInputs || {})) {
    if (facets[key] === undefined) continue;
    if (spec.type === "integer") {
      const n = Number(facets[key]);
      if (!Number.isInteger(n) || n < 0) {
        errors.push(
          `facet '${key}' must be a non-negative integer; got ${JSON.stringify(facets[key])}`,
        );
      } else if (typeof spec.minimum === "number" && n < spec.minimum) {
        errors.push(`facet '${key}' must be >= ${spec.minimum}; got ${n}`);
      }
    }
    if (spec.pattern && typeof facets[key] === "string") {
      if (!new RegExp(spec.pattern).test(facets[key])) {
        errors.push(
          `facet '${key}' value '${facets[key]}' does not match /${spec.pattern}/`,
        );
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// --- forward (facets -> relative path) ---

export function pathFor(topology, kindName, facets) {
  const v = validateFacets(topology, kindName, facets);
  if (!v.ok) {
    throw new Error(
      `pathFor: invalid facets for kind '${kindName}': ${v.errors.join("; ")}`,
    );
  }

  const kind = topology.fileKinds[kindName];

  // Preference order: pathFn (path_compiler[_file]) > path_template.
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
    return r.path;
  }

  if (kind.path_template) {
    return substituteTemplate(kind.path_template, facets);
  }

  throw new Error(
    `file_kind '${kindName}' has neither to_path, to_path_file, nor path_template`,
  );
}

// --- reverse (relative path -> { kind, facets }) ---

export function parsePath(topology, relPath) {
  const norm = String(relPath).split(path.sep).join("/").replace(/^\/+/, "");

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

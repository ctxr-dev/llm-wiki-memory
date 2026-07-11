// topology-loader — reads a layout YAML's `topology:` block, compiles every
// file_kind's forward/reverse functions once, and returns a frozen Topology.
// File-system work happens here; pathFor() / parsePath() stay disk-pure.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveCompiler } from "./path-compiler.mjs";
import { _topologyCache, sigOf } from "./topology-cache.mjs";

/** @typedef {import("./path-compiler.mjs").CompilerFn} CompilerFn */

/**
 * A facet map. Values are typically string or number; each file_kind validates
 * its own facets structurally via {@link import("./topology-validate.mjs")}.
 * @typedef {Record<string, unknown>} Facets
 */

/**
 * Per-facet input spec drawn from a topology's `facet_inputs` block.
 * @typedef {Object} FacetInputSpec
 * @property {"string" | "integer"} [type]
 * @property {number} [minimum]
 * @property {string} [pattern]
 * @property {boolean} [required]
 * @property {string} [description]
 * @property {string[]} [examples]
 */

/**
 * A raw file_kind block as declared in a layout YAML `topology.file_kinds`.
 * @typedef {Object} FileKind
 * @property {string[]} [required_facets]
 * @property {Record<string, string[]>} [enums]
 * @property {string} [path_template]
 * @property {string} [to_path]
 * @property {string} [to_path_file]
 * @property {string} [from_path]
 * @property {string} [from_path_file]
 */

/**
 * A file_kind after its forward/reverse compilers have been resolved.
 * @typedef {FileKind & { pathFn: CompilerFn | null, parseFn: CompilerFn | null }} CompiledFileKind
 */

/**
 * A raw topology block as declared under a layout entry.
 * @typedef {Object} TopologyRaw
 * @property {string} [strategy]
 * @property {unknown} [helper]
 * @property {Record<string, FileKind>} [file_kinds]
 * @property {Record<string, FacetInputSpec>} [facet_inputs]
 */

/**
 * A raw layout entry as declared in a layout YAML `layout` array.
 * @typedef {Object} LayoutEntryRaw
 * @property {string} [path]
 * @property {TopologyRaw} [topology]
 */

/**
 * A frozen, compiled topology returned by {@link loadTopology}.
 * @typedef {Object} Topology
 * @property {string} categoryPath
 * @property {string} yamlDir
 * @property {string} layoutPath
 * @property {string | undefined} strategy
 * @property {unknown} helper
 * @property {Record<string, CompiledFileKind>} fileKinds
 * @property {Record<string, FacetInputSpec>} facetInputs
 */

// Resolve the layout YAML's canonical location. The user-facing source of
// truth is `<wiki>/.layout/layout.yaml` — everything that makes up a layout
// (yaml + sibling .mjs helpers) lives in that one folder, so a template
// can be copied with a single `cp -r examples/layouts/<name>  <wiki>/.layout`.
/**
 * @param {string} wikiRoot
 * @returns {string | null}
 */
function resolveLayoutYamlPath(wikiRoot) {
  const p = path.join(wikiRoot, ".layout", "layout.yaml");
  return fs.existsSync(p) ? p : null;
}

/**
 * @param {string} wikiRoot
 * @param {{ categoryPath?: string }} [opts]
 * @returns {Promise<Topology>}
 */
export async function loadTopology(wikiRoot, { categoryPath = "issues" } = {}) {
  const cacheKey = `${wikiRoot}::${categoryPath}`;

  const layoutPath = resolveLayoutYamlPath(wikiRoot);
  if (!layoutPath) {
    throw new Error(`layout.yaml not found at ${wikiRoot}/.layout/layout.yaml`);
  }

  // Reuse the cached topology only while its source files are unchanged.
  const cached = _topologyCache.get(cacheKey);
  if (cached && cached.sig === sigOf(cached.deps)) return cached.topo;

  const yamlDir = path.dirname(layoutPath);

  const parsed = /** @type {{ layout?: LayoutEntryRaw[] }} */ (
    parseYaml(fs.readFileSync(layoutPath, "utf8")) || {}
  );
  const entries = Array.isArray(parsed.layout) ? parsed.layout : [];
  const entry = entries.find((e) => e && e.path === categoryPath);
  if (!entry || !entry.topology) {
    throw new Error(`layout entry '${categoryPath}' has no .topology declaration in ${layoutPath}`);
  }

  // Files this topology is built from — layout.yaml plus every referenced
  // sibling helper — tracked so an edit to any of them invalidates the cache.
  const deps = [layoutPath];
  for (const fk of Object.values(entry.topology.file_kinds || {})) {
    if (!fk || typeof fk !== "object") continue;
    for (const slot of /** @type {("to_path_file" | "from_path_file")[]} */ ([
      "to_path_file",
      "from_path_file",
    ])) {
      const v = fk[slot];
      if (v) deps.push(path.isAbsolute(v) ? v : path.join(yamlDir, v));
    }
  }

  const fileKindNames = Object.keys(entry.topology.file_kinds || {});
  if (fileKindNames.length === 0) {
    throw new Error(`layout entry '${categoryPath}' declares topology but no file_kinds`);
  }

  // Compile every file_kind's forward + reverse functions up front so
  // hot paths (write / search) don't pay compilation cost per call.
  /** @type {Record<string, CompiledFileKind>} */
  const compiled = {};
  for (const fkName of fileKindNames) {
    const fk = /** @type {Record<string, FileKind>} */ (entry.topology.file_kinds)[fkName];
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

  _topologyCache.set(cacheKey, { topo, deps, sig: sigOf(deps) });
  return topo;
}

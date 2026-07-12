import path from "node:path";
import { wikiRoot } from "./lib/env.mjs";
import { validate } from "./lib/wiki-cli.mjs";
import { out } from "./cli-io.mjs";
import { DEFAULT_TOPOLOGY_CATEGORY } from "./lib/context/enums.mjs";

export function handleValidate() {
  return out(validate(wikiRoot()));
}

/** @param {string[]} rest */
export async function handleValidateTopology(rest) {
  const { validateTopologyAgainstSamples, formatValidationReport } =
    await import("./lib/topology-validator.mjs");
  const target = rest[0] || wikiRoot();
  const category = rest[1] || DEFAULT_TOPOLOGY_CATEGORY;
  const result = await validateTopologyAgainstSamples(target, { categoryPath: category });
  process.stdout.write(`validate-topology on ${target} (category=${category}):\n`);
  process.stdout.write(formatValidationReport(result));
  process.exit(result.ok ? 0 : 2);
}

/** @param {string[]} rest */
export async function handleValidateLayout(rest) {
  const { validateLayoutFile, formatValidationResult } = await import("./lib/layout-validator.mjs");
  const target = rest[0] || path.join(wikiRoot(), ".layout", "layout.yaml");
  const result = validateLayoutFile(target);
  process.stdout.write(formatValidationResult(result));
  process.exit(result.ok ? 0 : 2);
}

/** @param {string[]} rest */
export async function handleTestPathCompiler(rest) {
  // Usage:
  //   llm-wiki-memory test-path-compiler <file_kind> [--category issues] [--layout <wiki-root>] key=val ...
  // Compiles the file_kind's path_compiler (or path_template), runs it
  // against the supplied facets, and prints the resolved path plus any
  // unresolved placeholders.
  const { loadTopology, pathFor, validateFacets, findUnresolvedPlaceholders } =
    await import("./lib/topology-runtime.mjs");
  let categoryPath = DEFAULT_TOPOLOGY_CATEGORY;
  let wikiOverride = null;
  /** @type {string[]} */
  const fkArgs = [];
  /** @type {Record<string, string | number>} */
  const facets = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--category") {
      categoryPath = rest[++i];
    } else if (a === "--layout") {
      wikiOverride = rest[++i];
    } else if (a.includes("=")) {
      const eq = a.indexOf("=");
      const k = a.slice(0, eq);
      /** @type {string | number} */
      let v = a.slice(eq + 1);
      if (/^-?\d+$/.test(/** @type {string} */ (v))) v = Number(v);
      facets[k] = v;
    } else {
      fkArgs.push(a);
    }
  }
  const fileKind = fkArgs[0];
  if (!fileKind) {
    process.stderr.write(
      "usage: llm-wiki-memory test-path-compiler <file_kind> [--category <name>] [--layout <wiki-root>] key=val ...\n",
    );
    process.exit(64);
  }
  const root = wikiOverride || wikiRoot();
  const topology = await loadTopology(root, { categoryPath });
  const v = validateFacets(topology, fileKind, facets);
  if (!v.ok) {
    out({ ok: false, errors: v.errors, facets });
    process.exit(2);
  }
  try {
    const resolved = pathFor(topology, fileKind, facets);
    const unresolved = findUnresolvedPlaceholders(resolved);
    out({
      ok: unresolved.length === 0,
      file_kind: fileKind,
      facets,
      path: resolved,
      unresolved_placeholders: unresolved,
    });
    process.exit(unresolved.length === 0 ? 0 : 2);
  } catch (err) {
    out({ ok: false, file_kind: fileKind, facets, error: /** @type {Error} */ (err).message });
    process.exit(2);
  }
}

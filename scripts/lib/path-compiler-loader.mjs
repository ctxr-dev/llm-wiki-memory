// path-compiler-loader — load a path compiler from an external .mjs file.
//
// File-based compilers (`*_compiler_file`) are dynamically `import()`-ed.
// They share trust with the layout YAML itself (both live in the same
// configuration tree), so the import is NOT sandboxed.

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { PathCompilerError } from "./path-compiler-error.mjs";

/** @typedef {import("./path-compiler.mjs").CompilerFn} CompilerFn */

// Load a compiler from an external .mjs file. Trust level matches the
// surrounding layout YAML (both live in the user's config tree); the
// import is a normal Node dynamic import — NOT sandboxed.
//
// Export-resolution order:
//   1. If `fileKindName` is provided and the module has a NAMED export with
//      that name, use it. (Convention: one .mjs file per direction, with
//      one named export per file_kind. Lets two file_kinds share the same
//      file — e.g. layout/to_path.mjs with `knowledge` + `plan` exports.)
//   2. `default` export, if present.
//   3. Named `to_path` / `from_path` export (single-purpose files).
//   4. Otherwise, throw.
/**
 * @param {string} absFilePath
 * @param {{ fileKindName?: string, cacheBust?: number }} [opts]
 * @returns {Promise<CompilerFn>}
 */
export async function loadCompilerFile(absFilePath, { fileKindName, cacheBust } = {}) {
  if (!fs.existsSync(absFilePath)) {
    throw new PathCompilerError(`compiler file not found: ${absFilePath}`, {
      phase: "load",
      source: absFilePath,
    });
  }
  const url = pathToFileURL(absFilePath);
  // `cacheBust` (the file's mtime) busts Node's ESM module registry so an EDITED
  // helper .mjs is re-evaluated instead of served from the permanent import
  // cache. Each distinct token retains one module copy; the topology cache only
  // re-imports on an actual mtime change, so the leak is bounded.
  const href = cacheBust != null ? `${url.href}?v=${cacheBust}` : url.href;
  const mod = /** @type {Record<string, unknown>} */ (await import(href));

  /** @type {CompilerFn | undefined} */
  let fn;
  if (fileKindName && typeof mod[fileKindName] === "function") {
    fn = /** @type {CompilerFn} */ (mod[fileKindName]);
  } else if (typeof mod.default === "function") {
    fn = /** @type {CompilerFn} */ (mod.default);
  } else if (typeof mod.to_path === "function") {
    fn = /** @type {CompilerFn} */ (mod.to_path);
  } else if (typeof mod.from_path === "function") {
    fn = /** @type {CompilerFn} */ (mod.from_path);
  }

  if (typeof fn !== "function") {
    const tried = [
      fileKindName ? `named export '${fileKindName}'` : null,
      "default export",
      "named export 'to_path'",
      "named export 'from_path'",
    ]
      .filter(Boolean)
      .join(", ");
    throw new PathCompilerError(`${absFilePath} must export a function (tried: ${tried})`, {
      phase: "load",
      source: absFilePath,
    });
  }
  return fn;
}

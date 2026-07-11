// path-compiler-resolve — resolve a compiler reference declared on a
// file_kind block to a callable, dispatching to the file loader or the
// inline sandbox compiler.

import fs from "node:fs";
import path from "node:path";
import { PathCompilerError } from "./path-compiler-error.mjs";
import { compileInlineFunction } from "./path-compiler-sandbox.mjs";
import { loadCompilerFile } from "./path-compiler-loader.mjs";

/** @typedef {import("./path-compiler.mjs").CompilerFn} CompilerFn */
/** @typedef {import("./topology-loader.mjs").FileKind} FileKind */

// Resolve a compiler reference (one of to_path / to_path_file / from_path /
// from_path_file) declared on a file_kind block, with the YAML directory
// used as the base for file-mode resolution.
//
// Returns either a function or null. Throws PathCompilerError on failure.
/**
 * @typedef {Object} ResolveOpts
 * @property {string} yamlDir
 * @property {"to_path" | "from_path"} slotInline
 * @property {"to_path_file" | "from_path_file"} slotFile
 * @property {string} kindName
 * @property {string} fileKindName
 */

/**
 * @param {FileKind} fileKind
 * @param {ResolveOpts} opts
 * @returns {Promise<CompilerFn | null>}
 */
export async function resolveCompiler(
  fileKind,
  { yamlDir, slotInline, slotFile, kindName, fileKindName } = /** @type {ResolveOpts} */ (
    /** @type {unknown} */ ({})
  ),
) {
  const fileVal = fileKind[slotFile];
  const inlineVal = fileKind[slotInline];

  if (fileVal && inlineVal) {
    throw new PathCompilerError(
      `file_kind '${fileKindName}' declares BOTH ${slotInline} and ${slotFile}; pick one`,
      { phase: "resolve", source: kindName },
    );
  }
  if (fileVal) {
    const abs = path.isAbsolute(fileVal) ? fileVal : path.join(yamlDir, fileVal);
    // Cache-bust the import by the helper's own mtime so an edit is re-evaluated
    // (an UNCHANGED file keeps the same token → no duplicate module instance).
    let cacheBust;
    try {
      cacheBust = fs.statSync(abs).mtimeMs;
    } catch {
      cacheBust = undefined;
    }
    return loadCompilerFile(abs, { fileKindName, cacheBust });
  }
  if (inlineVal) {
    return compileInlineFunction(inlineVal, {
      filename: `<${kindName}:${fileKindName}:${slotInline}>`,
    });
  }
  return null;
}

// Layout-file validator.
//
// Parses <wiki>/.layout/layout.yaml (or any layout YAML), validates it
// against the Zod schemas in ./layout-schema.mjs (covering both the historical
// layout fields and the `topology:` block), and reports any failures with
// **line:column** pointing at the offending YAML node. The `yaml` library's
// parseDocument() preserves node ranges; we map each Zod issue path back to the
// corresponding YAML node and convert its byte range to (line, col).
//
// Used by:
//   - `node scripts/cli.mjs validate-layout [path]` (CLI surface)
//   - test/layout-validator.test.mjs
//   - `bootstrap.sh` can wrap this before copying a template into a project
//
// LayoutYamlSchema is re-exported here (`export *`) so this module stays the
// single import surface for layout validation and its top-level schema.

import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { LayoutYamlSchema } from "./layout-schema.mjs";

export * from "./layout-schema.mjs";

/**
 * The subset of a `yaml` node surface this module navigates. `items` is present
 * on sequence nodes, `get` on map nodes, and `range` on any node with a source
 * position.
 * @typedef {Object} YamlNav
 * @property {YamlNav[]} [items]
 * @property {(key: unknown, keepScalar?: boolean) => YamlNav | null | undefined} [get]
 * @property {number[]} [range]
 */

/**
 * @typedef {Object} LayoutError
 * @property {string} filePath
 * @property {string} path
 * @property {string} message
 * @property {number} line
 * @property {number} col
 */

/**
 * @typedef {Object} LayoutValidationResult
 * @property {boolean} ok
 * @property {LayoutError[]} errors
 */

// Walk a parsed `yaml` Document down a Zod-style issue path
// (e.g. ["layout", 5, "topology", "file_kinds", "knowledge", "path_template"])
// and return the deepest node we could resolve. When a path segment refers
// to a key that DOESN'T exist in the YAML (e.g. a `required` field that the
// author forgot), we return the last-known-good parent node so the error
// still gets a useful line:col instead of <unknown>.
/**
 * @param {import("yaml").Document} doc
 * @param {(string | number)[]} issuePath
 * @returns {YamlNav | null}
 */
function nodeAt(doc, issuePath) {
  /** @type {YamlNav | null} */
  let node = /** @type {YamlNav | null} */ (/** @type {unknown} */ (doc.contents));
  let lastGood = node;
  for (const seg of issuePath) {
    if (!node) return lastGood;
    let next = null;
    if (typeof seg === "number") {
      if (Array.isArray(node.items)) {
        next = node.items[seg] ?? null;
      }
    } else if (typeof node.get === "function") {
      // Object/Map node: look up the key. The `YAMLMap.get(key, true)` form
      // returns the value Node (not its JS scalar), preserving range info.
      next = node.get(seg, true) ?? null;
    }
    if (next == null) {
      // Key/index not present in the YAML — surface the parent so the
      // error still has a precise location.
      return lastGood;
    }
    node = next;
    lastGood = next;
  }
  return node;
}

/**
 * @param {string} text
 * @param {number} off
 * @returns {{ line: number, col: number }}
 */
function offsetToLineCol(text, off) {
  let line = 1;
  let col = 1;
  const upTo = Math.min(off, text.length);
  for (let i = 0; i < upTo; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

/**
 * @param {string} text
 * @param {YamlNav | null} node
 * @returns {{ line: number, col: number }}
 */
function locForNode(text, node) {
  // node.range is [valueStart, valueEnd, nodeEnd] (3-tuple in yaml@2.x).
  // For our purposes the valueStart is the most useful pointer.
  if (!node || !Array.isArray(node.range)) return { line: 0, col: 0 };
  return offsetToLineCol(text, node.range[0]);
}

/**
 * @param {string} text
 * @param {{ filePath?: string }} [options]
 * @returns {LayoutValidationResult}
 */
export function validateLayoutText(text, { filePath = "<inline>" } = {}) {
  const doc = parseDocument(text, { prettyErrors: false });

  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((e) => {
        const off = Array.isArray(e.pos) ? e.pos[0] : 0;
        const { line, col } = offsetToLineCol(text, off);
        return {
          filePath,
          path: "<yaml-parse>",
          message: e.message,
          line,
          col,
        };
      }),
    };
  }

  const obj = doc.toJS({ maxAliasCount: 100 });
  const result = LayoutYamlSchema.safeParse(obj);
  if (result.success) {
    return { ok: true, errors: [] };
  }

  const errors = result.error.issues.map((issue) => {
    const node = nodeAt(doc, issue.path);
    const { line, col } = locForNode(text, node);
    return {
      filePath,
      path: issue.path.length === 0 ? "<root>" : issue.path.join("."),
      message: issue.message,
      line,
      col,
    };
  });
  return { ok: false, errors };
}

/**
 * @param {string} filePath
 * @returns {LayoutValidationResult}
 */
export function validateLayoutFile(filePath) {
  const abs = path.resolve(filePath);
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    return {
      ok: false,
      errors: [
        {
          filePath: abs,
          path: "<file>",
          message:
            e.code === "ENOENT"
              ? `layout file not found: ${abs}`
              : `cannot stat layout file ${abs}: ${e.message}`,
          line: 0,
          col: 0,
        },
      ],
    };
  }
  if (stat.isDirectory()) {
    return {
      ok: false,
      errors: [
        {
          filePath: abs,
          path: "<file>",
          message: `layout path points to a directory, not a YAML file: ${abs}`,
          line: 0,
          col: 0,
        },
      ],
    };
  }
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    return {
      ok: false,
      errors: [
        {
          filePath: abs,
          path: "<file>",
          message: `cannot read layout file ${abs}: ${e.message}`,
          line: 0,
          col: 0,
        },
      ],
    };
  }
  return validateLayoutText(text, { filePath: abs });
}

// Pretty-print a result for CLI output (one error per line).
/**
 * @param {LayoutValidationResult} result
 * @returns {string}
 */
export function formatValidationResult(result) {
  if (result.ok) return "layout valid (0 errors).\n";
  const lines = [];
  for (const e of result.errors) {
    const loc = e.line ? `${e.line}:${e.col}` : "?:?";
    lines.push(`${e.filePath}:${loc}  [${e.path}]  ${e.message}`);
  }
  lines.push(`\n${result.errors.length} error(s).`);
  return `${lines.join("\n")}\n`;
}

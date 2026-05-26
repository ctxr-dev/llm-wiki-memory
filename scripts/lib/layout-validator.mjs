// Layout-file validator.
//
// Parses <wiki>/.llmwiki.layout.yaml (or any layout YAML), validates it
// against a Zod schema covering both the historical layout fields and the new
// `topology:` block, and reports any failures with **line:column** pointing
// at the offending YAML node. The `yaml` library's parseDocument() preserves
// node ranges; we map each Zod issue path back to the corresponding YAML
// node and convert its byte range to (line, col).
//
// Used by:
//   - `node scripts/cli.mjs validate-layout [path]` (CLI surface)
//   - test/layout-validator.test.mjs
//   - `bootstrap.sh` can wrap this before copying a template into a project
//
// The validator is intentionally STRICT (`.strict()` on every object schema)
// so a typo in a field name surfaces as an error with a precise location,
// not silently ignored.

import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

// --- Zod schemas (composable; exported for tests / external tools) ---

export const FacetInputSchema = z
  .object({
    type: z.enum(["string", "integer"]).optional(),
    minimum: z.number().int().optional(),
    pattern: z.string().optional(),
    required: z.boolean().optional(),
    description: z.string().optional(),
    examples: z.array(z.string()).optional(),
  })
  .strict();

export const FileKindSchema = z
  .object({
    required_facets: z.array(z.string()).min(1, "file_kind must list at least one required_facet"),
    enums: z.record(z.string(), z.array(z.string())).optional(),
    // One of the three forward mechanisms is required (validated in
    // .superRefine below):
    //   path_compiler_file > path_compiler > path_template
    path_template: z
      .string()
      .min(1, "path_template cannot be empty")
      .refine((s) => /\{[a-zA-Z_][a-zA-Z0-9_]*\}/.test(s), {
        message: "path_template must contain at least one {variable} placeholder",
      })
      .optional(),
    // Forward path generators (facets -> path). Pick exactly ONE alongside
    // (or instead of) `path_template`. `to_path` is inline sandboxed JS;
    // `to_path_file` is a sibling .mjs whose default export is the function.
    to_path: z.string().min(1, "to_path cannot be empty").optional(),
    to_path_file: z.string().min(1).optional(),
    // Reverse path parsers (path -> facets). All optional. When none are
    // supplied, parsePath() falls back to regex-from(path_template).
    from_path: z.string().min(1).optional(),
    from_path_file: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const forwardCount =
      (val.path_template ? 1 : 0) +
      (val.to_path ? 1 : 0) +
      (val.to_path_file ? 1 : 0);
    if (forwardCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "file_kind must declare exactly one of path_template, to_path, or to_path_file",
      });
    }
    if (forwardCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "file_kind must declare ONLY ONE of path_template, to_path, to_path_file (got multiple)",
      });
    }
    if (val.from_path && val.from_path_file) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "file_kind must declare AT MOST ONE of from_path / from_path_file (got both)",
      });
    }
  });

export const HelperSchema = z
  .object({
    module: z.string().min(1),
    package: z.string().optional(),
    schema_version: z.number().int().positive().optional(),
  })
  .strict();

export const TopologySchema = z
  .object({
    strategy: z.literal("caller_path", {
      errorMap: () => ({
        message: "only `caller_path` topology strategy is currently supported",
      }),
    }),
    helper: HelperSchema,
    file_kinds: z
      .record(z.string(), FileKindSchema)
      .refine((obj) => Object.keys(obj).length >= 1, {
        message: "topology must declare at least one file_kind",
      }),
    facet_inputs: z.record(z.string(), FacetInputSchema).optional(),
  })
  .strict();

export const LayoutEntrySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/, "layout entry path must be a single safe directory segment"),
    purpose: z.string().optional(),
    placement_facets: z.array(z.string()).optional(),
    placement_strategy: z.enum(["daily-date"]).optional(),
    allow_entry_types: z.array(z.string()).optional(),
    max_depth: z.number().int().positive().optional(),
    topology: TopologySchema.optional(),
  })
  .strict();

export const LayoutYamlSchema = z
  .object({
    mode: z.string().optional(),
    versioning: z
      .object({
        style: z.string().optional(),
        backup_before_mutate: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    purpose: z.string().optional(),
    layout: z.array(LayoutEntrySchema).min(1, "`layout` must declare at least one entry"),
  })
  .passthrough();

// --- YAML node -> position resolution ---

// Walk a parsed `yaml` Document down a Zod-style issue path
// (e.g. ["layout", 5, "topology", "file_kinds", "knowledge", "path_template"])
// and return the deepest node we could resolve. When a path segment refers
// to a key that DOESN'T exist in the YAML (e.g. a `required` field that the
// author forgot), we return the last-known-good parent node so the error
// still gets a useful line:col instead of <unknown>.
function nodeAt(doc, issuePath) {
  let node = doc.contents;
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

function locForNode(text, node) {
  // node.range is [valueStart, valueEnd, nodeEnd] (3-tuple in yaml@2.x).
  // For our purposes the valueStart is the most useful pointer.
  if (!node || !Array.isArray(node.range)) return { line: 0, col: 0 };
  return offsetToLineCol(text, node.range[0]);
}

// --- public API ---

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

export function validateLayoutFile(filePath) {
  const abs = path.resolve(filePath);
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          filePath: abs,
          path: "<file>",
          message:
            err.code === "ENOENT"
              ? `layout file not found: ${abs}`
              : `cannot stat layout file ${abs}: ${err.message}`,
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
    return {
      ok: false,
      errors: [
        {
          filePath: abs,
          path: "<file>",
          message: `cannot read layout file ${abs}: ${err.message}`,
          line: 0,
          col: 0,
        },
      ],
    };
  }
  return validateLayoutText(text, { filePath: abs });
}

// Pretty-print a result for CLI output (one error per line).
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

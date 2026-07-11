// Layout-file Zod schemas (composable). Only the top-level LayoutYamlSchema is
// exported; the sub-schemas are composed into it and kept module-private.
//
// Split out of layout-validator.mjs so both modules stay within the size
// limit; the validator imports LayoutYamlSchema from here. The schemas are
// intentionally STRICT (`.strict()` on every object schema) so a typo in a
// field name surfaces as an error with a precise location, not silently
// ignored.

import { z } from "zod";
import { slugify } from "./slug.mjs";

const FacetInputSchema = z
  .object({
    type: z.enum(["string", "integer"]).optional(),
    minimum: z.number().int().optional(),
    pattern: z.string().optional(),
    required: z.boolean().optional(),
    description: z.string().optional(),
    examples: z.array(z.string()).optional(),
  })
  .strict();

const FileKindSchema = z
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
      (val.path_template ? 1 : 0) + (val.to_path ? 1 : 0) + (val.to_path_file ? 1 : 0);
    if (forwardCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "file_kind must declare exactly one of path_template, to_path, or to_path_file",
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
        message: "file_kind must declare AT MOST ONE of from_path / from_path_file (got both)",
      });
    }
  });

const HelperSchema = z
  .object({
    module: z.string().min(1),
    package: z.string().optional(),
    schema_version: z.number().int().positive().optional(),
  })
  .strict();

// Per-facet placement rule (layout entry `facet_rules`). `kind: path` marks an
// array-valued facet that expands to one directory segment per element
// (broad->narrow). `vocabulary` pins the FIRST segment to a declared top-level
// vocabulary; `fallback` is the sentinel segment used when the facet is absent.
const FacetRuleSchema = z
  .object({
    kind: z.enum(["path", "segment"]).optional(),
    vocabulary: z.string().min(1).optional(),
    fallback: z.string().min(1).optional(),
  })
  .strict();

const TopologySchema = z
  .object({
    strategy: z.literal("caller_path", {
      errorMap: () => ({
        message: "only `caller_path` topology strategy is currently supported",
      }),
    }),
    helper: HelperSchema,
    file_kinds: z.record(z.string(), FileKindSchema).refine((obj) => Object.keys(obj).length >= 1, {
      message: "topology must declare at least one file_kind",
    }),
    facet_inputs: z.record(z.string(), FacetInputSchema).optional(),
  })
  .strict();

const LayoutEntrySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/, "layout entry path must be a single safe directory segment"),
    purpose: z.string().optional(),
    placement_facets: z.array(z.string()).optional(),
    placement_strategy: z.enum(["daily-date"]).optional(),
    facet_rules: z.record(z.string(), FacetRuleSchema).optional(),
    allow_entry_types: z.array(z.string()).optional(),
    max_depth: z.number().int().positive().optional(),
    topology: TopologySchema.optional(),
    // Who owns this category in a federated (layered) wiki: `repo` for a
    // category checked into the consuming project, `wiki` for one that lives in
    // the user's private memory tree. Optional because single-level wikis (the
    // baseline) don't distinguish ownership.
    ownership: z.enum(["repo", "wiki"]).optional(),
    // Per-category consolidate eligibility (read by the consolidate
    // orchestrator at run start). Optional in the layout schema because
    // existing wikis predate this field; the orchestrator itself enforces
    // presence at runtime with a clear error envelope, so the validator
    // doesn't gate `validate_layout` on it.
    consolidate: z.enum(["refine", "none"]).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    // Every facet that has a rule must also be listed in placement_facets,
    // otherwise the rule is dead config.
    const declared = new Set(entry.placement_facets || []);
    for (const fname of Object.keys(entry.facet_rules || {})) {
      if (!declared.has(fname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["facet_rules", fname],
          message: `facet_rules.${fname} is not listed in placement_facets, so the rule has no effect`,
        });
      }
    }
  });

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
    // Declarative marker: this wiki nests deep (e.g. by the subject axis) and
    // depth limits should NOT be enforced. llm-wiki-memory never passes
    // --max-depth to skill-llm-wiki, so depth is unbounded by construction;
    // this flag documents that intent and lets per-entry `max_depth` be omitted.
    ignore_max_depth: z.boolean().optional(),
    vocabularies: z.record(z.string(), z.array(z.string().min(1)).min(1)).optional(),
    layout: z.array(LayoutEntrySchema).min(1, "`layout` must declare at least one entry"),
  })
  .passthrough()
  .superRefine((doc, ctx) => {
    const vocabNames = new Set(Object.keys(doc.vocabularies || {}));
    const entries = Array.isArray(doc.layout) ? doc.layout : [];
    /** @type {Set<string>} */
    const seenPaths = new Set();
    entries.forEach((entry, i) => {
      if (entry && typeof entry.path === "string") {
        if (seenPaths.has(entry.path)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["layout", i, "path"],
            message: `duplicate layout entry path '${entry.path}'; each layout[].path must be unique`,
          });
        } else {
          seenPaths.add(entry.path);
        }
      }
      for (const [fname, rule] of Object.entries(entry.facet_rules || {})) {
        if (!rule || typeof rule !== "object") continue;
        // A fallback WITHOUT a vocabulary is allowed (free-form first segment),
        // so membership is only checked when a vocabulary is referenced.
        if (rule.vocabulary) {
          if (!vocabNames.has(rule.vocabulary)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["layout", i, "facet_rules", fname, "vocabulary"],
              message: `references vocabulary '${rule.vocabulary}' which is not declared under top-level 'vocabularies'`,
            });
          } else if (rule.fallback) {
            // Compare under slugify: the runtime slugifies both vocab members
            // and the fallback, so "General"/"general" must be treated as equal
            // here too (otherwise a cosmetically-cased fallback false-fails).
            const vocabs = /** @type {Record<string, string[]>} */ (doc.vocabularies || {});
            const members = (vocabs[rule.vocabulary] || []).map((/** @type {string} */ m) =>
              slugify(m),
            );
            if (!members.includes(slugify(rule.fallback))) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["layout", i, "facet_rules", fname, "fallback"],
                message: `fallback '${rule.fallback}' is not a member of vocabulary '${rule.vocabulary}' (a fallback segment must be a valid domain)`,
              });
            }
          }
        }
      }
    });
  });

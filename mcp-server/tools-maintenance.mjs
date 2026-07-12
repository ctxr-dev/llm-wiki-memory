import { z } from "zod";
import { wikiRoot } from "../scripts/lib/env.mjs";
import { getImpl, getReloadSeq } from "./mcp-reload.mjs";
import { jsonResponse, errorResponse } from "./mcp-responses.mjs";
import { ScopesSchema, withToolScopes } from "./mcp-scopes.mjs";

/** @typedef {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} McpServer */

/** @param {McpServer} server */
function registerMaintenanceTools(server) {
  server.registerTool(
    "consolidate_memory",
    {
      title: "Run search-driven memory consolidation",
      description:
        "Run the AutoDream-style consolidation orchestrator. For each active leaf in self_improvement + knowledge, finds its similarity cluster via internal vector search, then applies deterministic passes (sha256 dedup, lesson-key dedup, cosine archive, staleness flag, orphan archive, compress-archived bodies, embedding-cache GC, index rebuild) and the LLM passes (merge near-duplicate bodies, refresh stale leaves) when enabled. Never hard-deletes; always uses disable_document. Throttled via `consolidate.intervalDays` in settings.yaml when ifDue=true. Internal writes are system-maintenance-tagged so the write-gate exempts them. Daily cron + the hook-less `consolidate` skill rule run this on a schedule; invoke manually only when the user asks. NOT subject to the L3 write-gate (it's a system tool, not a save). Consolidate is BRAIN-ONLY in v1: passing a `target` that resolves to a shared/non-brain mount is refused (shared-target consolidate is deferred to v1.1). REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.",
      inputSchema: {
        dryRun: z.boolean().optional(),
        ifDue: z.boolean().optional(),
        force: z.boolean().optional(),
        llm: z.boolean().optional(),
        passes: z.array(z.string().trim().min(1)).optional(),
        cosineThreshold: z.number().min(0).max(1).optional(),
        target: z.string().trim().min(1).optional(),
        scopes: ScopesSchema,
      },
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { dryRun, ifDue, force, llm, passes, cosineThreshold, target } = args;
        try {
          // Per-call cosine override wrapped in an AsyncLocalStorage frame so
          // concurrent consolidate_memory MCP calls don't trample each other's
          // overrides. The frame disappears when the wrapped function resolves.
          const { withSettingsOverride } = await import("../scripts/lib/settings.mjs");
          const { consolidateMemory } = await import(
            `../scripts/consolidate.mjs?v=${getReloadSeq()}`
          );
          const run = () => consolidateMemory({ dryRun, ifDue, force, llm, passes, target });
          const result =
            cosineThreshold != null
              ? await withSettingsOverride(
                  { consolidate: { cosineThreshold: Number(cosineThreshold) } },
                  run,
                )
              : await run();
          return jsonResponse(result);
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );

  server.registerTool(
    "audit_memory",
    {
      title: "Audit memory for stale or low-quality leaves (list-only)",
      description:
        "Walk categories for cleanup candidates; never mutates. Classes: duplicate-error-pattern (self_improvement lessons sharing an error_pattern), missing-metadata (lessons/bug-root-cause missing required fields). REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.",
      inputSchema: {
        classes: z.array(z.enum(["duplicate-error-pattern", "missing-metadata"])).optional(),
        scopes: ScopesSchema,
      },
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { classes } = args;
        try {
          // Snapshot the implementation for the whole audit: this is the only
          // handler that makes MULTIPLE impl calls (listDocuments + readDocument in a
          // loop), so pinning one version prevents a mid-audit hot-reload from mixing
          // functions across module versions. (Single-call handlers capture their one
          // impl.* reference atomically, so they need no snapshot.)
          const api = getImpl();
          const requested = new Set(
            classes && classes.length ? classes : ["duplicate-error-pattern", "missing-metadata"],
          );
          const findings = [];
          const byErrorPattern = new Map();
          for (const slot of ["self_improvement", "knowledge"]) {
            const { documents } = api.listDocuments({ datasetId: slot, enabled: "true" });
            for (const doc of documents) {
              const { metadata } = api.readDocument({ documentId: doc.id, datasetId: slot });
              if (requested.has("missing-metadata")) {
                const at = metadata.atom_type;
                if (
                  (at === "self-improvement-lesson" || at === "bug-root-cause") &&
                  (!(metadata.area || metadata.project_module) ||
                    (at === "self-improvement-lesson" && !metadata.error_pattern))
                ) {
                  findings.push({
                    class: "missing-metadata",
                    slot,
                    documentId: doc.id,
                    atom_type: at,
                  });
                }
              }
              if (
                requested.has("duplicate-error-pattern") &&
                slot === "self_improvement" &&
                metadata.error_pattern
              ) {
                const key = `${metadata.area || metadata.project_module || ""}:${metadata.error_pattern}`;
                if (!byErrorPattern.has(key)) byErrorPattern.set(key, []);
                byErrorPattern.get(key).push(doc.id);
              }
            }
          }
          if (requested.has("duplicate-error-pattern")) {
            for (const [key, ids] of byErrorPattern) {
              if (ids.length > 1)
                findings.push({ class: "duplicate-error-pattern", key, documentIds: ids });
            }
          }
          return jsonResponse({ ok: true, findings, total: findings.length });
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );

  server.registerTool(
    "reload_layout",
    {
      title: "Force-reload the layout contract + topology caches",
      description:
        "Clear the in-process layout/topology caches so the next operation re-reads <wiki>/.layout/layout.yaml and its sibling to_path/from_path .mjs helpers. Edits are normally picked up automatically (the caches revalidate by file mtime), so you only need this as an explicit escape hatch — e.g. after a copy/restore that preserved mtimes, or to force a refresh immediately. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.",
      inputSchema: { scopes: ScopesSchema },
    },
    async (args) =>
      withToolScopes(args, async () => {
        try {
          const impl = getImpl();
          if (typeof impl.resetLayoutCache === "function") impl.resetLayoutCache();
          const topo = await import("../scripts/lib/topology-runtime.mjs");
          topo.resetTopologyCache();
          return jsonResponse({ ok: true, reloaded: ["layout", "topology"] });
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );

  server.registerTool(
    "validate_layout",
    {
      title: "Validate a wiki's layout contract YAML (schema + line:col errors)",
      description:
        "Parse and schema-validate a layout contract. Reports each problem with a line:column pointer (facet_rules without placement_facets, a vocabulary reference that isn't declared, a fallback that isn't a vocab member, bad topology block, etc.). Inputs: optional `path` (an explicit layout.yaml path) OR optional `wiki_root` (defaults to the env-resolved wiki; reads <wiki_root>/.layout/layout.yaml). Returns {ok, errors:[{line,col,message}]}. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.",
      inputSchema: {
        path: z.string().trim().min(1).optional(),
        wiki_root: z.string().trim().min(1).optional(),
        scopes: ScopesSchema,
      },
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { path: layoutPath, wiki_root } = args;
        try {
          const { validateLayoutFile } = await import("../scripts/lib/layout-validator.mjs");
          const nodePath = await import("node:path");
          const target =
            layoutPath || nodePath.join(wiki_root || wikiRoot(), ".layout", "layout.yaml");
          return jsonResponse(validateLayoutFile(target));
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );

  server.registerTool(
    "validate_topology",
    {
      title: "Pre-flight check that a topology's path compilers round-trip",
      description:
        "Iterates every declared file_kind in the topology, picks sample facets from facet_inputs (examples / enum-first / type defaults), runs pathFor with the round-trip safety net ON, and reports pass/fail per kind. Use BEFORE the first write against a layout to catch ambiguous from_path regexes, dropped facets, or no-placeholder templates. Inputs: optional `wiki_root` (defaults to env-resolved wiki) + optional `category` (defaults to 'issues'). REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.",
      inputSchema: {
        wiki_root: z.string().trim().min(1).optional(),
        category: z.string().trim().min(1).optional(),
        scopes: ScopesSchema,
      },
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { wiki_root, category } = args;
        try {
          const { validateTopologyAgainstSamples } =
            await import("../scripts/lib/topology-validator.mjs");
          const root = wiki_root || wikiRoot();
          const result = await validateTopologyAgainstSamples(root, {
            categoryPath: category || "issues",
          });
          return jsonResponse(result);
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );

  server.registerTool(
    "test_path_compiler",
    {
      title: "Test a custom-topology path compiler",
      description:
        "Dry-run a topology file_kind's path_compiler (or path_template) against caller-supplied facets and return the computed relative path. Use this to sanity-check a layout's topology block before writing real leaves; reports validation errors, runtime errors from the compiler, and any unresolved {variable} placeholders in the result. Reads <wiki>/.layout/layout.yaml (or the supplied `wiki_root` override). REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.",
      inputSchema: {
        file_kind: z.string().trim().min(1),
        facets: z.record(z.string(), z.any()),
        category: z.string().trim().min(1).optional(),
        wiki_root: z.string().trim().min(1).optional(),
        scopes: ScopesSchema,
      },
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { file_kind, facets, category, wiki_root } = args;
        try {
          const { loadTopology, pathFor, validateFacets, findUnresolvedPlaceholders } =
            await import("../scripts/lib/topology-runtime.mjs");
          const root = wiki_root || wikiRoot();
          const topology = await loadTopology(root, { categoryPath: category || "issues" });
          const v = validateFacets(topology, file_kind, facets || {});
          if (!v.ok) {
            return jsonResponse({
              ok: false,
              file_kind,
              facets: facets || {},
              stage: "validate_facets",
              errors: v.errors,
            });
          }
          try {
            const resolved = pathFor(topology, file_kind, facets || {});
            const unresolved = findUnresolvedPlaceholders(resolved);
            return jsonResponse({
              ok: unresolved.length === 0,
              file_kind,
              facets,
              path: resolved,
              unresolved_placeholders: unresolved,
              warnings:
                unresolved.length > 0
                  ? [
                      `compiler left unresolved placeholders in the result: ${unresolved.join(", ")}`,
                    ]
                  : [],
            });
          } catch (err) {
            return jsonResponse({
              ok: false,
              file_kind,
              facets,
              stage: "compile",
              error: /** @type {{ message?: string }} */ (err).message,
            });
          }
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );
}

export { registerMaintenanceTools };

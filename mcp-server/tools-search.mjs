import { z } from "zod";
import { clampSearchResponse } from "../scripts/lib/search-clamp.mjs";
import { getImpl } from "./mcp-reload.mjs";
import { jsonResponse, errorResponse } from "./mcp-responses.mjs";
import { FilterSchema } from "./mcp-schemas.mjs";
import { ScopesSchema, withToolScopes } from "./mcp-scopes.mjs";
import { SectionSchema } from "../scripts/lib/context/enums.mjs";
import { getActiveWikiContext } from "../scripts/lib/wiki-context.mjs";

// The number of levels in the active scope chain, or undefined for a single
// tree. recall_lessons projects to a minimal RecordRecall that DROPS the
// per-hit `resolvedRoot` tag the clamp uses to size the federated body budget,
// so it must pass this count explicitly — otherwise a multi-repo team recall
// falls back to the single-tree budget and blanks lesson bodies too early.
// (search_memory keeps `resolvedRoot` on its hits, so it infers this itself.)
function activeLevelCount() {
  const ctx = getActiveWikiContext();
  return ctx && Array.isArray(ctx.levels) ? ctx.levels.length : undefined;
}

/** @typedef {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} McpServer */
/**
 * Options accepted by `clampSearchResponse`. Declared locally so the MCP call
 * sites type-check while search-clamp.mjs is untyped; every field is optional.
 * @typedef {{ maxChars?: number, fullContent?: boolean, sections?: Array<"frontmatter" | "body">, perHitDefault?: number, levels?: number }} ClampOptions
 */

/** @param {McpServer} server */
function registerSearchTools(server) {
  server.registerTool(
    "search_memory",
    {
      title: "Search project memory",
      description:
        'Search the local wiki memory and return scored chunks. Pass `filters` (atom_type, area, language, task_type, error_pattern, tags) to pre-filter by frontmatter metadata before embedding rank. `area` scopes to a sub-module. `datasets` accepts category names; default searches every category. project_module is the workspace identifier and is auto-injected when you pass `filters` (so results stay within this install). Hit bodies are EXCERPTED by default (~600 chars each + a total budget) so a broad query can\'t overflow the response; pass `fullContent:true` (or read a leaf by id) for whole bodies, or `maxChars` to tune the excerpt width. `sections` chooses what each hit returns: `["frontmatter"]` yields a compact glance view (brief + type + status/progress + tags + priority, NO body) — ideal when you only need to know what a hit IS without spending context on its body; `["body"]` (or omitting `sections`) returns the excerpted body as before; `["frontmatter","body"]` returns both. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.',
      inputSchema: z
        .object({
          query: z.string().trim().min(1).max(1000),
          datasets: z.array(z.string().trim().min(1)).optional(),
          filters: FilterSchema.optional(),
          scoreThreshold: z.number().min(0).max(1).optional(),
          maxResults: z.number().int().min(1).max(50).optional(),
          maxChars: z.number().int().min(80).max(20000).optional(),
          fullContent: z.boolean().optional(),
          sections: z.array(SectionSchema).optional(),
          scopes: ScopesSchema,
        })
        .strict(),
    },
    async (args) =>
      withToolScopes(args, async () => {
        const {
          query,
          datasets,
          filters,
          scoreThreshold,
          maxResults,
          maxChars,
          fullContent,
          sections,
        } = args;
        try {
          const result = await getImpl().searchMemory({
            query,
            datasets,
            filters,
            scoreThreshold,
            maxResults,
            sections,
          });
          return jsonResponse(
            clampSearchResponse(
              result,
              /** @type {ClampOptions} */ ({ maxChars, fullContent, sections }),
            ),
          );
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );

  server.registerTool(
    "recall_lessons",
    {
      title: "Recall relevant self-improvement lessons",
      description:
        'BEFORE a non-trivial task, call this. It scopes to THIS workspace by default (so it returns hits without you guessing a module); nest facets under `filters:{ area, language, task_type, error_pattern }` to narrow — `area` is the sub-module (e.g. frontend/billing/infra). Broadens via a fall-back ladder (drop error_pattern, language, task_type, area, then project_module last) until enough hits; tags is never dropped. When includeKnowledge !== false, up to 2 bug-root-cause/feedback-rule knowledge atoms are appended. `sections:["frontmatter"]` returns a compact glance view (brief + type + status/progress + tags + priority, no body); omit it (or pass `["body"]`) for the excerpted body as before. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.',
      inputSchema: z
        .object({
          query: z.string().trim().min(1).max(1000),
          // Frontmatter facets nest under `filters` (matching search_memory);
          // area scopes to a sub-module, project_module is auto-injected.
          filters: FilterSchema.optional(),
          includeKnowledge: z.boolean().optional(),
          scoreThreshold: z.number().min(0).max(1).optional(),
          maxResults: z.number().int().min(1).max(20).optional(),
          maxChars: z.number().int().min(80).max(20000).optional(),
          fullContent: z.boolean().optional(),
          sections: z.array(SectionSchema).optional(),
          scopes: ScopesSchema,
        })
        .strict(),
    },
    async (allArgs) =>
      withToolScopes(allArgs, async () => {
        const { query, filters, includeKnowledge, scoreThreshold, maxResults } = allArgs;
        const { maxChars, fullContent, sections } = allArgs;
        try {
          return jsonResponse(
            clampSearchResponse(
              await getImpl().recallLessons({
                query,
                ...(filters ?? {}),
                includeKnowledge,
                scoreThreshold,
                maxResults,
                sections,
              }),
              /** @type {ClampOptions} */ ({
                maxChars,
                fullContent,
                sections,
                perHitDefault: 1500,
                levels: activeLevelCount(),
              }),
            ),
          );
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );
}

export { registerSearchTools };

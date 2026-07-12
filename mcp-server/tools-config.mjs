import { z } from "zod";
import { wikiRoot, embedCachePath, defaultProjectModule } from "../scripts/lib/env.mjs";
import { activeBackend } from "../scripts/lib/embed.mjs";
import { getImpl } from "./mcp-reload.mjs";
import { jsonResponse, errorResponse } from "./mcp-responses.mjs";
import { ScopesSchema, withToolScopes } from "./mcp-scopes.mjs";

/** @typedef {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} McpServer */

/** @param {McpServer} server */
function registerConfigTools(server) {
  server.registerTool(
    "get_memory_config",
    {
      title: "Get memory configuration",
      description:
        "Inspect the local LLM-wiki memory configuration (wiki root, embed backend, categories, active LLM provider). The `llm` block reports the resolved provider, model, baseUrl (for openai / openai-compatible), and a cheap local-only `available` probe (CLI on PATH / API key in env). It does NOT touch the network. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.",
      inputSchema: z.object({ scopes: ScopesSchema }).strict(),
    },
    async (args) =>
      withToolScopes(args, async () => {
        try {
          const { health } = await import("../scripts/lib/llm.mjs");
          const llmHealth = await health().catch((err) => ({
            provider: "unknown",
            available: false,
            reason: err?.message || String(err),
          }));
          return jsonResponse({
            wikiRoot: wikiRoot(),
            embedCache: embedCachePath(),
            embedBackend: activeBackend(),
            defaultProjectModule: defaultProjectModule(),
            categories: getImpl().getCategories(),
            llm: llmHealth,
          });
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );

  server.registerTool(
    "reload_provider",
    {
      title: "Re-probe the active LLM provider",
      description:
        "Re-run the cheap availability probe for the resolved LLM provider (CLI on PATH / API key in env / base URL set) and return the same `llm` block `get_memory_config` reports. Use after editing settings/.env or installing a CLI without restarting the MCP server. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.",
      inputSchema: z.object({ scopes: ScopesSchema }).strict(),
    },
    async (args) =>
      withToolScopes(args, async () => {
        try {
          const { health } = await import("../scripts/lib/llm.mjs");
          const llmHealth = await health().catch((err) => ({
            provider: "unknown",
            available: false,
            reason: err?.message || String(err),
          }));
          return jsonResponse({ ok: true, llm: llmHealth });
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );

  server.registerTool(
    "list_datasets",
    {
      title: "List memory categories",
      description:
        "List the wiki memory categories (knowledge, self_improvement, plans, investigations, daily). REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.",
      inputSchema: z.object({ scopes: ScopesSchema }).strict(),
    },
    async (args) =>
      withToolScopes(args, async () => {
        try {
          return jsonResponse(getImpl().listDatasets());
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );
}

export { registerConfigTools };

import { z } from "zod";
import { wikiRoot, embedCachePath, defaultProjectModule } from "../scripts/lib/env.mjs";
import { activeBackend } from "../scripts/lib/embed.mjs";
import { getActiveWikiContext } from "../scripts/lib/wiki-context.mjs";
import { parseLayoutObject } from "../scripts/lib/wiki-layout-parse.mjs";
import { getImpl } from "./mcp-reload.mjs";
import { jsonResponse, errorResponse } from "./mcp-responses.mjs";
import { ScopesSchema, withToolScopes } from "./mcp-scopes.mjs";

/**
 * The resolved scope chain as a caller-facing list, so the LLM can choose an
 * explicit `target` by path (G2) — the only way to distinguish two identical
 * sibling clones (same projectModule, different root/mountDir). Each level also
 * reports its per-wiki policy flags read from that level's own layout: `gated`
 * (category names that require the consent gate — check this before a write) and
 * `autoDistillOff` (categories compile will NOT auto-promote into). The top-level
 * `categories` stays a flat string[] UNION (contract unchanged).
 * @returns {Array<{ root: string, mountDir: string, projectModule: string, ownership: string, depth: number, gated: string[], autoDistillOff: string[] }>}
 */
function resolvedLevels() {
  const ctx = getActiveWikiContext();
  return (ctx?.levels ?? []).map((l) => {
    const parsed = parseLayoutObject(l.layout);
    return {
      root: l.root,
      mountDir: l.mountDir,
      projectModule: l.projectModule,
      ownership: l.ownership,
      depth: l.depth,
      gated: Object.keys(parsed.gatedCategories).filter((c) => parsed.gatedCategories[c] === true),
      autoDistillOff: Object.keys(parsed.autoDistillCategories).filter(
        (c) => parsed.autoDistillCategories[c] === false,
      ),
    };
  });
}

/** @typedef {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} McpServer */

/** @param {McpServer} server */
function registerConfigTools(server) {
  server.registerTool(
    "get_memory_config",
    {
      title: "Get memory configuration",
      description:
        "Inspect the local LLM-wiki memory configuration (wiki root, embed backend, categories, active LLM provider, the resolved scope `levels`, and the `diagrams` / `dedupe` policy you must honour). The `levels` array lists every level in your resolved scope chain — `{root, mountDir, projectModule, ownership, depth, gated, autoDistillOff}` — so you can choose an explicit write `target` by path (the ONLY way to distinguish two identical sibling clones, which share a projectModule but differ by root) AND know each level's write policy: `gated` names the categories that require the consent gate at that level (CHECK it before a write — self_improvement is gated by default; a wiki may opt others in), and `autoDistillOff` names categories compile will not auto-promote into. The `llm` block reports the resolved provider, model, baseUrl (for openai / openai-compatible), and a cheap local-only `available` probe (CLI on PATH / API key in env). It does NOT touch the network. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.",
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
          const { diagrams, dedupe } = await import("../scripts/lib/settings.mjs").then((m) =>
            m.settings(),
          );
          return jsonResponse({
            wikiRoot: wikiRoot(),
            embedCache: embedCachePath(),
            embedBackend: activeBackend(),
            defaultProjectModule: defaultProjectModule(),
            levels: resolvedLevels(),
            categories: getImpl().scopedCategories(),
            // Policy an AGENT has to honour, so it has to be readable BY the
            // agent: a setting nothing can read instructs nobody. `diagrams.mode`
            // decides SVG vs mermaid; the dedupe thresholds explain why a save
            // was refused as a duplicate or reported a near neighbour.
            diagrams,
            dedupe,
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

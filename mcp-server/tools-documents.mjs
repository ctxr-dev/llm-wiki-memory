import { z } from "zod";
import { withWikiCommit } from "../scripts/lib/wiki-commit.mjs";
import { getImpl } from "./mcp-reload.mjs";
import { jsonResponse, errorResponse } from "./mcp-responses.mjs";
import { ScopesSchema, withToolScopes } from "./mcp-scopes.mjs";

/** @typedef {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} McpServer */

// The mutate tools keep taking a RELATIVE documentId and operate on the context
// write-default, which is the brain today (single-tree case). Full
// explicit-scope-per-mutation (targeting a chosen level) lands with the Phase F
// write-routing work; this step only adds the required `scopes` arg, so a
// mutation still resolves against the same one root as before.
/** @param {McpServer} server */
function registerDocumentTools(server) {
  server.registerTool(
    "disable_document",
    {
      title: "Archive a document (hide from recall) without deleting",
      description:
        "Soft-delete: mark a leaf archived so search_memory / recall_lessons skip it, while keeping it on disk and in git history. Reversible via enable_document. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.",
      inputSchema: {
        dataset: z.string().trim().min(1),
        documentId: z.string().trim().min(1),
        scopes: ScopesSchema,
      },
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { dataset, documentId } = args;
        try {
          return jsonResponse(
            withWikiCommit({ op: "mcp-disable", actor: "mcp" }, () =>
              getImpl().disableDocument({ documentId, datasetId: dataset }),
            ),
          );
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );

  server.registerTool(
    "enable_document",
    {
      title: "Re-enable a previously archived document",
      description:
        "Symmetric counterpart to disable_document: brings an archived leaf back into recall results. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.",
      inputSchema: {
        dataset: z.string().trim().min(1),
        documentId: z.string().trim().min(1),
        scopes: ScopesSchema,
      },
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { dataset, documentId } = args;
        try {
          return jsonResponse(
            withWikiCommit({ op: "mcp-enable", actor: "mcp" }, () =>
              getImpl().enableDocument({ documentId, datasetId: dataset }),
            ),
          );
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );

  server.registerTool(
    "delete_document",
    {
      title: "Delete a document (PERMANENT on disk; recoverable via git)",
      description:
        "Permanently remove a leaf file. Prefer disable_document unless you are sure. Primary safe use: clean up a stale plan-<old-slug>.md after a rename. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.",
      inputSchema: {
        dataset: z.string().trim().min(1),
        documentId: z.string().trim().min(1),
        scopes: ScopesSchema,
      },
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { dataset, documentId } = args;
        try {
          return jsonResponse(
            withWikiCommit({ op: "mcp-delete", actor: "mcp" }, () =>
              getImpl().deleteDocument({ documentId, datasetId: dataset }),
            ),
          );
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );

  server.registerTool(
    "move_document",
    {
      title: "Relocate a curated leaf to a new path (preserves content, embedding, indexes)",
      description:
        'Move a leaf to a new path within the CURATED human zone, preserving its content + embedding and refreshing both the source and destination index.md. Free-path moves are only for curated (consolidate:none, non-facet) categories — facet categories relocate via metadata (save_to_dataset / write_memory), and topology categories via a compiler-derived path; moves into/out of those are refused. Also refuses a destination collision or a missing source. toPath is a wiki-relative dir + filename, e.g. "Notes/Testing/My Note.md". REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.',
      inputSchema: {
        dataset: z.string().trim().min(1).optional(),
        documentId: z.string().trim().min(1),
        toPath: z.string().trim().min(1).max(500),
        scopes: ScopesSchema,
      },
    },
    async (args) =>
      withToolScopes(args, async () => {
        const { dataset, documentId, toPath } = args;
        try {
          return jsonResponse(
            withWikiCommit({ op: "mcp-move", actor: "mcp" }, () =>
              getImpl().moveDocument({ documentId, datasetId: dataset, toPath }),
            ),
          );
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );
}

export { registerDocumentTools };

import { z } from "zod";
import { withWikiCommit } from "../scripts/lib/wiki-commit.mjs";
import { getImpl } from "./mcp-reload.mjs";
import { jsonResponse, errorResponse } from "./mcp-responses.mjs";
import { ScopesSchema, withToolScopes } from "./mcp-scopes.mjs";
import { withResolvedWriteTarget } from "./mcp-write-target.mjs";
import { getActiveWikiContext } from "../scripts/lib/wiki-context.mjs";
import { parseMutateRequest, MUTATE_OP } from "../scripts/lib/context/mutate.mjs";
import { MCP_OPS, MCP_ACTOR } from "../scripts/lib/context/enums.mjs";

/** @typedef {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} McpServer */
/** @typedef {import("../scripts/lib/context/mutate.mjs").MutateRequest} MutateRequest */
/** @typedef {import("../scripts/lib/context/mutate.mjs").MutateOp} MutateOp */

// A mutate resolves its RELATIVE `documentId` against the chosen `target`
// level's root (via the resolved-target withWikiRoot frame), NOT the brain
// default. Omitted -> the brain (writeDefault), so single-tree behaviour is
// byte-identical.
const TargetSchema = z.string().trim().min(1).optional();
const TARGET_DESCRIPTION =
  ' Optional top-level `target` selects which scope the relative `select.documentId` resolves against: a context level\'s wiki root or mount directory, or "brain". Omitted, it resolves against your brain (private memory). Inputs are a single nested context object; unknown keys are rejected.';

// The leaf a mutate acts on. disable/enable/delete need `dataset` + `documentId`;
// move needs `documentId` + `toPath` and an OPTIONAL `dataset`.
const SelectSchema = z
  .object({
    dataset: z.string().trim().min(1),
    documentId: z.string().trim().min(1),
  })
  .strict();
const MoveSelectSchema = z
  .object({
    documentId: z.string().trim().min(1),
    toPath: z.string().trim().min(1).max(500),
    dataset: z.string().trim().min(1).optional(),
  })
  .strict();

const MUTATE_COMMIT = Object.freeze({
  [MUTATE_OP.DISABLE]: MCP_OPS.DISABLE,
  [MUTATE_OP.ENABLE]: MCP_OPS.ENABLE,
  [MUTATE_OP.DELETE]: MCP_OPS.DELETE,
  [MUTATE_OP.MOVE]: MCP_OPS.MOVE,
});

/**
 * Run the store mutation for a parsed op. The store owns the faceted/topology/
 * daily move refusal and the disable/enable/delete not-found handling — those
 * stay runtime invariants; this only routes the op to its store method.
 * @param {MutateOp} op
 * @param {{ documentId: string, datasetId: string | undefined, toPath: string | undefined }} sel
 */
function storeMutate(op, { documentId, datasetId, toPath }) {
  const impl = getImpl();
  if (op === MUTATE_OP.DISABLE) return impl.disableDocument({ documentId, datasetId });
  if (op === MUTATE_OP.ENABLE) return impl.enableDocument({ documentId, datasetId });
  if (op === MUTATE_OP.DELETE) return impl.deleteDocument({ documentId, datasetId });
  return impl.moveDocument({ documentId, datasetId, toPath: /** @type {string} */ (toPath) });
}

/**
 * Dispatch a parsed MutateRequest into its already-resolved target: bind the
 * withWikiRoot frame to the chosen level (so a relative `documentId` resolves
 * against THAT level, not the brain), run the store mutation under one wiki
 * commit, and shape the JSON response.
 * @param {MutateRequest} req
 */
function dispatchMutate(req) {
  const { op, dataset, documentId, toPath, target } = req;
  return withResolvedWriteTarget(target, () =>
    jsonResponse(
      withWikiCommit({ op: MUTATE_COMMIT[op], actor: MCP_ACTOR }, () =>
        storeMutate(op, { documentId, datasetId: dataset, toPath }),
      ),
    ),
  );
}

/**
 * @param {string} op
 * @param {{ select: { dataset?: string, documentId: string, toPath?: string }, target?: string }} args
 */
function runMutate(op, args) {
  const { select, target } = args;
  const req = parseMutateRequest(getActiveWikiContext(), {
    op,
    dataset: select.dataset,
    documentId: select.documentId,
    toPath: select.toPath,
    target,
  });
  return dispatchMutate(req);
}

/** @param {McpServer} server */
function registerDocumentTools(server) {
  server.registerTool(
    "disable_document",
    {
      title: "Archive a document (hide from recall) without deleting",
      description:
        "Soft-delete: mark a leaf archived so search_memory / recall_lessons skip it, while keeping it on disk and in git history. Reversible via enable_document. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki." +
        TARGET_DESCRIPTION,
      inputSchema: z
        .object({ target: TargetSchema, select: SelectSchema, scopes: ScopesSchema })
        .strict(),
    },
    async (args) =>
      withToolScopes(args, async () => {
        try {
          return runMutate(MUTATE_OP.DISABLE, args);
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
        "Symmetric counterpart to disable_document: brings an archived leaf back into recall results. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki." +
        TARGET_DESCRIPTION,
      inputSchema: z
        .object({ target: TargetSchema, select: SelectSchema, scopes: ScopesSchema })
        .strict(),
    },
    async (args) =>
      withToolScopes(args, async () => {
        try {
          return runMutate(MUTATE_OP.ENABLE, args);
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
        "Permanently remove a leaf file. Prefer disable_document unless you are sure. Primary safe use: clean up a stale plan-<old-slug>.md after a rename. REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki." +
        TARGET_DESCRIPTION,
      inputSchema: z
        .object({ target: TargetSchema, select: SelectSchema, scopes: ScopesSchema })
        .strict(),
    },
    async (args) =>
      withToolScopes(args, async () => {
        try {
          return runMutate(MUTATE_OP.DELETE, args);
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
        'Move a leaf to a new path within the CURATED human zone, preserving its content + embedding and refreshing both the source and destination index.md. Send `select:{documentId, toPath, dataset?}`. Free-path moves are only for curated (consolidate:none, non-facet) categories — facet categories relocate via metadata (save_to_dataset / write_memory), and topology categories via a compiler-derived path; moves into/out of those are refused. Also refuses a destination collision or a missing source. select.toPath is a wiki-relative dir + filename, e.g. "Notes/Testing/My Note.md". REQUIRES `scopes`: the directories you are working in (your cwd and any repos in play); the engine walks up to your home wiki.' +
        TARGET_DESCRIPTION,
      inputSchema: z
        .object({ target: TargetSchema, select: MoveSelectSchema, scopes: ScopesSchema })
        .strict(),
    },
    async (args) =>
      withToolScopes(args, async () => {
        try {
          return runMutate(MUTATE_OP.MOVE, args);
        } catch (error) {
          return errorResponse(error);
        }
      }),
  );
}

export { registerDocumentTools };

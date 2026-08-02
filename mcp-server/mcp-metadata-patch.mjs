import { z } from "zod";
import { withWikiCommit } from "../scripts/lib/wiki-commit.mjs";
import { getImpl } from "./mcp-reload.mjs";
import { jsonResponse } from "./mcp-responses.mjs";
import { withResolvedWriteTarget, annotateSharedWrite } from "./mcp-write-target.mjs";
import { guardScarcePriority, targetsGatedCategory, auditGatedL3 } from "./mcp-write-gate.mjs";
import { MetadataSchema } from "./mcp-schemas.mjs";
import { getActiveWikiContext } from "../scripts/lib/wiki-context.mjs";
import { parseMutateRequest, MUTATE_OP } from "../scripts/lib/context/mutate.mjs";
import { ContextValidationError } from "../scripts/lib/context/errors.mjs";
import { MCP_OPS, MCP_ACTOR } from "../scripts/lib/context/enums.mjs";

/** @typedef {import("../scripts/lib/context/mutate.mjs").MutateRequest} MutateRequest */

const TOOL = "update_document_metadata";

// `status` is admitted by the schema ONLY so `.strict()` does not fire zod's
// generic "unrecognized key" — it is refused below with an actionable envelope
// naming the doors that own it, and never applied.
const MetadataPatchSchema = MetadataSchema.extend({ status: z.string().optional() }).strict();

export const MetadataSelectSchema = z
  .object({
    documentId: z.string().trim().min(1),
    metadata: MetadataPatchSchema,
    dataset: z.string().trim().min(1).optional(),
    pin: z.boolean().optional(),
  })
  .strict();

/**
 * Dispatch a parsed metadata patch: bind the target frame, coerce a scarce
 * priority, remap out-of-vocab placement facets (skipped when pinned — a pinned
 * patch does not place), run the store update under one commit, audit a
 * gated-category leaf, and report where the leaf ENDED UP. Deliberately separate
 * from the four body-less mutates so those carry no new risk.
 * @param {MutateRequest} req
 */
function dispatchMetadataMutate(req) {
  const { dataset, documentId, metadata, placementOverride, target } = req;
  const category = dataset || String(documentId).split("/")[0];
  const pinned = placementOverride !== undefined;
  return withResolvedWriteTarget(target, (level) => {
    const { metadata: guarded, note: priorityNote } = guardScarcePriority(metadata, undefined);
    const { metadata: placed, remaps } = pinned
      ? { metadata: guarded, remaps: [] }
      : getImpl().remapUnknownPathFacets(category, guarded);
    const result = /** @type {import("../scripts/lib/types.mjs").MutationResult} */ (
      withWikiCommit({ op: MCP_OPS.UPDATE_METADATA, actor: MCP_ACTOR }, () =>
        getImpl().updateDocMetadata({
          documentId,
          datasetId: dataset,
          metadata: placed,
          placementOverride,
        }),
      )
    );
    if (result.ok && targetsGatedCategory(category, documentId, level.layout)) {
      auditGatedL3({
        tool: TOOL,
        status: "accepted",
        userRequested: undefined,
        title: documentId,
        metadata: placed,
        action: "update",
      });
    }
    const relocatedTo = result.relocated ? result.relocated.to : undefined;
    return jsonResponse(
      annotateSharedWrite(level, {
        .../** @type {Record<string, unknown>} */ (result),
        ...(result.ok
          ? {
              documentId: relocatedTo || documentId,
              placement: pinned ? "pinned" : relocatedTo ? "relocated" : "unchanged",
            }
          : {}),
        ...(priorityNote ? { priorityNote } : {}),
        ...(remaps.length ? { facetRemap: remaps } : {}),
      }),
    );
  });
}

/**
 * @param {{ select: { documentId: string, metadata: Record<string, unknown>, dataset?: string, pin?: boolean }, target?: string }} args
 */
export function runMetadataMutate(args) {
  const { select, target } = args;
  if (select.metadata && select.metadata.status !== undefined) {
    throw new ContextValidationError({
      field: "status",
      allowed: ["disable_document", "enable_document"],
      reason:
        "status is not patchable via metadata — disable_document / enable_document own it (they also update the embedding cache). For a plan, status is DERIVED from its checkboxes and re-synced on every edit, so a patched value would be overwritten anyway.",
    });
  }
  return dispatchMetadataMutate(
    parseMutateRequest(getActiveWikiContext(), {
      op: MUTATE_OP.METADATA,
      dataset: select.dataset,
      documentId: select.documentId,
      metadata: select.metadata,
      pin: select.pin,
      target,
    }),
  );
}

import { writeGateSelfImprovementEnabled } from "../scripts/lib/settings.mjs";
import { withWikiCommit } from "../scripts/lib/wiki-commit.mjs";
import { isSystemMaintenance } from "../scripts/lib/maintenance-tag.mjs";
import { getImpl } from "./mcp-reload.mjs";
import { jsonResponse } from "./mcp-responses.mjs";
import {
  assertTopologyPathValid,
  refuseWriteGate,
  targetsGatedCategory,
  auditGatedL3,
  guardScarcePriority,
} from "./mcp-write-gate.mjs";
import { withResolvedWriteTarget, annotateSharedWrite } from "./mcp-write-target.mjs";
import { MCP_ACTOR, OWNERSHIP } from "../scripts/lib/context/enums.mjs";
import { getActiveWikiContext } from "../scripts/lib/wiki-context.mjs";
import { resolveProjectModuleIdentity } from "../scripts/lib/project-identity.mjs";

/** @typedef {import("../scripts/lib/types.mjs").MetadataInput} MetadataInput */
/** @typedef {import("../scripts/lib/types.mjs").WriteResult} WriteResult */
/** @typedef {import("../scripts/lib/context/write.mjs").WriteRequest} WriteRequest */

/**
 * The L3 gate REFUSAL, decided from RAW args (no resolved context needed) so it
 * runs BEFORE parse-time input validation — a gated write without consent is
 * refused and audited regardless of any other malformed field, preserving the
 * gate-first precedence and a complete refused-audit trail (C8). Returns the
 * refusal response, or null to proceed.
 * @param {{ tool: string, dataset: string, path?: string, name: string, metadata?: MetadataInput, userRequested?: boolean, refuseLabel: string }} a
 * @returns {ReturnType<typeof refuseWriteGate> | null}
 */
export function gateRefusal(a) {
  if (
    targetsGatedCategory(a.dataset, a.path) &&
    writeGateSelfImprovementEnabled() &&
    a.userRequested !== true &&
    !isSystemMaintenance()
  ) {
    auditGatedL3({
      tool: a.tool,
      status: "refused",
      userRequested: a.userRequested,
      title: a.name,
      metadata: a.metadata,
    });
    return refuseWriteGate(a.refuseLabel);
  }
  return null;
}

/**
 * Stamp a repo-owned target's leaf with the deterministic project-module identity
 * (the `//` chain of repo-owned levels at/above the target), so a shared-repo write
 * carries the repo's stable `org/repo` (or `file://` fallback) rather than the brain
 * default. A brain (wiki-owned) target is left to `defaultProjectModule`; a caller's
 * explicit `project_module_override` wins.
 * @param {import("../scripts/lib/wiki-context.mjs").WikiLevel} level
 * @param {MetadataInput | undefined} metadata
 * @returns {MetadataInput | undefined}
 */
function stampRepoIdentity(level, metadata) {
  if (level.ownership !== OWNERSHIP.REPO) return metadata;
  const md = metadata && typeof metadata === "object" ? metadata : {};
  if (md.project_module_override) return metadata;
  const ctx = getActiveWikiContext();
  if (!ctx) return metadata;
  return { ...md, project_module_override: resolveProjectModuleIdentity(ctx, level) };
}

/**
 * Dispatch a parsed WriteRequest (save_lesson / save_to_dataset / write_memory):
 * route into the already-resolved target, then INSIDE the target frame validate
 * topology, coerce a scarce priority, remap out-of-vocab facets against the target
 * layout (skipped when an explicit `path` is given), run `doWrite(placed)` under
 * one commit, audit an accepted gated write (C8), and shape the response
 * (shared-target note + priority/remap notes). The gate REFUSAL was already
 * decided by {@link gateRefusal} before this runs.
 * @param {WriteRequest} req
 * @param {(placed: MetadataInput | undefined) => WriteResult} doWrite
 * @param {{ tool: string, op: string, okFromCreated?: boolean }} cfg
 */
export async function dispatchWrite(req, doWrite, cfg) {
  const { gated, target, dataset, path, metadata, userRequested } = req;
  const name = /** @type {string} */ (req.name);
  return await withResolvedWriteTarget(target, async (level) => {
    await assertTopologyPathValid({ dataset, name, path });
    const { metadata: md, note: priorityNote } = guardScarcePriority(metadata, userRequested);
    // Facet placement (only when no explicit path) pre-validates against the
    // target layout, remapping an out-of-vocab subject to `general` rather than
    // throwing (R2).
    const { metadata: placed, remaps } = path
      ? { metadata: md, remaps: [] }
      : getImpl().remapUnknownPathFacets(dataset, md);
    const stamped = stampRepoIdentity(level, placed);
    const result = /** @type {WriteResult} */ (
      withWikiCommit({ op: cfg.op, actor: MCP_ACTOR }, () => doWrite(stamped))
    );
    if (gated) {
      auditGatedL3({
        tool: cfg.tool,
        status: "accepted",
        userRequested,
        title: name,
        metadata: placed,
      });
    }
    return jsonResponse(
      annotateSharedWrite(level, {
        ...(cfg.okFromCreated ? { ok: !!result.created } : {}),
        .../** @type {Record<string, unknown>} */ (result),
        ...(priorityNote ? { priorityNote } : {}),
        ...(remaps.length ? { facetRemap: remaps } : {}),
      }),
    );
  });
}

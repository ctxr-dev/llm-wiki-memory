import { writeGateEnabled } from "../scripts/lib/settings.mjs";
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
import { judgeInteractiveSubmission } from "./mcp-judge-gate.mjs";
import { MCP_ACTOR, OWNERSHIP, SELF_IMPROVEMENT } from "../scripts/lib/context/enums.mjs";
import { getActiveWikiContext } from "../scripts/lib/wiki-context.mjs";
import { parseTarget } from "../scripts/lib/context/target.mjs";
import { resolveProjectModuleIdentity } from "../scripts/lib/project-identity.mjs";

/** @typedef {import("../scripts/lib/types.mjs").MetadataInput} MetadataInput */
/** @typedef {import("../scripts/lib/types.mjs").WriteResult} WriteResult */
/** @typedef {import("../scripts/lib/context/write.mjs").WriteRequest} WriteRequest */

// Resolve JUST the target level's layout for the gate decision, WITHOUT the full
// field validation (that comes later in parseWriteRequest). Whether a category
// is gated is now layout-driven, so the gate must read the TARGET wiki's layout.
// FAIL-CLOSED: any resolution error (bad/absent target, unreadable context) →
// null, which callers treat as "gated" so the write is refused rather than
// silently slipping through the gate. `env`/`target` may be absent on legacy
// callers → also fail-closed.
/**
 * @param {{ env?: unknown, target?: string | null }} a
 * @returns {Record<string, unknown> | null}
 */
function resolveTargetLayout(a) {
  try {
    const env = /** @type {import("../scripts/lib/wiki-context.mjs").WikiContext} */ (
      a.env ?? getActiveWikiContext()
    );
    const resolved = parseTarget(env, a.target);
    return /** @type {Record<string, unknown> | null} */ (resolved.level.layout);
  } catch {
    return null;
  }
}

/**
 * The L3 gate REFUSAL. Resolves the TARGET level's layout up front (so gating is
 * layout-driven) but BEFORE parse-time field validation — a gated write without
 * consent is refused and audited regardless of any other malformed field,
 * preserving gate-first precedence and a complete refused-audit trail (C8). A
 * target that cannot be resolved fails CLOSED (treated as gated). Returns the
 * refusal response, or null to proceed.
 * @param {{ tool: string, dataset: string, path?: string, name: string, metadata?: MetadataInput, userRequested?: boolean, refuseLabel: string, env?: unknown, target?: string | null }} a
 * @returns {ReturnType<typeof refuseWriteGate> | null}
 */
export function gateRefusal(a) {
  let gated;
  try {
    // save_lesson is CONSTRUCTION-gated: it always writes a self_improvement
    // lesson, so it stays gated regardless of a layout that opts self_improvement
    // out (decision F8) — the lesson path must not silently un-gate. Otherwise
    // the gated set is layout-driven; a null layout (resolve error) fails closed.
    const layout = resolveTargetLayout(a);
    gated =
      a.tool === "save_lesson" ||
      (layout === null ? true : targetsGatedCategory(a.dataset, a.path, layout));
  } catch {
    gated = true;
  }
  if (gated && writeGateEnabled() && a.userRequested !== true && !isSystemMaintenance()) {
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

// The refusal label shown when a gated write lacks consent. save_lesson is always
// gated; the dataset tools name the dataset (or the path landing in a gated
// category) so the client sees exactly what to fix.
/**
 * @param {string} tool
 * @param {string} dataset
 * @param {string} [path]
 * @returns {string}
 */
function gateLabel(tool, dataset, path) {
  if (tool === "save_lesson") return "save_lesson";
  const key = tool === "write_memory" ? "datasetId" : "dataset";
  return dataset === SELF_IMPROVEMENT
    ? `${tool}(${key}="${SELF_IMPROVEMENT}")`
    : `${tool}(path="${path}" lands in a gated category)`;
}

// The two pre-write gates an interactive tool runs in order: the L3 consent gate
// ({@link gateRefusal}) then the quality judge ({@link judgeInteractiveSubmission}).
// Returns `{ blocked }` with the response to return early (a consent refusal or a
// judge rejection), else `{ writeMetadata }` — the metadata to persist, stamped
// `quality:"unverified"` when the judge kept a flagged best attempt.
/**
 * @param {{ tool: string, dataset: string, path?: string, name: string, text: string, metadata?: MetadataInput, userRequested?: boolean, target: string, acceptQuality?: boolean }} a
 * @returns {Promise<{ blocked?: ReturnType<typeof refuseWriteGate>, writeMetadata?: MetadataInput }>}
 */
export async function runWriteGates(a) {
  const refusal = gateRefusal({
    tool: a.tool,
    dataset: a.dataset,
    path: a.path,
    name: a.name,
    metadata: a.metadata,
    userRequested: a.userRequested,
    refuseLabel: gateLabel(a.tool, a.dataset, a.path),
    env: getActiveWikiContext(),
    target: a.target,
  });
  if (refusal) return { blocked: refusal };
  const judgeGate = await judgeInteractiveSubmission({
    dataset: a.dataset,
    title: a.name,
    body: a.text,
    acceptQuality: a.acceptQuality,
  });
  if (judgeGate.block) return { blocked: judgeGate.response };
  const writeMetadata = judgeGate.flagged
    ? { ...(a.metadata || {}), quality: "unverified" }
    : a.metadata;
  return { writeMetadata };
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

import { writeGateEnabled } from "../scripts/lib/settings.mjs";
import { withWikiCommit } from "../scripts/lib/wiki-commit.mjs";
import { isSystemMaintenance } from "../scripts/lib/maintenance-tag.mjs";
import { getImpl } from "./mcp-reload.mjs";
import { jsonResponse } from "./mcp-responses.mjs";
import { settings } from "../scripts/lib/settings.mjs";
import { probeForDuplicate, duplicateRefusal } from "../scripts/lib/dedupe-probe.mjs";
import {
  assertTopologyPathValid,
  refuseWriteGate,
  refuseInlineBody,
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
  if (dataset === SELF_IMPROVEMENT) return `${tool}(${key}="${SELF_IMPROVEMENT}")`;
  // A path (if given) determines the landing category; otherwise the gated
  // dataset itself is the reason — name it rather than emitting path="undefined".
  return path
    ? `${tool}(path="${path}" lands in a gated category)`
    : `${tool}(${key}="${dataset}" is a gated category)`;
}

// The three pre-write gates an interactive tool runs IN ORDER: the L3 consent gate
// ({@link gateRefusal}), the inline-body size bound ({@link refuseInlineBody}),
// then the quality judge ({@link judgeInteractiveSubmission}).
//
// The order is load-bearing in both directions. Consent stays FIRST (C8): a gated
// write with no consent must be refused and audited as a consent violation
// whatever else is wrong with it. The size bound goes BEFORE the judge because the
// judge is an LLM round-trip — refusing afterwards would burn a provider call on a
// body we were never going to store.
//
// Returns `{ blocked }` with the response to return early (a consent refusal, a
// size refusal, a judge rejection, or a suspected duplicate), else
// `{ writeMetadata }` — the metadata to persist, stamped `quality:"unverified"`
// when the judge kept a flagged best attempt — plus `related` when a near
// neighbour exists that is NOT close enough to refuse.
/**
 * @param {{ tool: string, dataset: string, path?: string, name: string, text: string, metadata?: MetadataInput, userRequested?: boolean, target: string, acceptQuality?: boolean, allowDuplicate?: boolean }} a
 * @returns {Promise<{ blocked?: ReturnType<typeof refuseWriteGate>, writeMetadata?: MetadataInput, related?: import("../scripts/lib/dedupe-probe.mjs").DuplicateVerdict }>}
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
  const oversize = refuseInlineBody(a.tool, a.text);
  if (oversize) return { blocked: oversize };
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

  // Duplicate probe, LAST of the gates: it costs an embedding plus a category
  // scan, so it runs only after the cheap refusals (consent, oversize body,
  // quality) have passed. It lives in this shared seam rather than in each tool
  // handler so every write door is covered by construction; a probe wired
  // per-handler is a probe that one door eventually forgets.
  const { dedupe } = settings();
  const dup = a.allowDuplicate
    ? /** @type {import("../scripts/lib/dedupe-probe.mjs").DuplicateVerdict} */ ({
        verdict: "none",
        score: 0,
      })
    : await probeForDuplicate({
        dataset: a.dataset,
        name: a.name,
        text: a.text,
        metadata: a.metadata,
        thresholds: dedupe,
      });
  if (dup.verdict === "duplicate") {
    return {
      blocked: jsonResponse({
        error: "duplicate-suspected",
        detail: duplicateRefusal(dup),
        documentId: dup.documentId,
        score: dup.score,
      }),
    };
  }
  return { writeMetadata, related: dup.verdict === "related" ? dup : undefined };
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

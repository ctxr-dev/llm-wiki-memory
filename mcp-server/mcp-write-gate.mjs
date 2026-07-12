import { wikiRoot } from "../scripts/lib/env.mjs";
import { enforceP0Scarcity } from "../scripts/lib/datasets.mjs";
import { isSystemMaintenance } from "../scripts/lib/maintenance-tag.mjs";
import { recordGatedWrite, consentBasis } from "../scripts/lib/save-gate-audit.mjs";
import { isGatedWrite } from "../scripts/lib/context/write.mjs";
import { loadTopology, parsePath } from "../scripts/lib/topology-runtime.mjs";
import { getImpl } from "./mcp-reload.mjs";
import { jsonResponse } from "./mcp-responses.mjs";
import { PLAN_SUFFIX, KIND } from "../scripts/lib/context/enums.mjs";

/** @typedef {import("../scripts/lib/types.mjs").MetadataInput} MetadataInput */
/** @typedef {import("../scripts/lib/types.mjs").Priority} Priority */

// Topology categories (e.g. tracker `issues`) nest via the path-compiler, not
// facet placement. Reject a no-path write up front with an actionable message
// (the wiki-store sync guard would also throw, but later and less helpfully),
// and validate that a SUPPLIED path actually round-trips through the topology
// for the leaf's file_kind — so a wrong-shape path can never silently misplace
// a leaf. parsePath anchors on the FILENAME, so validate the full leaf path.
/**
 * @param {{ dataset: string, name: string, path?: string | null }} args
 */
async function assertTopologyPathValid({ dataset, name, path: placePath }) {
  const impl = getImpl();
  if (typeof impl.categoryHasTopology !== "function" || !impl.categoryHasTopology(dataset)) return;
  const supplied = placePath !== undefined && placePath !== null && String(placePath).trim() !== "";
  if (!supplied) {
    throw new Error(
      `save to "${dataset}" requires an explicit path: that category has a topology block in .layout/layout.yaml. ` +
        `Consult the layout and compute the path from the file_kind facets (e.g. issues plan -> issues/<tracker>/<prefix>/<buckets>/<lifecycle>/<file>.plan.md), then pass it as path.`,
    );
  }
  const topo = await loadTopology(wikiRoot(), { categoryPath: dataset });
  const { name: safeName } = impl.normalizeLeafNamePreservingCase(name);
  const dir = String(placePath).replace(/\/+$/, "");
  // `path` is a DIRECTORY; the leaf name is appended. A caller that mistakenly
  // put the filename in `path` would otherwise double it into a dir-named-like-
  // a-file that a greedy slug matcher can still parse — reject it explicitly.
  if (dir.endsWith(`/${safeName}`) || dir === safeName) {
    throw new Error(
      `path "${placePath}" must be the DIRECTORY only — the leaf name "${safeName}" is appended automatically; do not include it in path.`,
    );
  }
  const rel = `${dir}/${safeName}`;
  const parsed = parsePath(topo, rel);
  if (!parsed) {
    throw new Error(
      `path "${placePath}" does not match the "${dataset}" topology in .layout/layout.yaml (no file_kind parses ${rel}).`,
    );
  }
  const kind = safeName.endsWith(PLAN_SUFFIX) ? KIND.PLAN : KIND.KNOWLEDGE;
  if (parsed.kind !== kind) {
    throw new Error(
      `path "${placePath}" resolves to topology kind "${parsed.kind}", but leaf name "${safeName}" implies "${kind}".`,
    );
  }
}

// L3 of the memory-write hardening stack. Refuses gated self_improvement
// writes that lack `userRequested:true` UNLESS the call is inside a
// system-maintenance scope (the consolidate orchestrator runs every internal
// write under `withSystemMaintenance(...)` — see
// scripts/lib/maintenance-tag.mjs). The exemption is impossible to set from
// outside the orchestrator process (AsyncLocalStorage frame, not an
// arg / env var). Returning a structured error instead of throwing lets the
// model see and act on the refusal in the next turn.
/** @param {string} toolName */
function refuseWriteGate(toolName) {
  return jsonResponse({
    ok: false,
    error: "write-gate-refused",
    message: `${toolName} refused: self_improvement writes require userRequested:true (propose to the user in chat and wait for explicit yes; only then call the tool with the flag). The discipline rule in your initialize-time instructions documents the contract. Knowledge / plans / investigations / daily / issues writes are NOT gated and do not require the flag.`,
  });
}

// True iff the resolved write would land under the self_improvement category,
// regardless of the declared `dataset` field. Closes the gate-bypass where a
// caller passes `dataset:"knowledge"` (or any non-gated value) together with
// `path:"self_improvement/..."`. The L3 gate routes through this so the
// effective target — not the caller's claim — governs the refusal.
/**
 * @param {string} dataset
 * @param {string | undefined} placementOverride
 * @returns {boolean}
 */
function targetsGatedCategory(dataset, placementOverride) {
  return isGatedWrite(dataset, placementOverride);
}

// Append an L3 audit record for a gated-category decision. Best-effort: the
// underlying recordGatedWrite never throws and is a no-op when auditing is off,
// so this can never change a gate decision or fail a write. `consent` is derived
// from the same inputs the gate used, so the ledger shows WHY a write landed: an
// explicit user flag, a system-maintenance frame (consolidate), or a disabled gate.
/**
 * @param {{ tool: string, status: "accepted" | "refused", userRequested: boolean | undefined, title: string, metadata?: MetadataInput }} args
 */
function auditGatedL3({ tool, status, userRequested, title, metadata }) {
  const consent =
    status === "accepted" ? consentBasis(userRequested, isSystemMaintenance()) : undefined;
  recordGatedWrite({
    layer: "L3",
    tool,
    status,
    consent,
    title,
    area: metadata?.area,
    error_pattern: metadata?.error_pattern,
    priority: metadata?.priority,
    userRequested,
  });
}

// P0 is the scarce "hard constraint" tier. A write may set priority:"P0" only
// with an explicit consent signal — an in-turn user flag (userRequested) or a
// system-maintenance frame. Otherwise coerce to P1 so the write still succeeds,
// and report the coercion (never silent) so the caller can re-request via the
// gated/explicit path. Keeps P0 trustworthy without failing the write.
/**
 * @param {MetadataInput | undefined} metadata
 * @param {boolean | undefined} userRequested
 * @returns {{ metadata: MetadataInput | undefined, note: string | undefined }}
 */
function guardScarcePriority(metadata, userRequested) {
  const p0Allowed = userRequested === true || isSystemMaintenance();
  const { coerced } = enforceP0Scarcity(/** @type {Priority} */ (metadata?.priority), p0Allowed);
  if (coerced) {
    return {
      metadata: { ...metadata, priority: "P1" },
      note: "priority P0 coerced to P1: P0 requires an explicit user designation (a gated lesson, or userRequested:true)",
    };
  }
  return { metadata, note: undefined };
}

export {
  assertTopologyPathValid,
  refuseWriteGate,
  targetsGatedCategory,
  auditGatedL3,
  guardScarcePriority,
};

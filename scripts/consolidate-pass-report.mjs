// Per-pass report + per-entity outcome recording, plus the in-place
// leaf-metadata stamp shared by every consolidate pass. The typedefs these
// functions reference live in consolidate-report.mjs (the types hub) and are
// imported here type-only.

import path from "node:path";
import { redact } from "./lib/redact.mjs";
import { updateDocMetadata } from "./lib/wiki-store.mjs";

/** @typedef {import("./lib/types.mjs").MetadataInput} MetadataInput */
/** @typedef {import("./consolidate-report.mjs").PassReport} PassReport */
/** @typedef {import("./consolidate-report.mjs").PassReportCounts} PassReportCounts */
/** @typedef {import("./consolidate-report.mjs").EntityRecord} EntityRecord */
/** @typedef {import("./consolidate-report.mjs").RecordEntityArgs} RecordEntityArgs */

// Stamp non-facet bookkeeping (consolidated_at / stale / last_refreshed_at /
// supersedes_id) onto a leaf WITHOUT relocating it. consolidate never changes a
// leaf's placement facets, so the leaf must stay at its current path: an
// unpinned updateDocMetadata recomputes the canonical placement and, for a leaf
// already sitting off-canonical (e.g. a legacy pre-subject-axis path), would
// relocate it as a side effect — silently changing a merge keeper's documentId
// (breaking the supersedes_id we stamp on its loser), making a follow-up
// disableDocument miss, and (on a destination collision) leaving a DUP-ID.
// Pinning to the leaf's own directory keeps the stamp a pure in-place rewrite.
/**
 * @param {string} documentId
 * @param {MetadataInput} metadata
 */
export function stampLeafMetadata(documentId, metadata) {
  // Pin to the leaf's own directory. `dirname` returns "." for a bare filename;
  // no real leaf lives at the wiki root, but guard anyway so the override (which
  // rejects "."/empty) never throws — in that (unreachable) case omit the
  // override and let updateDocMetadata place by facets as usual.
  const dir = path.posix.dirname(documentId);
  return updateDocMetadata({
    documentId,
    metadata,
    placementOverride: dir && dir !== "." ? dir : undefined,
  });
}

/**
 * @param {string} name
 * @returns {PassReport}
 */
export function emptyPassReport(name) {
  return {
    name,
    archived: 0,
    touched: 0,
    merged: 0,
    refreshed: 0,
    flagged: 0,
    errors: 0,
    freedBytes: 0,
    ms: 0,
    skipped: false,
    // Per-entity outcomes for the sharded full cron log + entity-level
    // self-healing. `entities` = actions that landed (or were deliberately
    // skipped); `failures` = per-entity errors with a redacted excerpt.
    // Sorted by id at orchestrator return so dry-run twice is byte-identical.
    entities: [],
    failures: [],
  };
}

/**
 * @param {{ documentId: string }} keeper
 * @param {{ documentId: string }} loser
 * @returns {string}
 */
export function entityPairId(keeper, loser) {
  return `pair:${keeper.documentId}|${loser.documentId}`;
}

/**
 * @param {{ documentId: string }} leaf
 * @returns {string}
 */
export function entityLeafId(leaf) {
  return `leaf:${leaf.documentId}`;
}

/**
 * @param {PassReport} report
 * @param {RecordEntityArgs} args
 */
export function recordEntity(report, { id, kind, action, ok, reason, error }) {
  /** @type {EntityRecord} */
  const e = { id, kind, action, ok: Boolean(ok) };
  // Success reasons can be LLM-authored (decision.reason / archive_reason)
  // and land in the persisted full cron log — redact like failure excerpts.
  if (reason)
    e.reason = redact(String(reason))
      .replace(/[\r\n]+/g, " ")
      .slice(0, 300);
  if (e.ok) {
    report.entities.push(e);
    return;
  }
  const errLike = /** @type {Error | undefined} */ (error);
  e.excerpt = redact(String(errLike?.message || errLike || "unknown error"))
    .replace(/\s+/g, " ")
    .slice(0, 500);
  report.failures.push(e);
}

/**
 * @param {Map<string, PassReport>} reportMap
 */
export function sortPassEntities(reportMap) {
  /** @param {EntityRecord} a @param {EntityRecord} b @returns {number} */
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const r of reportMap.values()) {
    r.entities.sort(byId);
    r.failures.sort(byId);
  }
}

/**
 * @param {Record<string, PassReport>} passes
 * @returns {Record<string, PassReportCounts>}
 */
export function stripPassEntities(passes) {
  return Object.fromEntries(
    Object.entries(passes).map(([k, v]) => {
      const { entities, failures, ...counts } = v;
      return [k, counts];
    }),
  );
}

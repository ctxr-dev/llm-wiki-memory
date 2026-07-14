import { getImpl } from "./mcp-reload.mjs";
import { AUDIT_CLASSES, SELF_IMPROVEMENT, KNOWLEDGE } from "../scripts/lib/context/enums.mjs";
import { getActiveWikiContext } from "../scripts/lib/wiki-context.mjs";
import { withWikiRoot } from "../scripts/lib/env.mjs";

/**
 * A missing-metadata finding for one leaf, or null: a lesson / bug-root-cause
 * leaf missing its area (or project_module), or a lesson missing error_pattern.
 * @param {string} slot
 * @param {string} documentId
 * @param {Record<string, unknown>} metadata
 * @param {string} [root] the level root, tagged on a fanned-out knowledge hit
 */
function missingMetadataFinding(slot, documentId, metadata, root) {
  const at = metadata.atom_type;
  const incomplete =
    (at === "self-improvement-lesson" || at === "bug-root-cause") &&
    (!(metadata.area || metadata.project_module) ||
      (at === "self-improvement-lesson" && !metadata.error_pattern));
  if (!incomplete) return null;
  return {
    class: AUDIT_CLASSES.MISSING_METADATA,
    slot,
    documentId,
    atom_type: at,
    ...(root ? { root } : {}),
  };
}

/**
 * The audit-logic home (C13). self_improvement is personal + write-gated, so it
 * is audited in the BRAIN only (and duplicate-error-pattern is a per-user dedup).
 * knowledge is SHARED, so its missing-metadata walk FANS OUT across every level
 * in scope (brain-only when there is a single level / no context) — a shared
 * repo's `bug-root-cause` leaf with missing area/module is human-fixable and must
 * not be invisible, matching the round-6 rule that a repo's category is
 * first-class. Snapshots the impl ONCE (this handler makes MULTIPLE impl calls),
 * so a mid-audit hot reload can't mix functions across module versions.
 * @param {string[]} classes
 */
export function dispatchAudit(classes) {
  const api = getImpl();
  const requested = new Set(classes);
  const findings = [];

  // self_improvement — brain-only (personal, write-gated).
  const byErrorPattern = new Map();
  const { documents: siDocs } = api.listDocuments({ datasetId: SELF_IMPROVEMENT, enabled: "true" });
  for (const doc of siDocs) {
    const { metadata } = api.readDocument({ documentId: doc.id, datasetId: SELF_IMPROVEMENT });
    if (requested.has(AUDIT_CLASSES.MISSING_METADATA)) {
      const f = missingMetadataFinding(SELF_IMPROVEMENT, doc.id, metadata);
      if (f) findings.push(f);
    }
    if (requested.has(AUDIT_CLASSES.DUPLICATE_ERROR_PATTERN) && metadata.error_pattern) {
      const key = `${metadata.area || metadata.project_module || ""}:${metadata.error_pattern}`;
      if (!byErrorPattern.has(key)) byErrorPattern.set(key, []);
      byErrorPattern.get(key).push(doc.id);
    }
  }
  if (requested.has(AUDIT_CLASSES.DUPLICATE_ERROR_PATTERN)) {
    for (const [key, ids] of byErrorPattern) {
      if (ids.length > 1)
        findings.push({ class: AUDIT_CLASSES.DUPLICATE_ERROR_PATTERN, key, documentIds: ids });
    }
  }

  // knowledge — SHARED: audit missing-metadata across every level in scope.
  if (requested.has(AUDIT_CLASSES.MISSING_METADATA)) {
    const auditKnowledgeHere = (/** @type {string | undefined} */ root) => {
      const { documents } = api.listDocuments({ datasetId: KNOWLEDGE, enabled: "true" });
      for (const doc of documents) {
        const { metadata } = api.readDocument({ documentId: doc.id, datasetId: KNOWLEDGE });
        const f = missingMetadataFinding(KNOWLEDGE, doc.id, metadata, root);
        if (f) findings.push(f);
      }
    };
    const ctx = getActiveWikiContext();
    const levels = ctx && Array.isArray(ctx.levels) ? ctx.levels : [];
    if (levels.length <= 1) auditKnowledgeHere(undefined);
    else for (const level of levels) withWikiRoot(level.root, () => auditKnowledgeHere(level.root));
  }

  return { ok: true, findings, total: findings.length };
}

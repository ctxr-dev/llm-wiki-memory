import { getImpl } from "./mcp-reload.mjs";
import { AUDIT_CLASSES, SELF_IMPROVEMENT, KNOWLEDGE } from "../scripts/lib/context/enums.mjs";

/**
 * The audit-logic home (C13): walk self_improvement + knowledge for the
 * requested cleanup classes and return the findings. Snapshots the impl ONCE —
 * this is the only handler making MULTIPLE impl calls (listDocuments +
 * readDocument in a loop), so pinning one version stops a mid-audit hot-reload
 * from mixing functions across module versions.
 * @param {string[]} classes
 */
export function dispatchAudit(classes) {
  const api = getImpl();
  const requested = new Set(classes);
  const findings = [];
  const byErrorPattern = new Map();
  for (const slot of [SELF_IMPROVEMENT, KNOWLEDGE]) {
    const { documents } = api.listDocuments({ datasetId: slot, enabled: "true" });
    for (const doc of documents) {
      const { metadata } = api.readDocument({ documentId: doc.id, datasetId: slot });
      if (requested.has(AUDIT_CLASSES.MISSING_METADATA)) {
        const at = metadata.atom_type;
        if (
          (at === "self-improvement-lesson" || at === "bug-root-cause") &&
          (!(metadata.area || metadata.project_module) ||
            (at === "self-improvement-lesson" && !metadata.error_pattern))
        ) {
          findings.push({
            class: AUDIT_CLASSES.MISSING_METADATA,
            slot,
            documentId: doc.id,
            atom_type: at,
          });
        }
      }
      if (
        requested.has(AUDIT_CLASSES.DUPLICATE_ERROR_PATTERN) &&
        slot === SELF_IMPROVEMENT &&
        metadata.error_pattern
      ) {
        const key = `${metadata.area || metadata.project_module || ""}:${metadata.error_pattern}`;
        if (!byErrorPattern.has(key)) byErrorPattern.set(key, []);
        byErrorPattern.get(key).push(doc.id);
      }
    }
  }
  if (requested.has(AUDIT_CLASSES.DUPLICATE_ERROR_PATTERN)) {
    for (const [key, ids] of byErrorPattern) {
      if (ids.length > 1)
        findings.push({ class: AUDIT_CLASSES.DUPLICATE_ERROR_PATTERN, key, documentIds: ids });
    }
  }
  return { ok: true, findings, total: findings.length };
}

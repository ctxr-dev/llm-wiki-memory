import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.mjs";
import { ensureIndexes, indexRebuildOne } from "./wiki-cli.mjs";
import { pruneEmptyAncestors } from "./fs-prune.mjs";
import { withFsRetry } from "./fs-retry.mjs";
import { recordWikiChange } from "./wiki-commit.mjs";
import { root, readLeaf, leafMemory } from "./wiki-core.mjs";
import { toAbs, toRel } from "./wiki-identity.mjs";
import { stringifyLeaf } from "./wiki-render.mjs";
import { removeEmbedding, upsertEmbedding } from "./wiki-embed-cache.mjs";

/**
 * @typedef {Object} DocSelector
 * @property {string} [documentId]
 * @property {string} [datasetId]
 */

// Soft-delete: mark archived so listings/search skip it; file stays in git.
/**
 * @param {DocSelector} [sel]
 */
export function disableDocument({ documentId, datasetId: _datasetId } = {}) {
  const abs = toAbs(documentId);
  if (!fs.existsSync(abs)) return { ok: false, reason: `leaf not found: ${documentId}` };
  const { data, body } = readLeaf(abs);
  const next = { ...data, memory: { ...leafMemory(data), status: "archived" } };
  writeFileAtomic(abs, stringifyLeaf(body, next));
  removeEmbedding(toRel(abs));
  recordWikiChange({
    action: "archived",
    leafRelPath: documentId,
    reason: "status set to archived",
  });
  return { ok: true, documentId, status: "archived" };
}

/**
 * @param {DocSelector} [sel]
 */
export function enableDocument({ documentId, datasetId: _datasetId } = {}) {
  const abs = toAbs(documentId);
  if (!fs.existsSync(abs)) return { ok: false, reason: `leaf not found: ${documentId}` };
  const { data, body } = readLeaf(abs);
  const next = { ...data, memory: { ...leafMemory(data), status: "active" } };
  writeFileAtomic(abs, stringifyLeaf(body, next));
  upsertEmbedding(toRel(abs), body);
  recordWikiChange({
    action: "enabled",
    leafRelPath: documentId,
    reason: "status restored to active",
  });
  return { ok: true, documentId, status: "active" };
}

// Truncate the body of an already-archived leaf to `max` chars. Idempotent:
// if the leaf is already marked `memory.consolidate_truncated_at`, this is a
// no-op. The original sha256 in `frontmatter.source.hash` is PRESERVED (NOT
// recomputed) so the original body can be reconstructed from git history; the
// footer marker tells a future reader where to look. Used by the consolidate
// `compress-archived` pass.
/**
 * @param {{ documentId?: string, max?: number, nowIso?: string }} [opts]
 */
export function truncateArchivedBody({ documentId, max, nowIso } = {}) {
  const abs = toAbs(documentId);
  if (!fs.existsSync(abs)) return { ok: false, reason: `leaf not found: ${documentId}` };
  const { data, body } = readLeaf(abs);
  const mem = leafMemory(data);
  if (mem.status !== "archived") {
    return { ok: false, reason: `leaf is not archived: ${documentId}` };
  }
  if (mem.consolidate_truncated_at) {
    return { ok: true, skipped: "already-truncated", documentId };
  }
  const limit =
    Number.isFinite(max) && /** @type {number} */ (max) > 0
      ? Math.floor(/** @type {number} */ (max))
      : 1200;
  if (String(body).length <= limit) {
    return { ok: true, skipped: "below-threshold", documentId };
  }
  const stamp = typeof nowIso === "string" && nowIso ? nowIso : new Date().toISOString();
  const truncated =
    String(body).slice(0, limit).replace(/\s+$/, "") +
    `\n\n[truncated by consolidate at ${stamp}; original sha256 preserved in frontmatter.source.hash]\n`;
  const freedBytes = Buffer.byteLength(body, "utf8") - Buffer.byteLength(truncated, "utf8");
  const next = {
    ...data,
    memory: { ...mem, consolidate_truncated_at: stamp },
  };
  writeFileAtomic(abs, stringifyLeaf(truncated, next));
  recordWikiChange({
    action: "truncated",
    leafRelPath: documentId,
    reason: "compress archived body",
  });
  return { ok: true, documentId, freedBytes };
}

/**
 * @param {DocSelector} [sel]
 */
export function deleteDocument({ documentId, datasetId: _datasetId } = {}) {
  const abs = toAbs(documentId);
  if (!fs.existsSync(abs)) return { ok: false, reason: `leaf not found: ${documentId}` };
  withFsRetry(() => fs.rmSync(abs, { force: true }));
  removeEmbedding(/** @type {string} */ (documentId));
  // Refresh indexes from the (now-deleted leaf's) parent dir up to the wiki
  // root so the entry disappears from every ancestor index, not just the
  // immediate parent. ensureIndexes walks abs's dirname upward.
  try {
    ensureIndexes(root(), [abs]);
  } catch {
    /* best effort; a later heal will reconcile */
  }
  // Drop any ancestor dir the deletion just emptied (left holding only an
  // orphaned index.md) — same invariant the relocation paths enforce, so a
  // delete never leaves a blind nested dir with no real leaves behind. Rebuild
  // the survivor so its index.md doesn't keep a stale ref to the pruned child.
  const { survivor } = pruneEmptyAncestors(path.dirname(abs), root());
  if (survivor) {
    try {
      indexRebuildOne(survivor, root());
    } catch {
      /* best effort; a later heal / doctor --fix reconciles */
    }
  }
  recordWikiChange({ action: "deleted", leafRelPath: documentId, reason: "leaf removed" });
  return { ok: true, documentId, deleted: true };
}

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.mjs";
import { withFsRetry } from "./fs-retry.mjs";
import { ensureIndexes, indexRebuildOne } from "./wiki-cli.mjs";
import { pruneEmptyAncestors } from "./fs-prune.mjs";
import { recordWikiChange, withWikiCommit } from "./wiki-commit.mjs";
import { inferFacets } from "./facets.mjs";
import { WikiStoreUnavailable, root, findByName } from "./wiki-core.mjs";
import {
  toRel,
  normaliseMeta,
  normalizeLeafName,
  normalizeLeafNamePreservingCase,
  tagsArray,
} from "./wiki-identity.mjs";
import { deriveTitle, renderLeaf } from "./wiki-render.mjs";
import { slotToCategory } from "./wiki-layout-state.mjs";
import {
  placementDir,
  normalisePlacementOverride,
  assertKnownSlot,
  assertTopologyPlacement,
} from "./wiki-placement.mjs";
import { upsertEmbedding, renameEmbedding } from "./wiki-embed-cache.mjs";
import { deleteDocument, disableDocument } from "./wiki-lifecycle.mjs";

// public API — parity with dify-write.mjs

/** @typedef {import("./types.mjs").MetadataInput} MetadataInput */

/**
 * @typedef {Object} WriteMemoryArgs
 * @property {string} [name]
 * @property {string} [text]
 * @property {string} [datasetId]
 * @property {string} [supersedes]
 * @property {string} [supersedesAction]
 * @property {MetadataInput} [metadata]
 * @property {Date} [date]
 * @property {string | null} [placementOverride]
 */

/**
 * @typedef {Object} SaveDocumentArgs
 * @property {string} [name]
 * @property {string} [text]
 * @property {string} [datasetId]
 * @property {MetadataInput} [metadata]
 * @property {string | null} [placementOverride]
 */

// Create a leaf at its facet-derived path. `metadata` is optional but, when
// supplied, drives facet placement (compile passes it here) and may be re-merged
// later via updateDocMetadata. A name collision is replaced in place only when it
// lands at the SAME computed path; dedup across facet folders is the caller's job
// (compile supersedes the prior leaf via `supersedes`). saveDocument is the
// upsert-by-name path that searches the whole category recursively.
/**
 * @param {WriteMemoryArgs} [args]
 */
export function writeMemory(args = {}) {
  // One logical operation: the leaf write plus its optional supersede
  // disable/delete must land in a single commit even when called outside any
  // orchestrator frame (a nested frame joins the outer one, so wrapped
  // callers see no behaviour change).
  return withWikiCommit({ op: "memory-write", actor: "wiki-store" }, () => writeMemoryInner(args));
}

/**
 * @param {WriteMemoryArgs} [args]
 */
function writeMemoryInner({
  name,
  text,
  datasetId,
  supersedes,
  supersedesAction,
  metadata,
  date,
  placementOverride,
} = {}) {
  if (!name || !text || !datasetId) {
    throw new WikiStoreUnavailable("writeMemory requires name, text, datasetId");
  }
  const slot = datasetId;
  const category = assertKnownSlot(slot);
  // The THIRD write door (alongside saveDocument + updateDocMetadata): a no-path
  // write into a topology category would flat-root here too. MCP write_memory is
  // also guarded at the boundary, but a non-MCP caller (e.g. a misconfigured
  // flush slot) reaches this directly — fail loud for all of them.
  assertTopologyPlacement(category, placementOverride);

  // `placementOverride` (optional): when supplied, the leaf is written verbatim
  // at <override>/<name> and facet inference is skipped. CASING is preserved
  // in BOTH the directory segments AND the filename stem (we call
  // normalizeLeafNamePreservingCase instead of normalizeLeafName, so a caller
  // passing "DEV-129957.md" gets exactly "DEV-129957.md" on disk and the same
  // string as the leaf `id`). Metadata is still normalised for the frontmatter
  // `memory` block so the leaf remains searchable / filterable by
  // `searchMemoryFiltered`.
  let dir;
  let memoryMeta;
  let tags;
  let safeName;
  let id;
  if (placementOverride !== undefined && placementOverride !== null) {
    dir = normalisePlacementOverride(placementOverride);
    ({ name: safeName, id } = normalizeLeafNamePreservingCase(name));
    memoryMeta = normaliseMeta(metadata || {}, { atom_type: slotDefaultAtomType(slot) });
    tags = tagsArray(metadata);
  } else {
    ({ name: safeName, id } = normalizeLeafName(name));
    // Infer/validate placement facets so a leaf is never written under an
    // unknown/unscoped area or an out-of-set atom_type (daily is a no-op).
    // Heuristic + deterministic fallback only, so this stays synchronous.
    const facets = inferFacets({ category, meta: metadata || {}, tags: tagsArray(metadata) });
    const effectiveMeta = { ...(metadata || {}), ...facets };
    memoryMeta = normaliseMeta(effectiveMeta, { atom_type: slotDefaultAtomType(slot) });
    tags = tagsArray(effectiveMeta);

    // `date` (optional) pins daily date-nesting to a caller-supplied time (e.g. a
    // flush's capture time) rather than the write time, so a background worker
    // that crosses midnight UTC still nests under the captured day.
    dir = placementDir(slot, { metadata: memoryMeta, date });
  }
  const title = deriveTitle({ metadata, text, name: safeName });
  const leafAbs = path.join(root(), dir.split("/").join(path.sep), safeName);
  fs.mkdirSync(path.dirname(leafAbs), { recursive: true });
  writeFileAtomic(leafAbs, renderLeaf({ id, title, tags, body: text, memoryMeta }));

  const touched = [leafAbs];
  let supersedeResult;
  if (supersedes) {
    const action = supersedesAction || "disable";
    try {
      supersedeResult =
        action === "delete"
          ? deleteDocument({ documentId: supersedes, datasetId: slot })
          : disableDocument({ documentId: supersedes, datasetId: slot });
    } catch (err) {
      supersedeResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  ensureIndexes(root(), touched);
  upsertEmbedding(toRel(leafAbs), text);
  recordWikiChange({ action: "saved", leafRelPath: toRel(leafAbs), reason: `${slot} write` });

  return {
    ok: true,
    datasetId: slot,
    name: safeName,
    created: { document: { id: toRel(leafAbs) } },
    supersedes: supersedes ? { documentId: supersedes, result: supersedeResult } : undefined,
  };
}

// Upsert-by-name: the leaf is written at the facet path its metadata implies. A
// same-named leaf already at that path is overwritten in place; one found at a
// STALE facet path (its metadata changed) is relocated there so the on-disk path
// always matches the leaf's facets. Applies metadata immediately.
/**
 * @param {SaveDocumentArgs} [args]
 */
export function saveDocument({ name, text, datasetId, metadata, placementOverride } = {}) {
  if (!name || !text || !datasetId) {
    throw new WikiStoreUnavailable("saveDocument requires name, text, datasetId");
  }
  const slot = datasetId;
  const category = assertKnownSlot(slot);
  assertTopologyPlacement(category, placementOverride);

  // `placementOverride` (optional): when supplied, the existence check is
  // scoped to the override path only (we do NOT broad-search the category
  // tree by name, because the caller is asserting a specific location). This
  // also disables the cross-facet "relocate" behaviour - the override IS the
  // target. CASING is preserved in the filename so a caller passing
  // "DEV-129957.md" gets exactly that on disk. Metadata is still normalised
  // so the leaf stays searchable.
  let dir;
  let memoryMeta;
  let tags;
  let existing;
  let safeName;
  let id;
  if (placementOverride !== undefined && placementOverride !== null) {
    dir = normalisePlacementOverride(placementOverride);
    ({ name: safeName, id } = normalizeLeafNamePreservingCase(name));
    memoryMeta = normaliseMeta(metadata || {}, { atom_type: slotDefaultAtomType(slot) });
    tags = tagsArray(metadata);
    const candidateAbs = path.join(root(), dir.split("/").join(path.sep), safeName);
    existing = fs.existsSync(candidateAbs) ? candidateAbs : null;
  } else {
    ({ name: safeName, id } = normalizeLeafName(name));
    const categoryAbs = path.join(root(), slotToCategory(slot));
    existing = findByName(categoryAbs, safeName);
    // Infer/validate placement facets so a leaf is never saved under an
    // unknown/unscoped area or an out-of-set atom_type. Heuristic + deterministic
    // fallback only, so this stays synchronous.
    const facets = inferFacets({ category, meta: metadata || {}, tags: tagsArray(metadata) });
    const effectiveMeta = { ...(metadata || {}), ...facets };
    memoryMeta = normaliseMeta(effectiveMeta, { atom_type: slotDefaultAtomType(slot) });
    tags = tagsArray(effectiveMeta);
    dir = placementDir(slot, { metadata: memoryMeta });
  }
  const title = deriveTitle({ metadata, text, name: safeName });

  const leafAbs = path.join(root(), dir.split("/").join(path.sep), safeName);
  const replacedId = existing ? toRel(existing) : undefined;
  const moved =
    Boolean(existing) && path.resolve(/** @type {string} */ (existing)) !== path.resolve(leafAbs);

  // If relocating but a DIFFERENT leaf already occupies the target facet path,
  // refuse rather than clobber it and then delete `existing` (double data loss).
  // Such cross-facet basename duplicates can exist because writeMemory places by
  // exact path without a recursive dedup.
  if (moved && fs.existsSync(leafAbs)) {
    return {
      ok: false,
      datasetId: slot,
      name: safeName,
      reason: `destination ${dir}/${safeName} is occupied by a different leaf; refusing to overwrite`,
      conflict: { existing: replacedId, destination: toRel(leafAbs) },
    };
  }

  fs.mkdirSync(path.dirname(leafAbs), { recursive: true });
  writeFileAtomic(leafAbs, renderLeaf({ id, title, tags, body: text, memoryMeta }));

  const touched = [leafAbs];
  if (moved) {
    withFsRetry(() => fs.rmSync(/** @type {string} */ (existing)));
    renameEmbedding(toRel(/** @type {string} */ (existing)), toRel(leafAbs));
    touched.push(/** @type {string} */ (existing));
  }
  ensureIndexes(root(), touched);
  upsertEmbedding(toRel(leafAbs), text);
  // After a relocation, drop any source ancestor dir left holding only an
  // orphaned index.md (prune AFTER ensureIndexes, which may have rewritten it).
  // Rebuild the surviving ancestor: ensureIndexes ran while the now-pruned child
  // still existed, so its index.md would otherwise keep a stale child ref.
  if (moved) {
    const { survivor } = pruneEmptyAncestors(
      path.dirname(/** @type {string} */ (existing)),
      root(),
    );
    if (survivor) indexRebuildOne(survivor, root());
  }
  recordWikiChange({
    action: moved ? "relocated" : "saved",
    leafRelPath: toRel(leafAbs),
    reason: moved ? `${slot} upsert relocated from ${replacedId}` : `${slot} upsert`,
    extraPaths: moved ? /** @type {string[]} */ ([replacedId]) : [],
  });

  const metadataAttempted = metadata && Object.keys(metadata).length > 0;
  return {
    ok: true,
    datasetId: slot,
    name: safeName,
    created: { document: { id: toRel(leafAbs) } },
    replacedId,
    relocatedFrom: moved ? replacedId : undefined,
    metadataError: undefined,
    metadataResult: metadataAttempted ? { ok: true } : undefined,
  };
}

// Default atom_type for a slot when none is supplied (used for daily capture
// leaves and bare save_to_dataset calls).
/**
 * @param {string} slot
 * @returns {string}
 */
function slotDefaultAtomType(slot) {
  const category = slotToCategory(slot);
  if (category === "daily") return "daily-capture";
  if (category === "plans") return "plan";
  if (category === "self_improvement") return "self-improvement-lesson";
  if (category === "investigations") return "investigation";
  return "reference";
}

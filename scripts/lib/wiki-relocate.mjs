import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.mjs";
import { ensureIndexes, indexRebuildOne } from "./wiki-cli.mjs";
import { pruneEmptyAncestors } from "./fs-prune.mjs";
import { recordWikiChange } from "./wiki-commit.mjs";
import { priorityForAtomType, normalisePriority } from "./datasets.mjs";
import { WikiStoreUnavailable, root, readLeaf, leafMemory, walkLeaves } from "./wiki-core.mjs";
import { toAbs, toRel, normaliseMeta, normalizeLeafNamePreservingCase } from "./wiki-identity.mjs";
import { stringifyLeaf } from "./wiki-render.mjs";
import {
  ensureLayoutLoaded,
  slotToCategory,
  categoryHasTopology,
  getCategories,
  getPlacementFacets,
} from "./wiki-layout-state.mjs";
import { placementDirForMeta, normalisePlacementOverride } from "./wiki-placement.mjs";
import { renameEmbedding } from "./wiki-embed-cache.mjs";

// Merge metadata into a leaf's frontmatter `memory` block (idempotent). When a
// facet field (project_module/atom_type/task_type) changes so the leaf's facet
// path no longer matches its current folder, the leaf is RELOCATED so the tree
// keeps mirroring the metadata: the cached vector is preserved (content is
// unchanged) and the old + new ancestor indexes are refreshed. compile re-applies
// the same metadata it placed by, so the common path is a plain in-place rewrite.
/** @typedef {import("./types.mjs").MetadataInput} MetadataInput */

/**
 * @param {{ datasetId?: string, documentId?: string, metadata?: MetadataInput, placementOverride?: string | null, commitReason?: string }} [opts]
 */
export function updateDocMetadata({
  datasetId: _datasetId,
  documentId,
  metadata,
  placementOverride,
  commitReason,
} = {}) {
  const abs = toAbs(documentId);
  if (!fs.existsSync(abs)) return { ok: false, reason: `leaf not found: ${documentId}` };
  if (!metadata || Object.keys(metadata).length === 0) return { ok: true, warning: "no metadata" };
  const { data, body } = readLeaf(abs);
  const incoming = normaliseMeta(metadata, { status: leafMemory(data).status });
  // normaliseMeta always emits atom_type (never stripped); on a PARTIAL update
  // that omits it, that empty string would clobber the leaf's existing
  // atom_type. Drop it so a partial merge keeps the current value.
  if (!incoming.atom_type)
    delete (/** @type {Partial<import("./types.mjs").MemoryMetadata>} */ (incoming).atom_type);
  const merged = { ...leafMemory(data), ...incoming };
  const rendered = stringifyLeaf(body, { ...data, memory: merged });

  const rel = String(documentId).split("/");
  const curDir = rel.slice(0, -1).join("/");
  const category = slotToCategory(rel[0]);
  // Topology categories (tracker `issues`) nest via the path-compiler, NOT facet
  // placement. An UNPINNED in-place metadata update (consolidate stamping
  // `stale` / `consolidated_at`, or any non-relocating stamp) must NEVER
  // recompute placement via placementDirForMeta — that returns the category
  // ROOT and would relocate the nested leaf flat (the 2026-06 stale-instance
  // flatten). Pin to the leaf's CURRENT dir: an in-place stamp keeps the leaf
  // where it is, and lifecycle moves go through plan-sync (fs.rename + pathFor),
  // never here. saveDocument / writeMemory still THROW on a no-path topology
  // CREATE (no existing leaf, so no curDir to pin to) via assertTopologyPlacement;
  // only this in-place UPDATE path pins instead of failing.
  const effectiveOverride =
    placementOverride !== undefined && placementOverride !== null
      ? placementOverride
      : categoryHasTopology(category)
        ? curDir
        : undefined;
  // `placementOverride` (optional): pin the leaf to a caller-chosen directory
  // and bypass facet-driven relocation. A caller passing the leaf's CURRENT dir
  // keeps it in place: this is how consolidate stamps non-facet bookkeeping
  // (consolidated_at / stale / supersedes_id) WITHOUT moving a merge keeper
  // (which would invalidate its documentId and break a freshly stamped
  // supersedes_id) or a leaf it is about to disable. Mirrors saveDocument's
  // placementOverride contract.
  const newDir =
    effectiveOverride !== undefined && effectiveOverride !== null
      ? normalisePlacementOverride(effectiveOverride)
      : placementDirForMeta(category, merged); // null for daily
  if (newDir && newDir !== curDir) {
    const newRel = `${newDir}/${rel[rel.length - 1]}`;
    const newAbs = toAbs(newRel);
    // Relocating to a new facet path. If a DIFFERENT leaf already occupies the
    // destination (a cross-facet basename duplicate; leaf ids derive from the
    // basename, so the two would share an id), refuse rather than touch it: a
    // blind overwrite would destroy the destination leaf, and the old in-place
    // fallback left BOTH files behind as a DUP-ID. This mirrors saveDocument's
    // relocation guard so both write paths share ONE collision policy.
    // (consolidate never reaches this branch — it pins every metadata stamp to
    // the leaf's own dir via stampLeafMetadata, so newDir === curDir there.)
    if (fs.existsSync(newAbs)) {
      return {
        ok: false,
        reason: `destination ${newRel} is occupied by a different leaf; refusing to overwrite`,
        conflict: { existing: documentId, destination: newRel },
      };
    }
    fs.mkdirSync(path.dirname(newAbs), { recursive: true });
    writeFileAtomic(newAbs, rendered);
    fs.rmSync(abs, { force: true });
    renameEmbedding(/** @type {string} */ (documentId), newRel);
    ensureIndexes(root(), [abs, newAbs]); // drop the entry from old ancestors, add to new
    // Remove any source ancestor dir left holding only an orphaned index.md,
    // then rebuild the survivor so it doesn't keep a stale ref to the pruned child.
    const { survivor } = pruneEmptyAncestors(path.dirname(abs), root());
    if (survivor) indexRebuildOne(survivor, root());
    recordWikiChange({
      action: "relocated",
      leafRelPath: newRel,
      reason: commitReason || `metadata facet change moved ${documentId}`,
      extraPaths: /** @type {string[]} */ ([documentId]),
    });
    return { ok: true, relocated: { from: documentId, to: newRel } };
  }
  writeFileAtomic(abs, rendered);
  recordWikiChange({
    action: "metadata",
    leafRelPath: documentId,
    reason: commitReason || "metadata update",
  });
  return { ok: true };
}

// Relocate a leaf to a caller-chosen `toPath` (dir + filename), preserving its
// content verbatim, its cached embedding, and refreshing BOTH the source and
// destination ancestor indexes. Atomic order mirrors saveDocument's relocate
// branch (write-new -> rm-old) so a half-replicated cloud-sync move can't lose data.
//
// LAYOUT-AWARE by regime, never a hardcoded category set: a free `toPath` is only
// safe for the curated human zone (consolidate:none, NO placement facets, not
// topology, not daily). Facet categories place by metadata (a free path would
// desync frontmatter<->path and get relocated back on the next upsert) -> use
// updateDocMetadata. Topology categories nest via the path-compiler (a free path
// re-opens the stranded-leaf bug) -> re-save with a compiled path. Both are
// REFUSED here with an actionable message rather than silently corrupting placement.
/**
 * @param {{ documentId?: string, fromPath?: string, toPath?: string, datasetId?: string }} [opts]
 */
export function moveDocument({ documentId, fromPath, toPath, datasetId: _datasetId } = {}) {
  const fromId = documentId || fromPath;
  if (!fromId || !toPath) {
    throw new WikiStoreUnavailable("moveDocument requires documentId (or fromPath) and toPath");
  }
  const fromAbs = toAbs(fromId);
  if (!fs.existsSync(fromAbs)) return { ok: false, reason: `leaf not found: ${fromId}` };
  const fromRel = toRel(fromAbs);

  const toStr = String(toPath).trim();
  const slash = toStr.lastIndexOf("/");
  if (slash < 0) {
    return {
      ok: false,
      reason: `toPath must be a category dir + filename (e.g. "Notes/My Note.md"); got ${JSON.stringify(toStr)}`,
    };
  }
  let toDir;
  let safeName;
  try {
    toDir = normalisePlacementOverride(toStr.slice(0, slash));
    ({ name: safeName } = normalizeLeafNamePreservingCase(toStr.slice(slash + 1)));
  } catch (e) {
    return { ok: false, reason: `invalid toPath: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Regime guard on BOTH the source and destination top-level categories.
  const srcCat = slotToCategory(fromRel.split("/")[0]);
  const dstCat = slotToCategory(toDir.split("/")[0]);
  for (const [role, cat] of [
    ["source", srcCat],
    ["destination", dstCat],
  ]) {
    if (!getCategories().includes(cat)) {
      return { ok: false, reason: `${role} category "${cat}" is not declared in the layout` };
    }
    if (categoryHasTopology(cat)) {
      return {
        ok: false,
        reason: `${role} category "${cat}" is topology-managed; moveDocument cannot relocate it by free path — re-save with a compiler-derived path.`,
      };
    }
    if (getPlacementFacets(cat).length > 0) {
      return {
        ok: false,
        reason: `${role} category "${cat}" places by facet metadata; relocate via updateDocMetadata / save metadata, not a free path.`,
      };
    }
    if (cat === "daily") {
      return {
        ok: false,
        reason: `${role} category "daily" is date-nested and not movable by path.`,
      };
    }
  }

  const toAbsPath = path.join(root(), toDir.split("/").join(path.sep), safeName);
  if (path.resolve(toAbsPath) === path.resolve(fromAbs)) {
    return { ok: true, moved: false, reason: "source and destination are identical" };
  }
  if (fs.existsSync(toAbsPath)) {
    return {
      ok: false,
      reason: `destination ${toDir}/${safeName} is occupied by a different leaf; refusing to overwrite`,
      conflict: { from: fromRel, to: toRel(toAbsPath) },
    };
  }

  const raw = fs.readFileSync(fromAbs, "utf8");
  fs.mkdirSync(path.dirname(toAbsPath), { recursive: true });
  writeFileAtomic(toAbsPath, raw); // verbatim — moving must not re-render content
  fs.rmSync(fromAbs);
  const toRelPath = toRel(toAbsPath);
  renameEmbedding(fromRel, toRelPath); // content unchanged -> keep the cached vector
  ensureIndexes(root(), [fromAbs, toAbsPath]); // refresh both source + destination ancestors
  const { survivor: moveSurvivor } = pruneEmptyAncestors(path.dirname(fromAbs), root());
  if (moveSurvivor) indexRebuildOne(moveSurvivor, root());
  recordWikiChange({
    action: "moved",
    leafRelPath: toRelPath,
    reason: "moveDocument (manual relocate)",
    extraPaths: [fromRel],
  });
  return { ok: true, moved: true, from: fromRel, to: toRelPath };
}

// Stamp a deterministic rubric priority (never P0) on every leaf that lacks a
// valid one. Pinned in place (no relocation). Deterministic + cheap (no LLM):
// recall already lazy-defaults a missing priority by the same rubric, so this
// just PERSISTS it. `daily` is skipped (transient, compiled away). Idempotent.
/**
 * @param {{ dryRun?: boolean }} [opts]
 */
export function backfillPriority({ dryRun = false } = {}) {
  ensureLayoutLoaded();
  const stamped = [];
  for (const cat of getCategories()) {
    if (cat === "daily") continue;
    const catAbs = path.join(root(), cat);
    for (const leaf of walkLeaves(catAbs)) {
      const { data } = readLeaf(leaf);
      const mem = leafMemory(data);
      if (normalisePriority(mem.priority)) continue; // already has a valid priority
      const priority = priorityForAtomType(mem.atom_type);
      const documentId = toRel(leaf);
      stamped.push({ documentId, priority });
      if (!dryRun) {
        updateDocMetadata({
          datasetId: cat,
          documentId,
          metadata: { priority },
          placementOverride: path.dirname(documentId), // pin in place, never relocate
          commitReason: "backfill-priority",
        });
      }
    }
  }
  return { ok: true, dryRun, stamped: stamped.length, leaves: stamped };
}

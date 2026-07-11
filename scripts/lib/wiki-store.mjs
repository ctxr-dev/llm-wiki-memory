// Barrel for the local hosted-wiki store. The implementation is split across
// cohesive sibling modules; this file preserves the historical public export
// surface (the package main export, `.` -> ./scripts/lib/wiki-store.mjs) so
// every importer and test keeps resolving the same names from the same path.
//
// Layout state is a lazy-loaded, per-root cache (wiki-layout-state.mjs). Reach
// the category list and the placement maps ONLY through the accessors
// (getCategories / getPlacementFacets / ...): there is deliberately no raw
// mutable array to import — importing one snapshots a stale empty binding
// before the lazy load runs (that bug once made CLI search return zero hits).

export { WikiStoreUnavailable } from "./wiki-core.mjs";

export {
  resetLayoutCache,
  getConsolidateLayout,
  _resetLayoutCacheForTests,
  getCategories,
  categoryHasTopology,
  getPlacementFacets,
  slotToCategory,
} from "./wiki-layout-state.mjs";

export {
  slugSegments,
  normaliseMeta,
  normalizeLeafName,
  normalizeLeafNamePreservingCase,
} from "./wiki-identity.mjs";

export { placementDirForMeta } from "./wiki-placement.mjs";

export {
  upsertEmbedding,
  removeEmbedding,
  renameEmbedding,
  pruneEmbeddingCache,
} from "./wiki-embed-cache.mjs";

export {
  listDocuments,
  readDocument,
  readLeafForConsolidate,
  listActiveLeavesForConsolidate,
  rerankWithinBands,
  searchMemoryFiltered,
  listDatasets,
} from "./wiki-search.mjs";

export {
  disableDocument,
  enableDocument,
  truncateArchivedBody,
  deleteDocument,
} from "./wiki-lifecycle.mjs";

export { updateDocMetadata, moveDocument, backfillPriority } from "./wiki-relocate.mjs";

export { writeMemory, saveDocument } from "./wiki-mutate.mjs";

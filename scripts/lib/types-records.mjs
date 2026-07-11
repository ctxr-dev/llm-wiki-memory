// Shared JSDoc type vocabulary — read-path documents, distilled atoms, search /
// recall records + envelopes, and write / mutation / placement results.
//
// The records half of the engine's type vocabulary (see `types.mjs`, the barrel
// that re-exports this module). Shapes that reference the metadata / leaf
// vocabulary (`Priority`, `PlanStatus`, `PlanProgress`, `MemoryMetadata`,
// `MetadataInput`, `LeafFrontmatter`) pull them from `./types-metadata.mjs` via
// JSDoc import types, so the two halves stay a single source of truth.
//
// This module exports nothing at runtime — `export {}` only marks it as an ESM
// module so the typedefs live in module scope. Every field is JSDoc-typed with
// no `any`; genuinely dynamic values use unions / `Record<string, unknown>` /
// `unknown`. Fields in `[brackets]` are optional.

/**
 * A one-line document listing from `listDocuments`.
 * @typedef {Object} DocumentSummary
 * @property {string} id - wiki-root-relative path.
 * @property {string} name - basename.
 * @property {string} datasetId - the category the leaf lives in.
 * @property {boolean} enabled - active (not archived).
 */

/**
 * The minimal document read from `readDocument`.
 * @typedef {Object} DocumentContent
 * @property {string} text - the leaf body (markdown, frontmatter stripped).
 * @property {import('./types-metadata.mjs').MemoryMetadata} metadata
 * @property {string} name - basename.
 * @property {string} documentId - wiki-root-relative path.
 */

/**
 * The richer leaf record `readLeafForConsolidate` / `listActiveLeavesForConsolidate`
 * return for the consolidate orchestrator (full frontmatter + active flag).
 * @typedef {Object} ConsolidateLeaf
 * @property {string} documentId - wiki-root-relative path.
 * @property {string} name - basename.
 * @property {string} text - the leaf body.
 * @property {import('./types-metadata.mjs').LeafFrontmatter} frontmatter - full top-level frontmatter.
 * @property {import('./types-metadata.mjs').MemoryMetadata} memory - the nested `memory` block.
 * @property {boolean} active
 */

/**
 * A distilled memory atom — the shape `parseAtomsFromMarkdown` (compile) and
 * `validateAtoms` (flush) produce. `metadata` is loose here; the write path
 * canonicalises it into `MemoryMetadata`.
 *
 * @typedef {Object} DistilledAtom
 * @property {string} type - one of datasets.mjs ATOM_TYPES.
 * @property {string} title
 * @property {string} body
 * @property {string[]} tags
 * @property {import('./types-metadata.mjs').MetadataInput} metadata
 * @property {string} [evidence] - one-line excerpt (JSON-encoded by flush).
 */

/**
 * A single ranked hit from `searchMemoryFiltered` (and therefore `searchMemory`).
 * The glance fields ride along only when `withGlance` was requested; the
 * `truncated`/`fullChars` fields are added by `clampSearchResponse` at the MCP
 * boundary when a body is excerpted.
 *
 * @typedef {Object} SearchHit
 * @property {string} datasetId - the category the hit lives in.
 * @property {string} documentId - wiki-root-relative path.
 * @property {string} documentName - basename.
 * @property {number} score - cosine similarity to the query.
 * @property {import('./types-metadata.mjs').Priority} priority
 * @property {string} content - the leaf body (possibly excerpted by clampSearchResponse).
 * @property {string} [brief] - glance field.
 * @property {string} [type] - glance field (the atom_type).
 * @property {import('./types-metadata.mjs').PlanStatus} [status] - glance field.
 * @property {import('./types-metadata.mjs').PlanProgress} [progress] - glance field.
 * @property {string[]} [tags] - glance field.
 * @property {boolean} [truncated] - set by clampSearchResponse when the body was clipped.
 * @property {number} [fullChars] - the pre-clip body length (clampSearchResponse).
 */

/**
 * A record in the `recallLessons` response. NOTE it carries `kind` and, unlike
 * `SearchHit`, does NOT expose `documentId` (recall projects a narrower shape).
 *
 * @typedef {Object} RecallRecord
 * @property {"lesson" | "knowledge"} kind
 * @property {string} datasetId
 * @property {string} documentName
 * @property {number} score
 * @property {import('./types-metadata.mjs').Priority} priority
 * @property {string} content
 * @property {string} [brief]
 * @property {string} [type]
 * @property {import('./types-metadata.mjs').PlanStatus} [status]
 * @property {import('./types-metadata.mjs').PlanProgress} [progress]
 * @property {string[]} [tags]
 */

/**
 * The `searchMemory` cross-category envelope.
 * @typedef {Object} SearchResponse
 * @property {string} [query]
 * @property {string[]} datasetsSearched
 * @property {import('./types-metadata.mjs').MetadataInput | null} filters
 * @property {{ project_module: string } | null} injectedFilters
 * @property {number | null} scoreThreshold
 * @property {Array<{ datasetId: string, message: string }>} errors
 * @property {number} totalRecords
 * @property {SearchHit[]} records
 */

/**
 * The `recallLessons` envelope.
 * @typedef {Object} RecallResponse
 * @property {string} [query]
 * @property {string} lessonDataset
 * @property {Array<{ filters: import('./types-metadata.mjs').MetadataInput, added: number }>} ladderUsed
 * @property {{ project_module: string } | null} injectedFilters
 * @property {number} scoreThreshold
 * @property {number} lessonHits
 * @property {number} supplementaryHits
 * @property {number} totalRecords
 * @property {RecallRecord[]} records
 */

/**
 * The result returned by the create/upsert write doors (`writeMemory`,
 * `saveDocument`). A single shape covering the success and the refuse-conflict
 * cases: `ok` is always present; `reason`/`conflict` appear on a refusal;
 * `created` appears on success. `replacedId`/`relocatedFrom` are saveDocument's
 * upsert-relocate signals; `supersedes` is writeMemory's supersede outcome.
 *
 * @typedef {Object} WriteResult
 * @property {boolean} ok
 * @property {string} [datasetId]
 * @property {string} [name] - the normalised on-disk leaf name.
 * @property {{ document: { id: string } }} [created] - created/overwritten leaf id (wiki-root-relative path).
 * @property {string} [replacedId] - id of the same-named leaf overwritten in place (saveDocument).
 * @property {string} [relocatedFrom] - id the leaf was relocated FROM on a facet-path change (saveDocument).
 * @property {string} [metadataError]
 * @property {{ ok: boolean }} [metadataResult]
 * @property {{ documentId: string, result: MutationResult }} [supersedes] - supersede disable/delete outcome (writeMemory).
 * @property {string} [reason] - present on a refusal (ok === false).
 * @property {{ existing?: string, destination: string }} [conflict] - present when a different leaf occupies the destination.
 */

/**
 * The result returned by the lifecycle / relocate doors (`disableDocument`,
 * `enableDocument`, `deleteDocument`, `updateDocMetadata`, `moveDocument`,
 * consolidate compress-truncate). `ok` is always present; the remaining fields
 * depend on the operation and outcome.
 *
 * @typedef {Object} MutationResult
 * @property {boolean} ok
 * @property {string} [reason] - present on a failure/refusal.
 * @property {string} [warning] - e.g. "no metadata".
 * @property {string} [documentId]
 * @property {string} [status] - "active" | "archived" after an enable/disable.
 * @property {string} [skipped] - e.g. "already-truncated", "below-threshold".
 * @property {number} [freedBytes] - bytes reclaimed by compress-truncate.
 * @property {boolean} [deleted]
 * @property {{ from: string, to: string }} [relocated]
 * @property {{ existing?: string, destination: string }} [conflict]
 * @property {string} [error]
 */

/**
 * The placement resolution returned by `placementDir` / `placementDirForMeta`:
 * a wiki-root-relative, forward-slash-separated directory. `placementDirForMeta`
 * returns `null` for the `daily` category (the caller date-nests it). NOTE:
 * wiki-placement.mjs models placement as this bare directory string, not a
 * structured object.
 * @typedef {string | null} PlacementResult
 */

export {};

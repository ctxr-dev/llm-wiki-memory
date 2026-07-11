// Shared JSDoc type vocabulary for the llm-wiki-memory engine (barrel).
//
// This module declares the object shapes that RECUR across the engine — the
// stored `memory` frontmatter block, the leaf/document records the read paths
// return, the distilled atom, the write/mutation results, and the search /
// recall envelopes. It is the single source of truth those shapes are named
// from, so the per-file typing pass references these (via JSDoc import types)
// instead of inventing conflicting local shapes.
//
// Usage from another module (type-only import; no runtime dependency):
//   /** @param {import('./types.mjs').MemoryMetadata} meta */
//   /** @returns {import('./types.mjs').WriteResult} */
//
// The vocabulary is split across two sibling modules and re-exported here so
// every existing `import('./types.mjs').X` keeps resolving:
//   - `types-metadata.mjs` — scalars/enums, the `memory` metadata block + its
//     loose input form, and the on-disk leaf frontmatter shapes.
//   - `types-records.mjs`  — read-path documents, the distilled atom, search /
//     recall records + envelopes, and write / mutation / placement results.
//
// These re-exports carry only JSDoc typedefs; there is no runtime surface.
// Every field is JSDoc-typed with no `any`; genuinely dynamic values use
// unions / `Record<string, unknown>` / `unknown`. Fields in `[brackets]` are
// optional. Field names are taken verbatim from the code (do not rename them —
// several are external contract keys stored in leaf frontmatter).

export * from "./types-metadata.mjs";
export * from "./types-records.mjs";

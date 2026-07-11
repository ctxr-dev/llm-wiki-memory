import { compileSlot } from "./lib/settings.mjs";
import {
  knowledgeDocName,
  lessonDocName,
  parseKnowledgeDocName,
  parseLessonDocName,
} from "./lib/slug.mjs";
import { ATOM_TYPE_TO_DATASET } from "./lib/datasets.mjs";

/** @typedef {import("./lib/types.mjs").DistilledAtom} DistilledAtom */
/** @typedef {import("./lib/types.mjs").MetadataInput} MetadataInput */

/**
 * @param {DistilledAtom} atom
 * @returns {string}
 */
export function targetDatasetForAtom(atom) {
  const fallback = compileSlot();
  return /** @type {Record<string, string>} */ (ATOM_TYPE_TO_DATASET)[atom.type] || fallback;
}

/** @param {DistilledAtom} atom */
export function parserForAtom(atom) {
  return atom.type === "self-improvement-lesson" ? parseLessonDocName : parseKnowledgeDocName;
}

/** @param {DistilledAtom} atom */
export function nameBuilderForAtom(atom) {
  return atom.type === "self-improvement-lesson" ? lessonDocName : knowledgeDocName;
}

// Build the metadata-condition filter for compile-time candidate retrieval.
// Tighter filters give the LLM cleaner candidates and bias toward update over
// create.
/**
 * @param {DistilledAtom} atom
 * @returns {MetadataInput}
 */
export function compileFilters(atom) {
  const filters = /** @type {MetadataInput} */ ({ atom_type: atom.type });
  // Scope candidate retrieval by `area` (the sub-module). project_module is now
  // the uniform workspace id, so it no longer discriminates; legacy atoms that
  // still carry project_module as the sub-module fall back to it.
  const area = atom.metadata?.area || atom.metadata?.project_module;
  if (area) filters.area = area;
  if (atom.metadata?.language) filters.language = atom.metadata.language;
  if (atom.metadata?.error_pattern) filters.error_pattern = atom.metadata.error_pattern;
  return filters;
}

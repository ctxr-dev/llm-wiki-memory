import { parseTarget } from "./target.mjs";
import { ContextValidationError } from "./errors.mjs";
import { placementTargetsCategory } from "../gate-target.mjs";
import { parseLayoutObject } from "../wiki-layout-parse.mjs";
import { ATOM_TYPES_LIST, TASK_TYPES_LIST, PRIORITY_VALUES } from "../datasets.mjs";

/** @typedef {import("../wiki-context.mjs").WikiContext} WikiContext */
/** @typedef {import("../wiki-context.mjs").WikiLevel} WikiLevel */
/** @typedef {import("./target.mjs").ResolvedTarget} ResolvedTarget */
/** @typedef {import("../types.mjs").MetadataInput} MetadataInput */

export const WRITE_KIND = Object.freeze({
  LESSON: "lesson",
  DOCUMENT: "document",
  MEMORY: "memory",
});
/** @type {readonly string[]} */
const WRITE_KIND_VALUES = Object.freeze([
  WRITE_KIND.LESSON,
  WRITE_KIND.DOCUMENT,
  WRITE_KIND.MEMORY,
]);

/**
 * @typedef {(typeof WRITE_KIND)[keyof typeof WRITE_KIND]} WriteKind
 * @typedef {Readonly<{
 *   kind: WriteKind,
 *   dataset: string,
 *   name: string | undefined,
 *   text: string | undefined,
 *   path: string | undefined,
 *   metadata: MetadataInput | undefined,
 *   userRequested: boolean | undefined,
 *   target: ResolvedTarget,
 *   gated: boolean,
 * }>} WriteRequest
 */

// The set of categories the target's layout declares GATED. Layout-driven (not
// hardcoded): an absent/unreadable layout falls back to the parser's name-keyed
// defaults (self_improvement gated, everything else ungated), so an install with
// no `gated:` in its YAML keeps the historical behaviour.
/**
 * @param {Record<string, unknown> | null | undefined} layout
 * @returns {string[]}
 */
function gatedCategoriesOf(layout) {
  const gated = parseLayoutObject(layout).gatedCategories;
  return Object.keys(gated).filter((c) => gated[c] === true);
}

/**
 * The write-gate decision: gated iff the declared `dataset` is a gated category
 * in the TARGET layout OR the placement `path` lands under one. Keeping BOTH
 * signals OR-ed is load-bearing (C4): a gated `dataset` gates regardless of path,
 * a gated-category `path` gates regardless of dataset, and neither the
 * `dataset:"knowledge"+path:"<gated>/…"` bypass nor its reverse escapes. The
 * gated set is now LAYOUT-DRIVEN (per-wiki `gated:` flags); with no layout it is
 * the name-keyed default (self_improvement only).
 * @param {string} dataset
 * @param {string | null | undefined} path
 * @param {Record<string, unknown> | null | undefined} [layout]
 * @returns {boolean}
 */
export function isGatedWrite(dataset, path, layout) {
  const gatedCats = gatedCategoriesOf(layout);
  if (gatedCats.includes(String(dataset || ""))) return true;
  return gatedCats.some((cat) => placementTargetsCategory(path, cat));
}

/**
 * The categories a level DECLARES — read the TARGET level's own merged layout
 * (C7), never the process-ambient category list.
 * @param {WikiLevel} level
 * @returns {string[]}
 */
function declaredCategories(level) {
  return parseLayoutObject(level.layout).cats;
}

/**
 * @param {string} field
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @returns {void}
 */
function assertInVocabulary(field, value, allowed) {
  if (value == null || value === "") return;
  if (!allowed.includes(String(value))) {
    throw new ContextValidationError({
      field,
      allowed,
      reason: `"${value}" is not one of the accepted ${field} values`,
    });
  }
}

/**
 * Close the context-derived metadata enums at the boundary. Shared with the
 * metadata-patch mutate path, which would otherwise be a vocabulary bypass:
 * atom_type is a PLACEMENT facet, so an off-vocab patch materialises a junk
 * directory on disk that no write door would ever have created.
 * @param {MetadataInput | undefined} metadata
 * @returns {void}
 */
export function assertMetadataVocabulary(metadata) {
  if (!metadata) return;
  assertInVocabulary("task_type", metadata.task_type, TASK_TYPES_LIST);
  assertInVocabulary("atom_type", metadata.atom_type, ATOM_TYPES_LIST);
  assertInVocabulary("priority", metadata.priority, PRIORITY_VALUES);
}

/**
 * Parse a raw write request against the resolved context into a frozen, fully
 * validated WriteRequest. Resolves the target (A2), then closes the
 * context-derived enums at the boundary: `dataset` MUST be declared at the
 * TARGET level (C7), and any supplied task_type / atom_type / priority MUST be
 * in vocabulary — each rejected with an actionable envelope. Computes the
 * write-gate decision (C4). Throws a {@link ContextValidationError} on any
 * invalid field; never coerces silently.
 * @param {WikiContext | null | undefined} env
 * @param {{ kind: string, dataset: string, name?: string, text?: string, path?: string, metadata?: MetadataInput, userRequested?: boolean, target?: string | null }} args
 * @returns {WriteRequest}
 */
export function parseWriteRequest(env, args) {
  if (!WRITE_KIND_VALUES.includes(String(args.kind))) {
    throw new ContextValidationError({
      field: "kind",
      allowed: WRITE_KIND_VALUES,
      reason: `"${args.kind}" is not a write kind`,
    });
  }
  const target = parseTarget(env, args.target);
  const dataset = String(args.dataset || "");
  const cats = declaredCategories(target.level);
  if (!cats.includes(dataset)) {
    throw new ContextValidationError({
      field: "dataset",
      allowed: cats,
      reason: `"${dataset}" is not a category declared at the target level`,
    });
  }
  assertMetadataVocabulary(args.metadata);
  return Object.freeze({
    kind: /** @type {WriteKind} */ (args.kind),
    dataset,
    name: args.name,
    text: args.text,
    path: args.path,
    metadata: args.metadata,
    userRequested: args.userRequested,
    target,
    gated: isGatedWrite(dataset, args.path, target.level.layout),
  });
}

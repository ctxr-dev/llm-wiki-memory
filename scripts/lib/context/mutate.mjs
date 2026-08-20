import { parseTarget } from "./target.mjs";
import { ContextValidationError } from "./errors.mjs";
import { assertMetadataVocabulary } from "./write.mjs";

/** @typedef {import("../wiki-context.mjs").WikiContext} WikiContext */
/** @typedef {import("./target.mjs").ResolvedTarget} ResolvedTarget */
/** @typedef {import("../types.mjs").MetadataInput} MetadataInput */

export const MUTATE_OP = Object.freeze({
  DISABLE: "disable",
  ENABLE: "enable",
  DELETE: "delete",
  MOVE: "move",
  METADATA: "metadata",
});
/** @type {readonly string[]} */
const MUTATE_OP_VALUES = Object.freeze([
  MUTATE_OP.DISABLE,
  MUTATE_OP.ENABLE,
  MUTATE_OP.DELETE,
  MUTATE_OP.MOVE,
  MUTATE_OP.METADATA,
]);

/**
 * @typedef {(typeof MUTATE_OP)[keyof typeof MUTATE_OP]} MutateOp
 * @typedef {Readonly<{
 *   op: MutateOp,
 *   dataset: string | undefined,
 *   documentId: string,
 *   toPath: string | undefined,
 *   metadata: MetadataInput | undefined,
 *   placementOverride: string | undefined,
 *   target: ResolvedTarget,
 * }>} MutateRequest
 */

/**
 * `pin:true` means "patch the frontmatter but leave the leaf where it is",
 * expressed to the store as a placementOverride of the leaf's own directory.
 * A bare filename yields "." from that slice, which normalisePlacementOverride
 * THROWS on, so an id with no directory pins to nothing (there is nowhere else
 * for it to go).
 * @param {string} documentId
 * @returns {string | undefined}
 */
function pinnedDirOf(documentId) {
  const dir = String(documentId || "")
    .split("/")
    .slice(0, -1)
    .join("/");
  return dir && dir !== "." ? dir : undefined;
}

/**
 * Parse a raw mutate request (disable / enable / delete / move) against the
 * resolved context into a frozen, typed MutateRequest. Validates the op enum and
 * resolves the target (A2) so the RELATIVE `documentId` resolves against a level
 * that IS in the resolved scope chain — a target naming no active level throws.
 * `move` requires a `toPath`; the store owns the faceted/topology/daily
 * relocation refusal and the disable/enable/delete not-found handling — those
 * stay runtime invariants. Throws a {@link ContextValidationError} on an unknown
 * op or a move missing its destination; never coerces silently. `metadata`
 * requires a `metadata` object and closes the same task_type / atom_type /
 * priority vocabulary the write path closes, so a facet patch can never
 * materialise a placement directory a write would have rejected.
 * @param {WikiContext | null | undefined} env
 * @param {{ op: string, dataset?: string, documentId: string, toPath?: string, metadata?: MetadataInput, pin?: boolean, target?: string | null }} args
 * @returns {MutateRequest}
 */
export function parseMutateRequest(env, args) {
  if (!MUTATE_OP_VALUES.includes(String(args.op))) {
    throw new ContextValidationError({
      field: "op",
      allowed: MUTATE_OP_VALUES,
      reason: `"${args.op}" is not a mutate operation`,
    });
  }
  const op = /** @type {MutateOp} */ (args.op);
  if (op === MUTATE_OP.MOVE && !(typeof args.toPath === "string" && args.toPath.trim() !== "")) {
    throw new ContextValidationError({
      field: "toPath",
      reason: "move requires a destination toPath (a wiki-relative dir + filename)",
    });
  }
  if (op === MUTATE_OP.METADATA) {
    if (!args.metadata || typeof args.metadata !== "object") {
      throw new ContextValidationError({
        field: "metadata",
        reason: "metadata requires a metadata object of frontmatter fields to patch",
      });
    }
    assertMetadataVocabulary(args.metadata);
  }
  const target = parseTarget(env, args.target);
  return Object.freeze({
    op,
    dataset: args.dataset,
    documentId: args.documentId,
    toPath: args.toPath,
    metadata: op === MUTATE_OP.METADATA ? args.metadata : undefined,
    placementOverride: args.pin === true ? pinnedDirOf(args.documentId) : undefined,
    target,
  });
}

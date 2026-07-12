import { parseTarget } from "./target.mjs";
import { ContextValidationError } from "./errors.mjs";

/** @typedef {import("../wiki-context.mjs").WikiContext} WikiContext */
/** @typedef {import("./target.mjs").ResolvedTarget} ResolvedTarget */

export const MUTATE_OP = Object.freeze({
  DISABLE: "disable",
  ENABLE: "enable",
  DELETE: "delete",
  MOVE: "move",
});
/** @type {readonly string[]} */
const MUTATE_OP_VALUES = Object.freeze([
  MUTATE_OP.DISABLE,
  MUTATE_OP.ENABLE,
  MUTATE_OP.DELETE,
  MUTATE_OP.MOVE,
]);

/**
 * @typedef {(typeof MUTATE_OP)[keyof typeof MUTATE_OP]} MutateOp
 * @typedef {Readonly<{
 *   op: MutateOp,
 *   dataset: string | undefined,
 *   documentId: string,
 *   toPath: string | undefined,
 *   target: ResolvedTarget,
 * }>} MutateRequest
 */

/**
 * Parse a raw mutate request (disable / enable / delete / move) against the
 * resolved context into a frozen, typed MutateRequest. Validates the op enum and
 * resolves the target (A2) so the RELATIVE `documentId` resolves against a level
 * that IS in the resolved scope chain — a target naming no active level throws.
 * `move` requires a `toPath`; the store owns the faceted/topology/daily
 * relocation refusal and the disable/enable/delete not-found handling — those
 * stay runtime invariants. Throws a {@link ContextValidationError} on an unknown
 * op or a move missing its destination; never coerces silently.
 * @param {WikiContext | null | undefined} env
 * @param {{ op: string, dataset?: string, documentId: string, toPath?: string, target?: string | null }} args
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
  const target = parseTarget(env, args.target);
  return Object.freeze({
    op,
    dataset: args.dataset,
    documentId: args.documentId,
    toPath: args.toPath,
    target,
  });
}

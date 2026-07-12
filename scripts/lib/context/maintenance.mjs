import { ContextValidationError } from "./errors.mjs";
import { AUDIT_CLASS_VALUES } from "./enums.mjs";

/** @type {Set<string>} */
const AUDIT_CLASS_SET = new Set(AUDIT_CLASS_VALUES);

/**
 * @typedef {Readonly<{
 *   dryRun: boolean | undefined,
 *   ifDue: boolean | undefined,
 *   force: boolean | undefined,
 *   llm: boolean | undefined,
 *   passes: string[] | undefined,
 *   cosineThreshold: number | undefined,
 *   target: string | undefined,
 * }>} ConsolidateRequest
 * @typedef {Readonly<{ classes: string[] }>} AuditRequest
 */

/**
 * Parse the consolidate options into a frozen, typed ConsolidateRequest. The
 * `target` stays a RAW string (C6): consolidate is scopes-wide and the brain-only
 * refusal is a runtime guard inside {@link consolidateMemory}, so it is NOT
 * resolved through {@link parseTarget} here. `cosineThreshold` is coerced to a
 * Number at the boundary so the dispatcher never re-coerces.
 * @param {{ dryRun?: boolean, ifDue?: boolean, force?: boolean, llm?: boolean, passes?: string[], cosineThreshold?: number, target?: string }} args
 * @returns {ConsolidateRequest}
 */
export function parseConsolidateRequest(args) {
  return Object.freeze({
    dryRun: args.dryRun,
    ifDue: args.ifDue,
    force: args.force,
    llm: args.llm,
    passes: args.passes,
    cosineThreshold: args.cosineThreshold != null ? Number(args.cosineThreshold) : undefined,
    target: args.target,
  });
}

/**
 * Parse the audit request into a frozen, typed AuditRequest: an empty/absent
 * class list defaults to ALL audit classes, and any off-vocabulary class is
 * rejected with an actionable envelope.
 * @param {{ classes?: string[] }} args
 * @returns {AuditRequest}
 */
export function parseAuditRequest(args) {
  return Object.freeze({ classes: normalizeAuditClasses(args.classes) });
}

/**
 * @param {string[] | undefined} classes
 * @returns {string[]}
 */
function normalizeAuditClasses(classes) {
  if (!classes || classes.length === 0) return [...AUDIT_CLASS_VALUES];
  for (const c of classes) {
    if (!AUDIT_CLASS_SET.has(String(c))) {
      throw new ContextValidationError({
        field: "classes",
        allowed: AUDIT_CLASS_VALUES,
        reason: `"${c}" is not an audit class`,
      });
    }
  }
  return [...classes];
}

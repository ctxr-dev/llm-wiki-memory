// Phase I — cron/consolidate isolation guards. Consolidate is BRAIN-ONLY in
// v1; these two belt-and-suspenders checks keep it that way:
//
//   1. filterBrainOwnedRefine — drop repo-owned (shared) categories from the
//      refine walk. The brain-only context already keeps mounts out of view,
//      but if the brain's OWN merged layout declares a category
//      `ownership: repo` (a federated overlay), it is still excluded so
//      consolidate can never rewrite or archive a shared leaf (R11).
//   2. guardConsolidateTarget — refuse an explicit shared/non-brain target.
//      A shared-target consolidate (target-tree lock + working-tree rewrite)
//      is DEFERRED to v1.1; v1 refuses it before any lock/commit/rewrite.

import { ownershipMap, mergedLayoutForRoot } from "./lib/wiki-ownership.mjs";
import { getActiveWikiContext, resolveTargetLevel } from "./lib/wiki-context.mjs";

export const SHARED_TARGET_ERROR = "shared-target-consolidate-unsupported";

/**
 * Partition the layout-declared refine categories into the ones consolidate may
 * walk (brain-owned) and the ones it must skip (repo-owned / shared). Ownership
 * is read from the brain root's merged layout; a category with no `ownership`
 * field is brain-owned, so a pre-federation single-tree wiki keeps every refine
 * category (byte-identical to before).
 * @param {string[]} refine category names declared `consolidate: refine`
 * @param {string} rootDir the brain wiki root to read ownership from
 * @returns {{ brainRefine: string[], repoOwnedRefine: string[] }}
 */
export function filterBrainOwnedRefine(refine, rootDir) {
  const owned = ownershipMap(mergedLayoutForRoot(rootDir));
  /** @type {string[]} */
  const brainRefine = [];
  /** @type {string[]} */
  const repoOwnedRefine = [];
  for (const c of refine) {
    if (owned.get(c) === "repo") repoOwnedRefine.push(c);
    else brainRefine.push(c);
  }
  return { brainRefine, repoOwnedRefine };
}

/**
 * Guard an explicit consolidate `target` selector. Consolidate operates
 * brain-only in v1, so an absent target, `""`, or `"brain"` proceeds; any target
 * that resolves to a non-brain (shared / repo-owned) level of the active
 * context — or that names no level at all — is REFUSED with an actionable
 * envelope BEFORE any lock/commit/rewrite runs. Returns `null` to proceed.
 * @param {string | null | undefined} target
 * @returns {Record<string, unknown> | null} refusal envelope, or null to proceed
 */
export function guardConsolidateTarget(target) {
  const t = typeof target === "string" ? target.trim() : "";
  if (t === "" || t === "brain") return null;
  if (targetResolvesToBrain(t)) return null;
  return {
    ok: false,
    error: SHARED_TARGET_ERROR,
    message:
      "shared-target consolidate is not supported in v1 (consolidate runs brain-only); " +
      `re-run without a shared --scopes/target. Requested target: ${JSON.stringify(target)}`,
    target: t,
    llmRequested: false,
    llm: false,
  };
}

/**
 * True when `t` names the brain (wiki-owned) level of the active context. No
 * active context, a repo-owned level, or a target that resolves to no level is
 * NOT the brain (so it is refused as a shared-target request).
 * @param {string} t
 * @returns {boolean}
 */
function targetResolvesToBrain(t) {
  const ctx = getActiveWikiContext();
  if (!ctx) return false;
  try {
    return resolveTargetLevel(ctx, t).ownership === "wiki";
  } catch {
    return false;
  }
}

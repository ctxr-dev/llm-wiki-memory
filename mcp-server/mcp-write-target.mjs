// Phase F write/mutate routing for the MCP tools.
//
// A write names its destination via a REQUIRED, explicit `target` (G1 — there is
// no brain default): "brain" or a chosen level's root/mountDir. This module
// composes the resolved `WikiContext` (bound by `withToolScopes`) with the
// per-operation `withWikiRoot` frame, so the leaf write, its index rebuild, and
// its commit-flush all resolve against the chosen level's root — never a silent
// shared write, never a silent brain write for an intended-shared target (R11).

import { getActiveWikiContext, resolveTargetLevel } from "../scripts/lib/wiki-context.mjs";
import { withWikiRoot } from "../scripts/lib/env.mjs";
import { OWNERSHIP } from "../scripts/lib/context/enums.mjs";

/** @typedef {import("../scripts/lib/wiki-context.mjs").WikiLevel} WikiLevel */

/**
 * Resolve the `target` selector against the active context and run `fn` inside a
 * `withWikiRoot` frame pinned to the chosen level's root, passing that level to
 * `fn`. `target` is REQUIRED and explicit: an empty/missing target throws (no
 * implicit brain default — G1), as does a target naming no context level (both
 * surfaced as an MCP errorResponse by the caller). Pass "brain" for private memory.
 * @template T
 * @param {string | null | undefined} target
 * @param {(level: WikiLevel) => T} fn
 * @returns {T}
 */
export function withWriteTarget(target, fn) {
  const ctx = getActiveWikiContext();
  if (!ctx) {
    throw new Error("a memory write requires an active wiki context; pass `scopes`");
  }
  const level = resolveTargetLevel(ctx, target);
  return withWikiRoot(level.root, () => fn(level));
}

/**
 * Like {@link withWriteTarget} but for an ALREADY-resolved target (from
 * parseTarget / parseWriteRequest): bind a `withWikiRoot` frame to the chosen
 * level's root and pass that level to `fn`. Skips re-resolution because the
 * ResolvedTarget already came from a validated context.
 * @template T
 * @param {import("../scripts/lib/context/target.mjs").ResolvedTarget} resolved
 * @param {(level: WikiLevel) => T} fn
 * @returns {T}
 */
export function withResolvedWriteTarget(resolved, fn) {
  return withWikiRoot(resolved.level.root, () => fn(resolved.level));
}

/**
 * Annotate a write result destined for a SHARED (repo-owned) level: the leaf is
 * only staged in the repo's working tree and the engine ran no git (R11), so
 * tell the caller to commit and push it. A brain write is returned unchanged.
 * @param {WikiLevel} level
 * @param {Record<string, unknown>} result
 * @returns {Record<string, unknown>}
 */
export function annotateSharedWrite(level, result) {
  if (!level || level.ownership !== OWNERSHIP.REPO) return result;
  const created = /** @type {{ document?: { id?: string } }} */ (result?.created);
  const rel = created && created.document ? created.document.id : undefined;
  const repo = level.projectModule || level.mountDir;
  /** @type {Record<string, unknown>} */
  const annotated = {
    ...result,
    sharedTarget: { repo, root: level.root, path: rel },
    message: rel
      ? `written to ${rel} in ${repo} — commit and push the repo's staged memory changes (the leaf plus its regenerated index; a relocate also removes the old leaf) to share it; stage all of them (e.g. \`git add -A\` under the wiki dir), not just the named path`
      : `written into ${repo} — commit and push the repo's staged memory changes to share it`,
  };
  // A repo with no git origin remote (and no declared project_id) resolves to a
  // NON-PORTABLE file://<local-abs-path> identity. If this leaf is committed, that
  // machine-specific path ships to teammates and won't match their clone. Warn so
  // the user adds an origin remote (or a project_id in the mount layout) before
  // sharing. Non-fatal — the write still succeeds (staged only, no git ran).
  if (typeof level.projectModule === "string" && level.projectModule.startsWith("file://")) {
    annotated.warning = `identity for this mount is a local path (${level.projectModule}) — it has no git origin remote or declared project_id, so the stamped project_module is machine-specific. Add an 'origin' remote or a layout project_id before committing this leaf to share it portably.`;
  }
  return annotated;
}

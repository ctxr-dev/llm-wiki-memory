// Phase F write/mutate routing for the MCP tools.
//
// A write defaults to the BRAIN (the context's write-default); an explicit
// `target` routes it into a chosen level. This module composes the resolved
// `WikiContext` (bound by `withToolScopes`) with the per-operation
// `withWikiRoot` frame, so the leaf write, its index rebuild, and its
// commit-flush all resolve against the chosen level's root — never a silent
// shared write, never a silent brain write for an intended-shared target (R11).

import { getActiveWikiContext, resolveTargetLevel } from "../scripts/lib/wiki-context.mjs";
import { withWikiRoot } from "../scripts/lib/env.mjs";
import { OWNERSHIP } from "../scripts/lib/context/enums.mjs";

/** @typedef {import("../scripts/lib/wiki-context.mjs").WikiLevel} WikiLevel */

/**
 * Resolve the `target` selector against the active context and run `fn` inside a
 * `withWikiRoot` frame pinned to the chosen level's root, passing that level to
 * `fn`. With no target the write-default (brain) is chosen, so `wikiRoot()`
 * stays exactly what `withToolScopes` already set (single-tree behaviour is
 * byte-identical). A target naming no context level throws (surfaced as an MCP
 * errorResponse by the caller).
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
  return {
    ...result,
    sharedTarget: { repo, root: level.root, path: rel },
    message: rel
      ? `written to ${rel} in ${repo} — commit and push it in the repo to share it`
      : `written into ${repo} — commit and push it in the repo to share it`,
  };
}

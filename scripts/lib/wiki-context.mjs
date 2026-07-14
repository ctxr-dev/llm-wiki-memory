// Shared per-operation wiki context for the federated (layered) wiki: the
// shapes, the RESOLVER that turns a set of scopes into a fully-enriched
// context, and the AsyncLocalStorage frame that carries the active context
// through a single operation.
//
// A federated wiki is a stack of levels: a repo-owned level (checked into the
// consuming project) layered under a wiki-owned level (the user's private
// memory tree). Each level carries its own resolved layout, ownership, and
// depth in the stack. The scanner (scope-scanner.mjs) emits placement facts;
// this module enriches them with the merged layout + embed-cache resolver and
// binds the result to an async frame.
//
// Wiring the resolver into wiki-store / env / the MCP server is a LATER phase;
// this module is import-safe — its only module-scope side effect is
// constructing the AsyncLocalStorage instance, mirroring settings.mjs.

import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { scanScopes } from "./scope-scanner.mjs";
import { loadMergedLayout, readMergedLayout } from "./layout-merge.mjs";
import { embedBackend } from "./settings.mjs";
import { withWikiRoot, embedCacheFor as embedCacheForRoot } from "./env.mjs";
import { OwnershipSchema, OWNERSHIP } from "./context/enums.mjs";
import { parseTarget } from "./context/target.mjs";
import { projectModuleSegment } from "./project-identity.mjs";

/**
 * One level of a federated wiki stack.
 * @typedef {Object} WikiLevel
 * @property {string} root absolute path to this level's wiki root directory
 * @property {string} mountDir absolute path to the directory that holds this level's `.llm-wiki-memory` mount
 * @property {"repo" | "wiki"} ownership who owns this level: the consuming repo, or the private wiki
 * @property {number} depth 0-based position in the stack (0 = outermost/nearest)
 * @property {string} projectModule the workspace/module identifier this level scopes to
 * @property {Record<string, unknown>} layout the parsed + merged layout object for this level
 * @property {(category: string) => string} embedCacheFor absolute path to this level's embedding cache for a category
 * @property {string} [embedBackend] optional embedding backend override for this level
 */

/**
 * The resolved context for a single wiki operation across a federated stack.
 * @typedef {Object} WikiContext
 * @property {WikiLevel[]} levels every level in the stack, outermost first
 * @property {WikiLevel} brain the level that answers reads (the merged/authoritative view)
 * @property {WikiLevel} writeDefault the level new writes land in unless a level is chosen explicitly
 */

// `embedCacheFor` is a runtime function and `layout` is an opaque object, so
// both are validated structurally (function-ness / object-ness), not by shape.
export const WikiLevelSchema = z
  .object({
    root: z.string().min(1),
    mountDir: z.string().min(1),
    ownership: OwnershipSchema,
    depth: z.number().int().nonnegative(),
    projectModule: z.string(),
    layout: z.record(z.string(), z.unknown()),
    embedCacheFor: z.custom((v) => typeof v === "function").optional(),
    embedBackend: z.string().optional(),
  })
  .strict();

export const WikiContextSchema = z
  .object({
    levels: z.array(WikiLevelSchema),
    brain: WikiLevelSchema,
    writeDefault: WikiLevelSchema,
  })
  .strict();

/**
 * The process embed backend, or undefined when it cannot be read. Optional by
 * contract, so a config read failure omits it rather than failing the resolve.
 * @returns {string | undefined}
 */
function readEmbedBackend() {
  try {
    const backend = embedBackend();
    return typeof backend === "string" && backend ? backend : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {string} layoutDir
 * @returns {Record<string, unknown>}
 */
function resolveLevelLayout(layoutDir) {
  try {
    return loadMergedLayout(layoutDir);
  } catch (err) {
    const tolerant = readMergedLayout(layoutDir);
    if (Object.keys(tolerant).length > 0) return tolerant;
    throw err;
  }
}

/**
 * @param {import("./scope-scanner.mjs").ScopeLevel} level
 * @param {Record<string, unknown>} layout
 * @returns {string}
 */
function levelProjectModule(level, layout) {
  if (level.ownership === OWNERSHIP.REPO) {
    const declaredId = /** @type {{ project_id?: unknown }} */ (layout)?.project_id;
    if (declaredId) return String(declaredId);
    return projectModuleSegment({ mountDir: level.mountDir, ownership: OWNERSHIP.REPO });
  }
  // The brain (wiki-owned) keeps the scanner's env-default module — which is
  // EXACTLY what normaliseMeta stamps onto brain leaves (defaultProjectModule()).
  // A layout `project_id` is a REPO-mount portable-identity concept and is NOT
  // honored for the brain: doing so would diverge the brain's read-side module
  // from its write-stamp and silently drop every brain leaf from federated recall.
  return level.projectModule;
}

/**
 * Enrich a scanner-emitted placement level into a full {@link WikiLevel}: attach
 * the merged (shared + local) layout, the process embed backend when available,
 * and a per-level embed-cache resolver. A repo-owned level's `projectModule` is
 * resolved to its deterministic identity (declared project_id > canonical git
 * origin > file:// of the mount dir); the wiki brain keeps the env default.
 * @param {import("./scope-scanner.mjs").ScopeLevel} level
 * @param {string} [backend]
 * @returns {WikiLevel}
 */
function enrichLevel(level, backend) {
  const layout = resolveLevelLayout(path.join(level.root, ".layout"));
  /** @type {WikiLevel} */
  const enriched = {
    root: level.root,
    mountDir: level.mountDir,
    ownership: level.ownership,
    depth: level.depth,
    projectModule: levelProjectModule(level, layout),
    layout,
    embedCacheFor: (category) => embedCacheForRoot(level.root, category),
  };
  if (backend) enriched.embedBackend = backend;
  return enriched;
}

/**
 * Resolve a full {@link WikiContext} for the given scopes: scan the scope chain,
 * enrich every discovered level, then pick the brain and default write target.
 *
 * The brain is the depth-0 level; for step 2 it is also `writeDefault` (routing
 * writes to a shared/repo level is a later phase). The serialisable shape is
 * validated with {@link WikiContextSchema} and a failure throws loudly.
 * @param {string[]} [scopes] directories to scope from (see {@link scanScopes})
 * @param {{ home?: string, brainDataDir?: string }} [opts] injectable roots for tests
 * @returns {WikiContext}
 */
export function resolveWikiContext(scopes, opts = {}) {
  const backend = readEmbedBackend();
  /** @type {WikiLevel[]} */
  const levels = [];
  for (const level of scanScopes(scopes, opts)) {
    try {
      levels.push(enrichLevel(level, backend));
    } catch (err) {
      // A broken BRAIN layout (depth-0, wiki-owned) is fatal — nothing can operate
      // without it. But a broken DISCOVERED repo sibling must not wedge an op that
      // targets the brain or another level: skip it (surfaced), leaving it simply
      // not addressable (targeting it then throws "not one of the active levels").
      if (level.ownership !== OWNERSHIP.REPO) throw err;
      console.error(
        `resolveWikiContext: skipping mount with an unreadable layout: ${level.mountDir} (${/** @type {Error} */ (err)?.message || err})`,
      );
    }
  }
  const brain = levels[0];
  /** @type {WikiContext} */
  const context = { levels, brain, writeDefault: brain };
  const parsed = WikiContextSchema.safeParse(context);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`resolveWikiContext produced an invalid context: ${detail}`);
  }
  return context;
}

/** @type {AsyncLocalStorage<WikiContext>} */
const contextStorage = new AsyncLocalStorage();

/**
 * Run `fn` inside an async frame carrying `ctx` as the active wiki context AND
 * the env wiki-root override set to `ctx.writeDefault.root`, so operations
 * inside default to the write-default level (the brain unless a level is chosen
 * explicitly). A read that needs a different level nests its own
 * {@link withWikiRoot} frame (Phase E). Concurrent frames each see their own
 * context; both frames disappear when `fn` settles. Mirrors settings.mjs
 * `withSettingsOverride`.
 * @template T
 * @param {WikiContext} ctx
 * @param {() => T} fn
 * @returns {T}
 */
export function withWikiContext(ctx, fn) {
  return contextStorage.run(ctx, () => withWikiRoot(ctx.writeDefault.root, fn));
}

/**
 * The active wiki context for the current async frame, or `null` outside one.
 * @returns {WikiContext | null}
 */
export function getActiveWikiContext() {
  return contextStorage.getStore() || null;
}

/**
 * Resolve a write/mutate `target` selector against a resolved context's levels
 * to the SAME WikiLevel reference the context holds. Delegates to `parseTarget`
 * (context/target.mjs), which owns the selection rules: a level's `root` or
 * `mountDir`, or the literal `"brain"` (the wiki-owned level). `target` is
 * REQUIRED — an empty/missing target throws (no brain default, G1), as does a
 * non-empty target naming no level; a write directed elsewhere must surface as
 * an error, never fall back silently to the brain (R11).
 * @param {WikiContext} ctx
 * @param {string | null | undefined} target
 * @returns {WikiLevel}
 */
export function resolveTargetLevel(ctx, target) {
  return parseTarget(ctx, target).level;
}

/**
 * Resolve a BRAIN-ONLY context (no repo levels) and run `fn` inside it. The
 * helper compile / flush / cron / hooks use so they never build a chain.
 * @template T
 * @param {() => T} fn
 * @param {{ home?: string, brainDataDir?: string }} [opts] injectable roots for tests
 * @returns {T}
 */
export function withBrainContext(fn, opts = {}) {
  return withWikiContext(resolveWikiContext([], opts), fn);
}

/**
 * Best-effort {@link withBrainContext} for internal automation entrypoints
 * (compile, flush worker, cron, the capture hooks). It runs `fn` inside a
 * brain-only context, but if the context cannot be RESOLVED — e.g. the wiki is
 * not initialised yet, so `loadMergedLayout` throws on the empty layout — it
 * falls through to running `fn` with no context, exactly today's behavior. This
 * preserves each hook's exit-0 / best-effort contract: a resolve failure must
 * not crash a capture hook.
 *
 * Only the resolve is guarded — an error thrown by `fn` itself propagates
 * unchanged (the guard never swallows the caller's own failures).
 * @template T
 * @param {() => T} fn
 * @param {{ home?: string, brainDataDir?: string }} [opts] injectable roots for tests
 * @returns {T}
 */
export function withBrainContextSafe(fn, opts = {}) {
  /** @type {WikiContext} */
  let ctx;
  try {
    ctx = resolveWikiContext([], opts);
  } catch {
    return fn();
  }
  return withWikiContext(ctx, fn);
}

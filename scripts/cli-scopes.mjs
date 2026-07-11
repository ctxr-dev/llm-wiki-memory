// Scope plumbing for the CLI READ commands (where / recall / search).
//
// A READ command must run against a concrete, non-empty set of scopes. The
// design is deliberately deterministic: an explicit `--scopes` flag wins,
// otherwise the shell cwd is the sole scope. There is no implicit "search
// everything" fallback — a scope we cannot pin down is a HARD FAIL, because a
// read that guesses its root is worse than one that refuses.
//
// `withScopeContext` then runs the command body inside the resolved
// WikiContext. Today the context's write-default IS the brain, so reads still
// hit one root (behavior-neutral); Phase E will fan out over `ctx.levels`.

import { resolveWikiContext, withWikiContext } from "./lib/wiki-context.mjs";

const SCOPES_FLAG = "--scopes";
const SCOPES_EQ = "--scopes=";

/**
 * @param {string} value a raw `--scopes` value (comma- and/or whitespace-separated)
 * @returns {string[]} the non-empty entries
 */
function splitScopeValue(value) {
  return value.split(/[\s,]+/).filter(Boolean);
}

/**
 * Collect the `--scopes` values from `args`. Returns `null` when the flag is
 * absent entirely (so the caller can fall back to the cwd), or the collected
 * list when it is present — possibly EMPTY when the flag carried no usable
 * value, which the caller treats as a hard failure.
 * @param {string[]} args
 * @returns {string[] | null}
 */
function parseScopesFlag(args) {
  let present = false;
  /** @type {string[]} */
  const collected = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === SCOPES_FLAG) {
      present = true;
      collected.push(...splitScopeValue(args[i + 1] ?? ""));
      i += 1;
    } else if (arg.startsWith(SCOPES_EQ)) {
      present = true;
      collected.push(...splitScopeValue(arg.slice(SCOPES_EQ.length)));
    }
  }
  return present ? collected : null;
}

/**
 * @param {() => string} cwdFn
 * @returns {string} the cwd, or "" when it cannot be resolved (thrown or empty)
 */
function safeResolveCwd(cwdFn) {
  try {
    const cwd = cwdFn();
    return typeof cwd === "string" ? cwd : "";
  } catch {
    return "";
  }
}

/**
 * Resolve the concrete, non-empty scope set for a CLI READ command. A
 * `--scopes` flag (comma- and/or whitespace-separated) wins; otherwise the
 * shell cwd is the sole scope. NEVER returns an empty array: an explicit but
 * empty `--scopes`, or an unresolvable cwd with no flag, is a HARD FAIL — the
 * caller cannot know which wiki to read.
 * @param {string[]} args the command's argv tail
 * @param {{ cwd?: () => string }} [opts] injectable cwd provider for tests
 * @returns {string[]} a non-empty list of scope directories
 */
export function resolveCliScopes(args, { cwd = () => process.cwd() } = {}) {
  const flagScopes = parseScopesFlag(args);
  if (flagScopes !== null) {
    if (flagScopes.length === 0) {
      throw new Error(
        `${SCOPES_FLAG} was given but resolved to no directories; pass a comma- or space-separated list of paths`,
      );
    }
    return flagScopes;
  }
  const resolved = safeResolveCwd(cwd);
  if (!resolved) {
    throw new Error(
      `cannot resolve CLI scopes: process.cwd() is unavailable and no ${SCOPES_FLAG} flag was given`,
    );
  }
  return [resolved];
}

/**
 * Return `args` with any `--scopes` flag (and its value) removed, so a command
 * that treats its positional tail as a query is unaffected by the additive
 * scope flag. A no-op when no flag is present.
 * @param {string[]} args
 * @returns {string[]}
 */
export function stripScopesArgs(args) {
  /** @type {string[]} */
  const kept = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === SCOPES_FLAG) {
      i += 1;
      continue;
    }
    if (arg.startsWith(SCOPES_EQ)) continue;
    kept.push(arg);
  }
  return kept;
}

/**
 * Run `fn` inside the WikiContext resolved from `scopes`. If the context cannot
 * be RESOLVED (the wiki is not initialised, or a discovered mount has an invalid
 * layout), fall through to running `fn` with no context — today's single-root
 * behavior — so a read command never crashes on an unresolvable tree. Mirrors
 * `withBrainContextSafe`: only the resolve is guarded; an error thrown by `fn`
 * itself propagates unchanged.
 * @template T
 * @param {string[]} scopes
 * @param {() => T} fn
 * @param {{ home?: string, brainDataDir?: string }} [opts] injectable roots for tests
 * @returns {T}
 */
export function withScopeContext(scopes, fn, opts = {}) {
  /** @type {import("./lib/wiki-context.mjs").WikiContext} */
  let ctx;
  try {
    ctx = resolveWikiContext(scopes, opts);
  } catch {
    return fn();
  }
  return withWikiContext(ctx, fn);
}

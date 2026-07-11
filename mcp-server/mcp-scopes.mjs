// Required, non-empty `scopes` contract shared by every MCP tool.
//
// Phase C step 5c makes `scopes` a REQUIRED argument on every tool: the caller
// must declare which wiki context each call concerns (security + determinism).
// `ScopesSchema` is a zod FIELD SHAPE spread into each tool's `inputSchema`, so
// the SDK folds it into the generated JSON schema with `minItems: 1` — an empty
// or missing `scopes` is a deterministic HARD FAIL at the protocol layer
// (McpError InvalidParams) BEFORE any handler runs. `withToolScopes` then
// resolves the declared scopes into a WikiContext and runs the handler body
// inside it.

import { z } from "zod";
import { resolveWikiContext, withWikiContext } from "../scripts/lib/wiki-context.mjs";
import { errorResponse } from "./mcp-responses.mjs";

// `.min(1)` on the array (not just its entries) is load-bearing: it is what
// makes an empty `scopes: []` — and, because the field is not `.optional()`, a
// missing one — reject at the schema layer rather than reaching a handler.
export const ScopesSchema = z.array(z.string().min(1)).min(1);

/**
 * Resolve the schema-validated `args.scopes` into a WikiContext and run the tool
 * handler `fn` inside it via {@link withWikiContext}. Today the context's
 * write-default IS the brain (single-tree case), so `wikiRoot()` resolves to the
 * same root as before and results are unchanged; read fan-out over the levels
 * arrives in a later phase.
 *
 * A resolve failure (a bad or uninitialised scope dir) returns a clean
 * {@link errorResponse} instead of throwing, so a malformed scope can never
 * crash the server. An empty or missing `scopes` never reaches here — the
 * schema rejects it first.
 * @template T
 * @param {{ scopes?: string[] }} args the tool's parsed arguments
 * @param {() => T} fn the tool handler body
 * @returns {T | ReturnType<typeof errorResponse>}
 */
export function withToolScopes(args, fn) {
  /** @type {import("../scripts/lib/wiki-context.mjs").WikiContext} */
  let ctx;
  try {
    ctx = resolveWikiContext(args.scopes);
  } catch (error) {
    return errorResponse(error);
  }
  return withWikiContext(ctx, fn);
}

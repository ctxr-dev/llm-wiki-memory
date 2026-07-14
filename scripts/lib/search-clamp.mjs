// MCP-boundary excerpting for search_memory / recall_lessons tool responses.
//
// The search LIBRARY (searchMemoryFiltered / recall) returns FULL bodies on
// purpose — internal callers (consolidate, compile, recall) depend on that. But
// a broad query's JSON-RPC tool response can exceed the client's token cap
// (observed 60-82KB dumped to a file). So the MCP handlers excerpt per-hit HERE,
// at the agent-facing boundary only: every clipped hit keeps its name + score
// (and id where present) so the agent can `read_document` the whole leaf.
// `fullContent: true` opts out entirely; `maxChars` tunes the per-hit width.
import { truncateAtWordBoundary } from "./slug.mjs";
import { priorityRank } from "./datasets.mjs";

/** @typedef {import("./types.mjs").Priority} Priority */

/**
 * A hit record this module clamps: any object exposing an optional `priority`
 * and `content`, spread through untouched apart from body-excerpting fields.
 * Covers both `SearchHit` and `RecallRecord`.
 * @typedef {{ priority?: Priority, content?: unknown } & Record<string, unknown>} ClampableHit
 */

/**
 * The envelope this module clamps: `SearchResponse` / `RecallResponse`, or any
 * value (returned unchanged when it lacks a `records` array).
 * @typedef {{ records?: ClampableHit[] } & Record<string, unknown>} ClampableResponse
 */

export const SEARCH_PER_HIT_CHARS = 600;
// Per-level body budget. A federated (multi-level) response scales this by the
// number of levels that returned hits (see `levelCount`), so fanning a query
// over N trees isn't squeezed into one tree's budget. Depth NEVER reorders the
// spend: bodies are still spent P0 > P1 > P2, and a hit is never dropped.
export const SEARCH_TOTAL_BUDGET = 16000;

// Levels that contributed hits, inferred from the fan-out `resolvedRoot` tag (each
// level owns a distinct wiki root). Counting distinct ROOTS — not distinct depths —
// is correct now that SIBLING levels share a depth (they are ranked by relevance,
// so distinct depths would under-count them and shrink the body budget). A
// single-tree response carries no `resolvedRoot`, so this is 1 and the budget is
// unchanged (byte-identical). An explicit `opts.levels` wins when supplied.
/**
 * @param {ClampableHit[]} records
 * @param {number} [explicit]
 * @returns {number}
 */
function levelCount(records, explicit) {
  if (explicit && explicit > 0) return explicit;
  const roots = new Set();
  const depths = new Set();
  for (const r of records) {
    if (typeof r.resolvedRoot === "string" && r.resolvedRoot) roots.add(r.resolvedRoot);
    if (typeof r.depth === "number") depths.add(r.depth);
  }
  // Prefer distinct ROOTS (real fan-out tags each hit with its level's root, and
  // sibling levels share a depth but never a root). Fall back to distinct depths
  // when roots aren't tagged. Neither present (single tree) → 1.
  if (roots.size > 0) return roots.size;
  return Math.max(1, depths.size);
}

/**
 * @param {ClampableResponse | null | undefined} result
 * @param {{ maxChars?: number, fullContent?: boolean, sections?: string[], perHitDefault?: number, levels?: number }} [opts]
 * @returns {ClampableResponse | null | undefined}
 */
export function clampSearchResponse(
  result,
  { maxChars, fullContent, sections, perHitDefault = SEARCH_PER_HIT_CHARS, levels } = {},
) {
  if (!result || !Array.isArray(result.records)) return result;
  // Frontmatter-only view (sections=["frontmatter"]): the glance fields already
  // rode along on each record; drop the body entirely and skip excerpting. This
  // is the light session-start path. When "body" is also requested (or sections
  // is omitted) we fall through to the normal body-excerpt logic below.
  if (Array.isArray(sections) && sections.includes("frontmatter") && !sections.includes("body")) {
    const records = result.records.map(({ content, truncated, fullChars, ...rest }) => rest);
    return { ...result, records };
  }
  if (fullContent) return result;
  const perHit =
    Number.isInteger(maxChars) && /** @type {number} */ (maxChars) > 0
      ? /** @type {number} */ (maxChars)
      : perHitDefault;
  // Spend the total body budget in PRIORITY order (P0 > P1 > P2; original order
  // within a tier) so that when it runs out the LOWEST-priority bodies are the
  // ones emptied — a relevant hit is NEVER dropped (it keeps name/score/id), only
  // its body is trimmed. The OUTPUT preserves the caller's (relevance) order.
  const spendOrder = result.records
    .map((r, i) => ({ i, r }))
    .sort((a, b) => priorityRank(a.r.priority) - priorityRank(b.r.priority));
  const totalBudget = SEARCH_TOTAL_BUDGET * levelCount(result.records, levels);
  /** @type {ClampableHit[]} */
  const decided = new Array(result.records.length);
  let total = 0;
  let anyTruncated = false;
  for (const { i, r } of spendOrder) {
    const full = String(r.content ?? "");
    let content = full;
    let truncated = false;
    if (total >= totalBudget) {
      content = ""; // total budget spent: keep the hit (name/score/id), drop the body
      truncated = full.length > 0;
    } else if (full.length > perHit) {
      content = `${truncateAtWordBoundary(full, perHit)} …`;
      truncated = true;
    }
    total += content.length;
    if (truncated) anyTruncated = true;
    decided[i] = truncated
      ? { ...r, content, truncated: true, fullChars: full.length }
      : { ...r, content };
  }
  return anyTruncated
    ? { ...result, records: decided, truncated: true }
    : { ...result, records: decided };
}

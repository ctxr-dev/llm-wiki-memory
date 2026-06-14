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

export const SEARCH_PER_HIT_CHARS = 600;
export const SEARCH_TOTAL_BUDGET = 16000;

export function clampSearchResponse(
  result,
  { maxChars, fullContent, perHitDefault = SEARCH_PER_HIT_CHARS } = {},
) {
  if (fullContent || !result || !Array.isArray(result.records)) return result;
  const perHit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : perHitDefault;
  // Spend the total body budget in PRIORITY order (P0 > P1 > P2; original order
  // within a tier) so that when it runs out the LOWEST-priority bodies are the
  // ones emptied — a relevant hit is NEVER dropped (it keeps name/score/id), only
  // its body is trimmed. The OUTPUT preserves the caller's (relevance) order.
  const spendOrder = result.records
    .map((r, i) => ({ i, r }))
    .sort((a, b) => priorityRank(a.r.priority) - priorityRank(b.r.priority));
  const decided = new Array(result.records.length);
  let total = 0;
  let anyTruncated = false;
  for (const { i, r } of spendOrder) {
    const full = String(r.content ?? "");
    let content = full;
    let truncated = false;
    if (total >= SEARCH_TOTAL_BUDGET) {
      content = ""; // total budget spent: keep the hit (name/score/id), drop the body
      truncated = full.length > 0;
    } else if (full.length > perHit) {
      content = `${truncateAtWordBoundary(full, perHit)} …`;
      truncated = true;
    }
    total += content.length;
    if (truncated) anyTruncated = true;
    decided[i] = truncated ? { ...r, content, truncated: true, fullChars: full.length } : { ...r, content };
  }
  return anyTruncated ? { ...result, records: decided, truncated: true } : { ...result, records: decided };
}

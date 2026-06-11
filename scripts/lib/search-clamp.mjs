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

export const SEARCH_PER_HIT_CHARS = 600;
export const SEARCH_TOTAL_BUDGET = 16000;

export function clampSearchResponse(
  result,
  { maxChars, fullContent, perHitDefault = SEARCH_PER_HIT_CHARS } = {},
) {
  if (fullContent || !result || !Array.isArray(result.records)) return result;
  const perHit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : perHitDefault;
  let total = 0;
  let anyTruncated = false;
  const records = result.records.map((r) => {
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
    return truncated ? { ...r, content, truncated: true, fullChars: full.length } : { ...r, content };
  });
  return anyTruncated ? { ...result, records, truncated: true } : { ...result, records };
}

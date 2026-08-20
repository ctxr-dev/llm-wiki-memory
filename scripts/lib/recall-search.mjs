import { defaultProjectModule } from "./env.mjs";
import { recallScoreThreshold } from "./settings.mjs";
import { searchMemoryFiltered, scopedCategories } from "./wiki-store.mjs";
import { defaultColdBudget, openColdDraw, coldPartial } from "./cold-budget.mjs";

/** @typedef {import("./types.mjs").SearchResponse} SearchResponse */
/** @typedef {import("./types.mjs").SearchHit} SearchHit */
/** @typedef {import("./types.mjs").MetadataInput} MetadataInput */

// Cross-category search with optional project_module auto-injection. When
// `sections` requests the frontmatter glance view, records carry glance fields
// (brief/type/status/progress/tags); otherwise the record shape is unchanged.
/**
 * @param {Object} [args]
 * @param {string} [args.query]
 * @param {string[]} [args.datasets]
 * @param {MetadataInput | null} [args.filters]
 * @param {number} [args.scoreThreshold]
 * @param {number} [args.maxResults]
 * @param {string[]} [args.sections]
 * @returns {Promise<SearchResponse>}
 */
export async function searchMemory({
  query,
  datasets,
  filters,
  scoreThreshold,
  maxResults,
  sections,
} = {}) {
  const limit = maxResults || 8;
  const withGlance = Array.isArray(sections) && sections.includes("frontmatter");
  // Caller threshold wins; else the configured floor (settings.recall.scoreThreshold).
  const effectiveThreshold = scoreThreshold ?? recallScoreThreshold();
  // scopedCategories() is the UNION across the active scope chain, so a default
  // (no-`datasets`) search covers a category declared only in a shared repo level
  // (e.g. a tracker `issues` tree) — not just the brain's own categories. With no
  // context / a single level it is the single-tree getCategories (unchanged).
  const slots = Array.isArray(datasets) && datasets.length ? datasets : scopedCategories();
  const effectiveFilters = filters
    ? filters.project_module
      ? filters
      : {
          ...filters,
          ...(defaultProjectModule() ? { project_module: defaultProjectModule() } : {}),
        }
    : null;

  const all = [];
  const errors = [];
  // One cold-embed ledger for the whole cross-category search, so scanning N
  // categories cannot cost N times the bound.
  const coldBudget = defaultColdBudget();
  for (const slot of slots) {
    try {
      // Reserve a tail for the categories after this one: without it the first category could
      // spend the whole bound and the rest returned ZERO hits, not fewer.
      openColdDraw(coldBudget);
      const { records } = /** @type {{ records: SearchHit[] }} */ (
        await searchMemoryFiltered({
          coldBudget,
          query,
          datasetId: slot,
          filters: /** @type {Record<string, unknown> | undefined} */ (
            /** @type {unknown} */ (effectiveFilters)
          ),
          scoreThreshold: effectiveThreshold,
          limit,
          withGlance,
          chunkAware: true,
        })
      );
      all.push(...records);
    } catch (err) {
      errors.push({ datasetId: slot, message: err instanceof Error ? err.message : String(err) });
    }
  }
  // Rank by the fan-out's depth-boosted metric when present (deeper/more-local
  // wins), else the honest cosine — byte-identical for a single-tree read.
  const rankOf = (/** @type {SearchHit} */ r) => r.adjustedConfidence ?? r.score ?? -1;
  all.sort((a, b) => rankOf(b) - rankOf(a));
  return {
    query,
    ...coldPartial(coldBudget),
    datasetsSearched: slots,
    filters: filters || null,
    injectedFilters:
      filters && !filters.project_module && defaultProjectModule()
        ? { project_module: defaultProjectModule() }
        : null,
    scoreThreshold: scoreThreshold ?? null,
    errors,
    totalRecords: all.length,
    records: all.slice(0, limit),
  };
}

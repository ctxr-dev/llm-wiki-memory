import { defaultProjectModule } from "./env.mjs";
import { recallScoreThreshold } from "./settings.mjs";
import { searchMemoryFiltered, getCategories } from "./wiki-store.mjs";

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
  // getCategories() runs ensureLayoutLoaded() first, so fresh CLI invocations
  // see the YAML-declared categories (including any custom ones like `issues`).
  const slots = Array.isArray(datasets) && datasets.length ? datasets : getCategories();
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
  for (const slot of slots) {
    try {
      const { records } = /** @type {{ records: SearchHit[] }} */ (
        await searchMemoryFiltered({
          query,
          datasetId: slot,
          filters: /** @type {Record<string, unknown> | undefined} */ (
            /** @type {unknown} */ (effectiveFilters)
          ),
          scoreThreshold: effectiveThreshold,
          limit,
          withGlance,
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

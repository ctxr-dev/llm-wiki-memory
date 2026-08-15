import { loadEngine } from "./engine.mjs";
import { titleForId } from "./leaf-title.mjs";
import { locationOf } from "./nav-labels.mjs";
import { buildSnippet } from "./snippet.mjs";

const SNIPPET = 240;
const ANSWER = 1500;

/**
 * @param {{ documentId: string, documentName: string, datasetId: string, score: number, content?: string, active?: boolean, priority?: string }} record
 * @param {any} core @param {any} identity @param {string} query
 */
function toResult(record, core, identity, query) {
  const title = titleForId(core, identity, record.documentId, record.documentName);
  return {
    id: record.documentId,
    name: record.documentName,
    title,
    location: locationOf(record.documentId),
    category: record.datasetId,
    score: record.score,
    snippet: buildSnippet(record.content ?? "", query, title, SNIPPET),
    active: record.active !== false,
    priority: record.priority,
  };
}

/** @param {Record<string, unknown> | undefined} filters @returns {boolean} */
function hasFilters(filters) {
  return Boolean(filters && Object.values(filters).some((value) => value != null && value !== ""));
}

/**
 * @param {string} root @param {string} query
 * @param {{ limit?: number, filters?: Record<string, unknown>, category?: string, includeArchived?: boolean }} [opts]
 * Returns the results AND, when the cold-embed bound cut the read short, the advisory describing
 * what was left out. searchOneTree already accepts a ledger; this end simply owns one so the
 * shortfall can be read off it afterwards, exactly as recall-search.mjs does. A caller that owns no
 * ledger cannot report a shortfall, because scoreCandidates then makes a throwaway one internally.
 * @returns {Promise<{ results: import("../shared/contract.mjs").SearchResult[], partial?: import("../../../scripts/lib/cold-budget.mjs").ColdShortfall }>}
 */
export async function searchWiki(
  root,
  query,
  { limit = 15, filters, category, includeArchived = false } = {},
) {
  const trimmed = (query ?? "").trim();
  if (!trimmed && !hasFilters(filters) && !category) return { results: [] };
  const { env, core, identity, search, budget } = await loadEngine();
  return env.withWikiRoot(root, async () => {
    const coldBudget = budget.defaultColdBudget();
    const { records } = await search.searchOneTree({
      coldBudget,
      query: trimmed,
      limit,
      filters,
      datasetId: category,
      includeArchived,
    });
    const results = records.map((record) => toResult(record, core, identity, trimmed));
    if (!trimmed) results.sort((a, b) => a.title.localeCompare(b.title));
    return { results, ...budget.coldPartial(coldBudget) };
  });
}

/**
 * @param {Array<{ id: string, root: string, label: string }>} wikis
 * @param {string} query
 * @param {{ limit?: number, filters?: Record<string, unknown>, category?: string, includeArchived?: boolean }} [opts]
 * Each wiki gets its OWN ledger (searchWiki makes one per call), so the bound is per-wiki rather
 * than split across them. The advisory reported is the WORST case seen, because a user needs to
 * know the merged set is incomplete, not which tree fell short.
 * @returns {Promise<{ results: import("../shared/contract.mjs").SearchResult[], partial?: import("../../../scripts/lib/cold-budget.mjs").ColdShortfall }>}
 */
export async function searchAll(wikis, query, opts = {}) {
  const limit = opts.limit ?? 15;
  const merged = [];
  /** @type {import("../../../scripts/lib/cold-budget.mjs").ColdShortfall | undefined} */
  let worst;
  for (const wiki of wikis) {
    try {
      const { results, partial } = await searchWiki(wiki.root, query, { ...opts, limit });
      for (const hit of results) merged.push({ ...hit, wikiId: wiki.id, wikiLabel: wiki.label });
      if (partial && (!worst || partial.skippedLeaves > worst.skippedLeaves)) worst = partial;
    } catch {
      continue;
    }
  }
  merged.sort((a, b) => b.score - a.score);
  return { results: merged.slice(0, limit), ...(worst ? { partial: worst } : {}) };
}

/**
 * @param {string} root @param {string} query
 * @param {{ includeArchived?: boolean }} [opts]
 * @returns {Promise<import("../shared/contract.mjs").AskResponse>}
 */
export async function ask(root, query, { includeArchived = false } = {}) {
  if (!query || !query.trim()) return { answer: null, sources: [] };
  const { env, core, identity, search } = await loadEngine();
  return env.withWikiRoot(root, async () => {
    const { records } = await search.searchOneTree({ query, limit: 6, includeArchived });
    const sources = records.map((record) => toResult(record, core, identity, query));
    const top = records[0];
    const answer = top
      ? {
          id: top.documentId,
          name: top.documentName,
          title: titleForId(core, identity, top.documentId, top.documentName),
          category: top.datasetId,
          content: (top.content ?? "").slice(0, ANSWER),
          active: top.active !== false,
          priority: top.priority,
        }
      : null;
    return { answer, sources };
  });
}

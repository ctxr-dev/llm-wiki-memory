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
 * @returns {Promise<import("../shared/contract.mjs").SearchResult[]>}
 */
export async function searchWiki(
  root,
  query,
  { limit = 15, filters, category, includeArchived = false } = {},
) {
  const trimmed = (query ?? "").trim();
  if (!trimmed && !hasFilters(filters) && !category) return [];
  const { env, core, identity, search } = await loadEngine();
  return env.withWikiRoot(root, async () => {
    const { records } = await search.searchOneTree({
      query: trimmed,
      limit,
      filters,
      datasetId: category,
      includeArchived,
    });
    const results = records.map((record) => toResult(record, core, identity, trimmed));
    if (!trimmed) results.sort((a, b) => a.title.localeCompare(b.title));
    return results;
  });
}

/**
 * @param {Array<{ id: string, root: string, label: string }>} wikis
 * @param {string} query
 * @param {{ limit?: number, filters?: Record<string, unknown>, category?: string, includeArchived?: boolean }} [opts]
 * @returns {Promise<import("../shared/contract.mjs").SearchResult[]>}
 */
export async function searchAll(wikis, query, opts = {}) {
  const limit = opts.limit ?? 15;
  const merged = [];
  for (const wiki of wikis) {
    try {
      const hits = await searchWiki(wiki.root, query, { ...opts, limit });
      for (const hit of hits) merged.push({ ...hit, wikiId: wiki.id, wikiLabel: wiki.label });
    } catch {
      continue;
    }
  }
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
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

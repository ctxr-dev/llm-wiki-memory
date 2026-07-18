import { loadEngine } from "./engine.mjs";

const SNIPPET = 240;
const ANSWER = 1500;

/** @param {{ documentId: string, documentName: string, datasetId: string, score: number, content?: string }} record */
function toResult(record) {
  return {
    id: record.documentId,
    name: record.documentName,
    category: record.datasetId,
    score: record.score,
    snippet: (record.content ?? "").slice(0, SNIPPET),
  };
}

/**
 * @param {string} root @param {string} query @param {number} [limit]
 * @returns {Promise<import("../shared/contract.mjs").SearchResult[]>}
 */
export async function searchWiki(root, query, limit = 15) {
  if (!query || !query.trim()) return [];
  const { env, search } = await loadEngine();
  return env.withWikiRoot(root, async () => {
    const { records } = await search.searchOneTree({ query, limit });
    return records.map(toResult);
  });
}

/**
 * @param {Array<{ id: string, root: string, label: string }>} wikis
 * @param {string} query @param {number} [limit]
 * @returns {Promise<import("../shared/contract.mjs").SearchResult[]>}
 */
export async function searchAll(wikis, query, limit = 15) {
  const merged = [];
  for (const wiki of wikis) {
    try {
      const hits = await searchWiki(wiki.root, query, limit);
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
 * @returns {Promise<import("../shared/contract.mjs").AskResponse>}
 */
export async function ask(root, query) {
  if (!query || !query.trim()) return { answer: null, sources: [] };
  const { env, search } = await loadEngine();
  return env.withWikiRoot(root, async () => {
    const { records } = await search.searchOneTree({ query, limit: 6 });
    const sources = records.map(toResult);
    const top = records[0];
    const answer = top
      ? {
          id: top.documentId,
          name: top.documentName,
          category: top.datasetId,
          content: (top.content ?? "").slice(0, ANSWER),
        }
      : null;
    return { answer, sources };
  });
}

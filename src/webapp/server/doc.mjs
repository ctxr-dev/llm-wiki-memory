import { loadEngine } from "./engine.mjs";
import { isWithin } from "./paths.mjs";

/**
 * @param {string} root @param {string} docId
 * @returns {Promise<import("../shared/contract.mjs").DocView | null>}
 */
export async function readDoc(root, docId) {
  const { env, search, identity } = await loadEngine();
  return env.withWikiRoot(root, () => {
    if (!isWithin(env.wikiRoot(), identity.toAbs(docId))) return null;
    const leaf = search.readLeafForConsolidate({ documentId: docId });
    if (!leaf) return null;
    return {
      id: docId,
      name: leaf.name,
      category: identity.categoryOfId(docId),
      body: leaf.text,
      frontmatter: leaf.frontmatter,
      memory: leaf.memory,
      active: leaf.active,
    };
  });
}

/**
 * @param {string} root @param {string} docId @param {number} [limit]
 * @returns {Promise<import("../shared/contract.mjs").RelatedEntry[]>}
 */
export async function relatedDocs(root, docId, limit = 10) {
  const { env, core, identity, search } = await loadEngine();
  return env.withWikiRoot(root, async () => {
    const abs = identity.toAbs(docId);
    if (!isWithin(env.wikiRoot(), abs)) return [];
    let queryText;
    try {
      const { data, body } = core.readLeaf(abs);
      queryText = core.embedTextForLeaf(data, body);
    } catch {
      return [];
    }
    const { records } = await search.searchOneTree({
      query: queryText,
      datasetId: identity.categoryOfId(docId),
      limit: limit + 1,
      chunkAware: false,
      scoreThreshold: 0,
    });
    return records
      .filter((record) => record.documentId !== docId)
      .slice(0, limit)
      .map((record) => ({ id: record.documentId, name: record.documentName, score: record.score }));
  });
}

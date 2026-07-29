import { loadEngine } from "./engine.mjs";
import { isWithin } from "./paths.mjs";
import { cardForId } from "./leaf-title.mjs";
import { locationOf } from "./nav-labels.mjs";

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
 * A cold transformer cache would cold-embed the whole category on this request —
 * a synchronous ONNX pass that freezes the event loop — so related skips instead.
 * Lexical embeds are cheap pure JS and may warm on demand.
 * @param {typeof import("../../../scripts/lib/env.mjs")} env
 * @param {typeof import("../../../scripts/lib/embed.mjs")} embed
 * @param {string} category
 * @returns {boolean}
 */
export function categoryCacheIsCold(env, embed, category) {
  if (embed.activeBackend() !== "transformers") return false;
  const cache = embed.loadCache(env.embedCacheFor(env.wikiRoot(), category));
  return Object.keys(cache.entries || {}).length === 0;
}

/**
 * @param {string} root @param {string} docId
 * @param {{ limit?: number, includeArchived?: boolean }} [opts]
 * @returns {Promise<import("../shared/contract.mjs").RelatedEntry[]>}
 */
export async function relatedDocs(root, docId, { limit = 10, includeArchived = false } = {}) {
  const { env, core, identity, search, embed } = await loadEngine();
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
    const category = identity.categoryOfId(docId);
    if (categoryCacheIsCold(env, embed, category)) return [];
    const { records } = await search.searchOneTree({
      query: queryText,
      queryKind: "document",
      datasetId: category,
      limit: limit + 1,
      chunkAware: false,
      scoreThreshold: 0,
      includeArchived,
    });
    return records
      .filter((record) => record.documentId !== docId)
      .slice(0, limit)
      .map((record) => {
        const { title, summary } = cardForId(
          core,
          identity,
          record.documentId,
          record.documentName,
        );
        return {
          id: record.documentId,
          name: record.documentName,
          title,
          location: locationOf(record.documentId),
          score: record.score,
          active: record.active !== false,
          summary,
        };
      });
  });
}

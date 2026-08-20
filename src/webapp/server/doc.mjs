import { loadEngine } from "./engine.mjs";
import { isWithin } from "./paths.mjs";
import { cardForId } from "./leaf-title.mjs";
import { locationOf } from "./nav-labels.mjs";
import { lifecycleCandidateIds } from "./plan-lifecycle.mjs";

/**
 * @param {Awaited<ReturnType<typeof loadEngine>>} engine
 * @param {string} docId
 * @returns {import("../shared/contract.mjs").DocView | null}
 */
function leafView({ env, search, identity }, docId) {
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
}

/**
 * @param {Awaited<ReturnType<typeof loadEngine>>} engine
 * @param {string} docId
 * @returns {string[]}
 */
export function lifecycleCandidatesFor({ layout, identity }, docId) {
  const category = identity.categoryOfId(docId);
  if (!layout.categoryHasTopology(category)) return [];
  return lifecycleCandidateIds(docId).filter(
    (candidate) => identity.categoryOfId(candidate) === category,
  );
}

/**
 * A tracker plan moves between lifecycle folders as work progresses, which changes its
 * id and breaks every reference written against the old one. So a MISS on a plan id is
 * retried under the sibling lifecycle folders, and the leaf's REAL id is what comes
 * back. An exact hit returns before any of that runs.
 *
 * The retry matches on leaf NAME under a sibling folder, so it cannot prove the leaf it
 * finds is the document the stale reference meant: a second plan later saved under the
 * same name, or a `-v2` rename that freed the original name, is indistinguishable from
 * a move. A substituted answer therefore carries `requestedId` — present ONLY when the
 * served id differs from the asked-for one — so the caller learns that it was handed a
 * different document instead of being switched silently.
 * @param {string} root @param {string} docId
 * @returns {Promise<import("../shared/contract.mjs").DocView | null>}
 */
export async function readDoc(root, docId) {
  const engine = await loadEngine();
  return engine.env.withWikiRoot(root, () => {
    const exact = leafView(engine, docId);
    if (exact) return exact;
    for (const candidate of lifecycleCandidatesFor(engine, docId)) {
      const hit = leafView(engine, candidate);
      if (hit) return { ...hit, requestedId: docId };
    }
    return null;
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

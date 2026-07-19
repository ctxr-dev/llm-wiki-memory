import { loadEngine } from "./engine.mjs";

const PLAN_STATES = ["pending", "in-progress", "done", "archived"];

/** @param {unknown} value @param {string} fallback @returns {string} */
function str(value, fallback) {
  return typeof value === "string" && value ? value : fallback;
}

/**
 * @param {Array<{ status: string }>} cards
 * @returns {Array<{ key: string, cards: any[] }>}
 */
export function groupPlans(cards) {
  const columns = PLAN_STATES.map((key) => ({ key, cards: /** @type {any[]} */ ([]) }));
  const index = new Map(PLAN_STATES.map((key, i) => [key, i]));
  for (const card of cards) {
    const key = index.has(card.status) ? card.status : "pending";
    columns[/** @type {number} */ (index.get(key))].cards.push(card);
  }
  return columns;
}

/**
 * @param {Array<{ kind: string, lifecycle?: string }>} items
 * @returns {Array<{ key: string, cards: any[] }>}
 */
export function groupIssues(items) {
  const columns = PLAN_STATES.map((key) => ({ key, cards: /** @type {any[]} */ ([]) }));
  const facts = { key: "facts", cards: /** @type {any[]} */ ([]) };
  const index = new Map(PLAN_STATES.map((key, i) => [key, i]));
  for (const item of items) {
    if (item.kind === "plan" && item.lifecycle && index.has(item.lifecycle)) {
      columns[/** @type {number} */ (index.get(item.lifecycle))].cards.push(item);
    } else {
      facts.cards.push(item);
    }
  }
  return [...columns, facts];
}

/**
 * @param {string} root
 * @returns {Promise<import("../shared/contract.mjs").PlansBoard>}
 */
export async function plansBoard(root) {
  const { env, search } = await loadEngine();
  return env.withWikiRoot(root, () => {
    const { documents } = search.listDocuments({ datasetId: "plans" });
    const cards = documents.map((doc) => {
      const leaf = search.readLeafForConsolidate({ documentId: doc.id });
      const frontmatter = /** @type {Record<string, unknown>} */ (leaf?.frontmatter ?? {});
      return {
        id: doc.id,
        name: doc.name,
        title: str(frontmatter.focus, doc.name),
        status: str(frontmatter.status, "pending"),
        progress: str(frontmatter.progress, ""),
        active: doc.enabled,
      };
    });
    return { columns: groupPlans(cards) };
  });
}

/**
 * @param {string} root
 * @returns {Promise<import("../shared/contract.mjs").IssuesBoard>}
 */
export async function issuesBoard(root) {
  const { env, layout, search, topology } = await loadEngine();
  return env.withWikiRoot(root, async () => {
    if (!layout.getCategories().includes("issues") || !layout.categoryHasTopology("issues")) {
      return { hasIssues: false, columns: [] };
    }
    const compiled = await topology.loadTopology(root, { categoryPath: "issues" });
    const { documents } = search.listDocuments({ datasetId: "issues" });
    const items = [];
    for (const doc of documents) {
      const parsed = topology.parsePath(compiled, doc.id);
      if (!parsed) continue;
      const facets = parsed.facets;
      items.push({
        id: doc.id,
        name: doc.name,
        kind: parsed.kind,
        tracker: str(facets.tracker, ""),
        prefix: str(facets.prefix, ""),
        number: String(facets.number ?? ""),
        lifecycle: typeof facets.lifecycle === "string" ? facets.lifecycle : undefined,
        slug: typeof facets.slug === "string" ? facets.slug : undefined,
      });
    }
    return { hasIssues: true, columns: groupIssues(items) };
  });
}

import fs from "node:fs";
import path from "node:path";
import { loadEngine } from "./engine.mjs";
import { relabel, categoryLabel } from "./nav-labels.mjs";

/** @param {{ walkLeaves: (dir: string) => string[] }} core @param {string} absDir @returns {number} */
function countUnder(core, absDir) {
  try {
    return core.walkLeaves(absDir).length;
  } catch {
    return 0;
  }
}

/**
 * @param {import("./app-db.mjs").AppDb} db
 * @param {{ walkLeaves: (dir: string) => string[] }} core
 * @param {string} root @param {string} facetPath @param {string} absDir @returns {number}
 */
function cachedCount(db, core, root, facetPath, absDir) {
  let token;
  try {
    token = String(fs.statSync(absDir).mtimeMs);
  } catch {
    return 0;
  }
  const cached = db.getStat(root, facetPath);
  if (cached && cached.mtimeToken === token) return cached.count;
  const count = countUnder(core, absDir);
  db.setStat(root, facetPath, count, token);
  return count;
}

/** @param {string} categoryAbs @param {string} subPath @returns {string | null} */
function safeChildAbs(categoryAbs, subPath) {
  const target = path.resolve(categoryAbs, subPath);
  if (target !== categoryAbs && !target.startsWith(categoryAbs + path.sep)) return null;
  return target;
}

/**
 * @param {string} root
 * @param {import("./app-db.mjs").AppDb} db
 * @returns {Promise<import("../shared/contract.mjs").NavCategory[]>}
 */
export async function listCategories(root, db) {
  const { env, layout, core, identity } = await loadEngine();
  return env.withWikiRoot(root, () =>
    layout.getCategories().map((category) => ({
      category,
      label: categoryLabel(category),
      facets: layout.getPlacementFacets(category),
      count: cachedCount(db, core, root, category, identity.toAbs(category)),
      hasTopology: layout.categoryHasTopology(category),
      isFull: layout.isFullCategory(category),
    })),
  );
}

/**
 * @param {string} root @param {string} category @param {string} subPath
 * @param {{ showArchived?: boolean }} opts
 * @param {import("./app-db.mjs").AppDb} db
 * @returns {Promise<import("../shared/contract.mjs").NavChildren>}
 */
export async function navChildren(root, category, subPath, { showArchived = false } = {}, db) {
  const { env, layout, core, identity } = await loadEngine();
  return env.withWikiRoot(root, () => {
    const empty = { category, path: subPath, dirs: [], docs: [] };
    if (!layout.getCategories().includes(category)) return empty;
    const categoryAbs = identity.toAbs(category);
    const abs = safeChildAbs(categoryAbs, subPath);
    if (!abs) return empty;
    /** @type {import("../shared/contract.mjs").NavChildren["dirs"]} */
    const dirs = [];
    /** @type {import("../shared/contract.mjs").DocEntry[]} */
    const docs = [];
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return empty;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "index.md") continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        const rel = subPath ? `${category}/${subPath}/${entry.name}` : `${category}/${entry.name}`;
        dirs.push({
          name: entry.name,
          label: relabel(entry.name),
          count: cachedCount(db, core, root, rel, childAbs),
        });
      } else if (entry.name.endsWith(".md")) {
        try {
          const active = core.isActive(core.readLeaf(childAbs).data);
          if (showArchived || active) {
            docs.push({ id: identity.toRel(childAbs), name: entry.name, active });
          }
        } catch {
          continue;
        }
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    docs.sort((a, b) => a.name.localeCompare(b.name));
    return { category, path: subPath, dirs, docs };
  });
}

/**
 * @param {string} root
 * @param {{ category?: string, prefix?: string, showArchived?: boolean }} opts
 * @returns {Promise<import("../shared/contract.mjs").DocEntry[]>}
 */
export async function docsFor(root, { category, prefix, showArchived = false } = {}) {
  const { env, layout, search } = await loadEngine();
  return env.withWikiRoot(root, () => {
    if (category !== undefined && !layout.getCategories().includes(category)) return [];
    const { documents } = search.listDocuments({
      datasetId: category,
      prefix,
      enabled: showArchived ? undefined : true,
    });
    return documents.map((doc) => ({ id: doc.id, name: doc.name, active: doc.enabled }));
  });
}

import fs from "node:fs";
import path from "node:path";
import { loadEngine } from "./engine.mjs";
import { relabel, categoryLabel, isSentinel } from "./nav-labels.mjs";
import { leafTitle, titleForId, summaryFromData } from "./leaf-title.mjs";
import { isWithin } from "./paths.mjs";

const MAX_TITLE_IDS = 500;

/**
 * @param {any} core @param {string} abs
 * @returns {{ data: { focus?: unknown }, active: boolean } | null}
 */
function readActiveLeaf(core, abs) {
  let data;
  try {
    data = core.readLeaf(abs).data;
  } catch {
    return null;
  }
  if (!data || Object.keys(data).length === 0) return null;
  return { data, active: core.isActive(data) };
}

/** @param {any} core @param {string} absDir @returns {number} */
function countUnder(core, absDir) {
  try {
    let active = 0;
    for (const leaf of core.walkLeaves(absDir)) {
      const read = readActiveLeaf(core, leaf);
      if (read && read.active) active += 1;
    }
    return active;
  } catch {
    return 0;
  }
}

/**
 * @param {import("./app-db.mjs").AppDb} db @param {any} core
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
 * @param {any} deps @param {string} root @param {string} category @param {string} subPath
 * @param {boolean} showArchived @param {import("./app-db.mjs").AppDb} db
 */
function computeChildren(deps, root, category, subPath, showArchived, db) {
  const { core, identity } = deps;
  /** @type {import("../shared/contract.mjs").NavChildren["dirs"]} */
  const dirs = [];
  /** @type {import("../shared/contract.mjs").DocEntry[]} */
  const docs = [];
  const abs = safeChildAbs(identity.toAbs(category), subPath);
  if (!abs) return { dirs, docs };
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return { dirs, docs };
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
      const read = readActiveLeaf(core, childAbs);
      if (read && (showArchived || read.active)) {
        docs.push({
          id: identity.toRel(childAbs),
          name: entry.name,
          active: read.active,
          title: leafTitle(read.data, entry.name),
          summary: summaryFromData(read.data),
        });
      }
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  docs.sort((a, b) => a.title.localeCompare(b.title));
  return { dirs, docs };
}

/**
 * @param {string} root @param {import("./app-db.mjs").AppDb} db
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
 * @param {{ showArchived?: boolean }} opts @param {import("./app-db.mjs").AppDb} db
 * @returns {Promise<import("../shared/contract.mjs").NavChildren>}
 */
export async function navChildren(root, category, subPath, { showArchived = false } = {}, db) {
  const deps = await loadEngine();
  return deps.env.withWikiRoot(root, () => {
    if (!deps.layout.getCategories().includes(category)) {
      return { category, path: subPath, dirs: [], docs: [] };
    }
    let currentPath = subPath;
    let result = computeChildren(deps, root, category, currentPath, showArchived, db);
    while (
      result.docs.length === 0 &&
      result.dirs.length === 1 &&
      isSentinel(result.dirs[0].name)
    ) {
      currentPath = currentPath ? `${currentPath}/${result.dirs[0].name}` : result.dirs[0].name;
      result = computeChildren(deps, root, category, currentPath, showArchived, db);
    }
    return { category, path: currentPath, dirs: result.dirs, docs: result.docs };
  });
}

/**
 * @param {string} root
 * @param {{ category?: string, prefix?: string, showArchived?: boolean }} opts
 * @returns {Promise<import("../shared/contract.mjs").DocEntry[]>}
 */
export async function docsFor(root, { category, prefix, showArchived = false } = {}) {
  const { env, layout, core, identity, search } = await loadEngine();
  return env.withWikiRoot(root, () => {
    if (category !== undefined && !layout.getCategories().includes(category)) return [];
    const { documents } = search.listDocuments({
      datasetId: category,
      prefix,
      enabled: showArchived ? undefined : true,
    });
    return documents.map((doc) => ({
      id: doc.id,
      name: doc.name,
      active: doc.enabled,
      title: titleForId(core, identity, doc.id, doc.name),
    }));
  });
}

/**
 * @param {string} root @param {string[]} ids
 * @returns {Promise<Record<string, string>>}
 */
export async function titlesFor(root, ids) {
  const { env, core, identity } = await loadEngine();
  return env.withWikiRoot(root, () => {
    /** @type {Record<string, string>} */
    const titles = {};
    for (const id of ids.slice(0, MAX_TITLE_IDS)) {
      const fallback = id.split("/").pop() ?? id;
      titles[id] = isWithin(env.wikiRoot(), identity.toAbs(id))
        ? titleForId(core, identity, id, fallback)
        : fallback;
    }
    return titles;
  });
}

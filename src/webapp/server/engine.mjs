import fs from "node:fs";
import path from "node:path";
import { describeWiki, hashRoot } from "./wiki-describe.mjs";
import { realpathOr, samePath, samePathKey } from "./paths.mjs";

export async function loadEngine() {
  const [env, embed, context, layout, core, identity, search, store, render, atomic, topology] =
    await Promise.all([
      import("../../../scripts/lib/env.mjs"),
      import("../../../scripts/lib/embed.mjs"),
      import("../../../scripts/lib/wiki-context.mjs"),
      import("../../../scripts/lib/wiki-layout-state.mjs"),
      import("../../../scripts/lib/wiki-core.mjs"),
      import("../../../scripts/lib/wiki-identity.mjs"),
      import("../../../scripts/lib/wiki-search.mjs"),
      import("../../../scripts/lib/wiki-store.mjs"),
      import("../../../scripts/lib/wiki-render.mjs"),
      import("../../../scripts/lib/atomic-write.mjs"),
      import("../../../scripts/lib/topology-runtime.mjs"),
    ]);
  return { env, embed, context, layout, core, identity, search, store, render, atomic, topology };
}

/**
 * @param {string[]} [scopes]
 * @returns {Promise<import("../shared/contract.mjs").Health>}
 */
export async function memoryConfig(scopes = []) {
  const { env, embed, context } = await loadEngine();
  const resolved = context.resolveWikiContext(scopes);
  return context.withWikiContext(resolved, () => ({
    ok: true,
    wikiRoot: env.wikiRoot(),
    embedBackend: embed.activeBackend(),
    defaultProjectModule: env.defaultProjectModule(),
    levels: (context.getActiveWikiContext()?.levels ?? []).map((level) => ({
      root: level.root,
      mountDir: level.mountDir,
      projectModule: level.projectModule,
      ownership: level.ownership,
      depth: level.depth,
    })),
    categories: context.scopedCategories(),
  }));
}

/**
 * @param {import("./app-db.mjs").Place[]} [places]
 * @returns {Promise<import("../shared/contract.mjs").Wiki[]>}
 */
export async function listWikis(places = []) {
  const { env, context, layout } = await loadEngine();
  const resolved = context.resolveWikiContext([]);
  const homeCategories = env.withWikiRoot(resolved.brain.root, () => layout.getCategories());
  const wikis = [describeWiki(resolved.brain, homeCategories, "home")];
  const seen = new Set([samePathKey(resolved.brain.root)]);
  for (const place of places) {
    if (seen.has(samePathKey(place.root))) continue;
    if (!fs.existsSync(path.join(place.root, ".layout", "layout.yaml"))) continue;
    try {
      const categories = env.withWikiRoot(place.root, () => layout.getCategories());
      wikis.push(describeWiki({ ...place, ownership: "repo" }, categories, "added"));
      seen.add(samePathKey(place.root));
    } catch {
      continue;
    }
  }
  return wikis;
}

/**
 * @param {string} folder
 * @returns {Promise<import("../shared/contract.mjs").Wiki | null>}
 */
export async function validateWikiFolder(folder) {
  const { env, context, layout } = await loadEngine();
  if (!folder || !path.isAbsolute(folder)) return null;
  const real = realpathOr(folder);
  const resolved = context.resolveWikiContext([real]);
  const match = resolved.levels.find((level) => samePath(level.mountDir, real));
  if (!match) return null;
  const categories = env.withWikiRoot(match.root, () => layout.getCategories());
  const kind = match.ownership === "wiki" ? "home" : "added";
  return describeWiki(match, categories, kind);
}

/**
 * @param {string} id
 * @param {import("./app-db.mjs").Place[]} [places]
 * @returns {Promise<string | null>}
 */
export async function resolveWikiRoot(id, places = []) {
  const { context } = await loadEngine();
  const resolved = context.resolveWikiContext([]);
  if (hashRoot(resolved.brain.root) === id) return resolved.brain.root;
  const match = places.find((place) => hashRoot(place.root) === id);
  return match ? match.root : null;
}

/**
 * @param {string} id
 * @param {import("./app-db.mjs").Place[]} [places]
 * @returns {Promise<{ root: string, ownership: "wiki" | "repo" } | null>}
 */
export async function resolveWiki(id, places = []) {
  const { context } = await loadEngine();
  const resolved = context.resolveWikiContext([]);
  if (hashRoot(resolved.brain.root) === id) return { root: resolved.brain.root, ownership: "wiki" };
  const match = places.find((place) => hashRoot(place.root) === id);
  return match ? { root: match.root, ownership: "repo" } : null;
}

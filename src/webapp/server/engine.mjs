import fs from "node:fs";
import path from "node:path";
import { describeWiki } from "./wiki-describe.mjs";
import { realpathOr, samePath, samePathKey } from "./paths.mjs";

async function engine() {
  const [env, embed, context, store] = await Promise.all([
    import("../../../scripts/lib/env.mjs"),
    import("../../../scripts/lib/embed.mjs"),
    import("../../../scripts/lib/wiki-context.mjs"),
    import("../../../scripts/lib/wiki-store.mjs"),
  ]);
  return { env, embed, context, store };
}

/**
 * @param {string[]} [scopes]
 * @returns {Promise<import("../shared/contract.mjs").Health>}
 */
export async function memoryConfig(scopes = []) {
  const { env, embed, context } = await engine();
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
  const { env, context, store } = await engine();
  const resolved = context.resolveWikiContext([]);
  const homeCategories = env.withWikiRoot(resolved.brain.root, () => store.getCategories());
  const wikis = [describeWiki(resolved.brain, homeCategories, "home")];
  const seen = new Set([samePathKey(resolved.brain.root)]);
  for (const place of places) {
    if (seen.has(samePathKey(place.root))) continue;
    if (!fs.existsSync(path.join(place.root, ".layout", "layout.yaml"))) continue;
    try {
      const categories = env.withWikiRoot(place.root, () => store.getCategories());
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
  const { env, context, store } = await engine();
  if (!folder || !path.isAbsolute(folder)) return null;
  const real = realpathOr(folder);
  const resolved = context.resolveWikiContext([real]);
  const match = resolved.levels.find((level) => samePath(level.mountDir, real));
  if (!match) return null;
  const categories = env.withWikiRoot(match.root, () => store.getCategories());
  const kind = match.ownership === "wiki" ? "home" : "added";
  return describeWiki(match, categories, kind);
}

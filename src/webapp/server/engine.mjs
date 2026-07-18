async function engine() {
  const [env, embed, context] = await Promise.all([
    import("../../../scripts/lib/env.mjs"),
    import("../../../scripts/lib/embed.mjs"),
    import("../../../scripts/lib/wiki-context.mjs"),
  ]);
  return { env, embed, context };
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

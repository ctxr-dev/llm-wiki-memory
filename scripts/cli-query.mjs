import {
  MEMORY_DIR,
  MEMORY_DATA_DIR,
  wikiRoot,
  embedCachePath,
  defaultProjectModule,
} from "./lib/env.mjs";
import { where } from "./lib/wiki-cli.mjs";
import { out } from "./cli-io.mjs";
import { resolveCliScopes, stripScopesArgs, withScopeContext } from "./cli-scopes.mjs";

/** @param {string[]} [rest] */
export async function handleWhere(rest = []) {
  const scopes = resolveCliScopes(rest);
  const { health } = await import("./lib/llm.mjs");
  const llm = await health().catch((err) => ({
    provider: "unknown",
    available: false,
    reason: err?.message || String(err),
  }));
  return withScopeContext(scopes, () =>
    out({
      memoryDir: MEMORY_DIR,
      dataDir: MEMORY_DATA_DIR,
      wiki: wikiRoot(),
      embedCache: embedCachePath(),
      projectModule: defaultProjectModule(),
      skill: where(),
      llm,
    }),
  );
}

/** @param {string[]} rest */
export async function handleRecall(rest) {
  const scopes = resolveCliScopes(rest);
  const query = stripScopesArgs(rest).join(" ") || "*";
  const { recallLessons } = await import("./lib/recall.mjs");
  return withScopeContext(scopes, async () => out(await recallLessons({ query })));
}

/** @param {string[]} rest */
export async function handleSearch(rest) {
  const scopes = resolveCliScopes(rest);
  const query = stripScopesArgs(rest).join(" ") || "*";
  const { searchMemory } = await import("./lib/recall.mjs");
  return withScopeContext(scopes, async () => out(await searchMemory({ query })));
}

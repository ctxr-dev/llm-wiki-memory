import {
  MEMORY_DIR,
  MEMORY_DATA_DIR,
  wikiRoot,
  embedCachePath,
  defaultProjectModule,
} from "./lib/env.mjs";
import { where } from "./lib/wiki-cli.mjs";
import { out } from "./cli-io.mjs";

export async function handleWhere() {
  const { health } = await import("./lib/llm.mjs");
  const llm = await health().catch((err) => ({
    provider: "unknown",
    available: false,
    reason: err?.message || String(err),
  }));
  return out({
    memoryDir: MEMORY_DIR,
    dataDir: MEMORY_DATA_DIR,
    wiki: wikiRoot(),
    embedCache: embedCachePath(),
    projectModule: defaultProjectModule(),
    skill: where(),
    llm,
  });
}

/** @param {string[]} rest */
export async function handleRecall(rest) {
  const { recallLessons } = await import("./lib/recall.mjs");
  return out(await recallLessons({ query: rest.join(" ") || "*" }));
}

/** @param {string[]} rest */
export async function handleSearch(rest) {
  const { searchMemory } = await import("./lib/recall.mjs");
  return out(await searchMemory({ query: rest.join(" ") || "*" }));
}

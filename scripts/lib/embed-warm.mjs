import path from "node:path";
import { withWikiRoot, embedCacheFor } from "./env.mjs";
import { loadCache, saveCache, getTokenizer, contentHash } from "./embed.mjs";
import { cachedLeafVectors } from "./embed-chunk.mjs";
import { embedChunk } from "./settings.mjs";
import { walkLeaves, readLeaf, embedTextForLeaf, leafMemory } from "./wiki-core.mjs";
import { ensureLayoutLoaded, getCategories, isLeafFull } from "./wiki-layout-state.mjs";
import { toRel } from "./wiki-identity.mjs";

// Gradual, duty-cycled cache warm for a whole wiki. Embeds in SMALL slices with an
// enforced pause after each slice that did real inference, so a cold warm spreads
// its CPU cost thinly instead of saturating every core for minutes; a warm wiki is
// all cache-hits — no inference, no pauses, done in seconds.

// Measured on a 537-leaf brain (bge-large, arm64): slice 4 + batch 8 keeps each
// inference burst ~1-2s and the ONNX arena small; pause 3x caps the duty cycle
// near 25% so a cold warm averages ~1.5 cores instead of saturating the machine.
const SLICE_SIZE = 4;
const EMBED_BATCH = 8;
const PAUSE_FACTOR = 3;
const MIN_PAUSE_MS = 200;
const MAX_PAUSE_MS = 10_000;
// Persist every few embedded slices so concurrent searches reuse warm progress
// instead of re-embedding the category, and a restart resumes where it left off.
const SAVE_EVERY_DIRTY_SLICES = 8;

/** @param {number} ms @returns {Promise<void>} */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {number} sliceMs @returns {number} */
export function pauseAfterSlice(sliceMs) {
  return Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, Math.round(sliceMs * PAUSE_FACTOR)));
}

/**
 * @param {import("./embed.mjs").EmbedCache} cache
 * @param {{ id: string, embedText: string }[]} slice
 * @returns {boolean}
 */
function sliceHasMisses(cache, slice) {
  return slice.some((item) => {
    const entry = cache.entries[item.id];
    return !entry || entry.hash !== contentHash(item.embedText) || !Array.isArray(entry.vector);
  });
}

// Every leaf a search can reach — ARCHIVED INCLUDED. Recall with includeArchived
// scores archived leaves, so leaving them out of the warm left them cold and let a
// single "show archived" request embed hundreds of leaves inline (the request then
// blocks for minutes and the worker saturates its thread cap). The pruner keys
// orphans off file existence, not status, so these entries are never re-collected.
/**
 * @param {string} wikiRootDir
 * @param {string} category
 * @returns {{ id: string, embedText: string, body: string, full: boolean }[]}
 */
function searchableItems(wikiRootDir, category) {
  const items = [];
  for (const leaf of walkLeaves(path.join(wikiRootDir, category))) {
    let data, body;
    try {
      ({ data, body } = readLeaf(leaf));
    } catch {
      continue;
    }
    items.push({
      id: toRel(leaf),
      embedText: embedTextForLeaf(data, body),
      body,
      full: isLeafFull(category, leafMemory(data)),
    });
  }
  return items;
}

/**
 * @param {string} wikiRootDir
 * @param {{ sliceSize?: number, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<{ categories: number, leaves: number, embedded: number, paused: number }>}
 */
export async function warmWikiEmbeddings(wikiRootDir, { sliceSize = SLICE_SIZE, sleep = defaultSleep } = {}) {
  return withWikiRoot(wikiRootDir, async () => {
    ensureLayoutLoaded();
    const { enabled, maxChunks, fullMaxChunks } = embedChunk();
    const tokenizer = enabled ? await getTokenizer() : null;
    const stats = { categories: 0, leaves: 0, embedded: 0, paused: 0 };
    for (const category of getCategories()) {
      const cachePath = embedCacheFor(wikiRootDir, category);
      const cache = loadCache(cachePath);
      const items = searchableItems(wikiRootDir, category);
      stats.categories += 1;
      stats.leaves += items.length;
      let dirtySlices = 0;
      const persist = () => {
        try {
          saveCache(cachePath, cache);
        } catch {
          /* unwritable tree: lazy embed-at-search stays the correctness net */
        }
      };
      for (let i = 0; i < items.length; i += sliceSize) {
        const slice = items.slice(i, i + sliceSize);
        const misses = sliceHasMisses(cache, slice);
        const t0 = Date.now();
        await cachedLeafVectors(cache, slice, {
          tokenizer,
          needChunks: true,
          maxChunks,
          fullMaxChunks,
          batchSize: EMBED_BATCH,
        });
        if (misses) {
          stats.embedded += slice.length;
          stats.paused += 1;
          dirtySlices += 1;
          if (dirtySlices % SAVE_EVERY_DIRTY_SLICES === 0) persist();
          await sleep(pauseAfterSlice(Date.now() - t0));
        }
      }
      if (cache._dirty) persist();
    }
    return stats;
  });
}

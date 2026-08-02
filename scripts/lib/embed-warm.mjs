import fs from "node:fs";
import path from "node:path";
import { withWikiRoot, embedCacheFor, MEMORY_DATA_DIR } from "./env.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { acquireLock, installLockReleaseHandlers } from "./lock.mjs";
import { loadCache, saveCache, getTokenizer, contentHash, embedWindow } from "./embed.mjs";
import { cachedLeafVectors, makeColdBudget } from "./embed-chunk.mjs";
import { embedChunk, embedWarmIntervalMinutes } from "./settings.mjs";
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

const WARM_STATE_PATH = path.join(MEMORY_DATA_DIR, "state", ".embed-warm.json");
const WARM_LOCK_PATH = path.join(MEMORY_DATA_DIR, "state", ".embed-warm.lock");

/** @param {number} ms @returns {Promise<void>} */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {number} sliceMs @returns {number} */
export function pauseAfterSlice(sliceMs) {
  return Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, Math.round(sliceMs * PAUSE_FACTOR)));
}

/**
 * Whether a slice is CERTAINLY all-warm, so `cachedLeafVectors` can be skipped
 * entirely (it would otherwise re-hash every leaf and re-run `chunkTexts` — a full
 * tokenizer encode of every long body — on every pass, for nothing).
 *
 * Conservative by construction: it must never report warm for a leaf that still
 * needs work. A leaf counts as warm when its whole-leaf vector is current AND
 * either it already carries a chunk set, or its embed text is short enough that a
 * chunk set is impossible (token count <= byte count, so <= window bytes means
 * <= window tokens). A leaf between those bounds — big enough to fail the byte
 * test, small enough not to actually need chunks — is reported NOT warm and
 * re-tokenised each pass; that costs a tokenizer encode, never a forward pass,
 * because the pacing decision below is made from what was really embedded.
 * @param {import("./embed.mjs").EmbedCache} cache
 * @param {{ id: string, embedText: string }[]} slice
 * @param {number} window
 * @returns {boolean}
 */
export function sliceIsWarm(cache, slice, window) {
  return slice.every((item) => {
    const entry = cache.entries[item.id];
    if (!entry || entry.hash !== contentHash(item.embedText) || !Array.isArray(entry.vector)) {
      return false;
    }
    return Array.isArray(entry.chunks) || Buffer.byteLength(item.embedText, "utf8") <= window;
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
export async function warmWikiEmbeddings(
  wikiRootDir,
  { sliceSize = SLICE_SIZE, sleep = defaultSleep } = {},
) {
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
      const window = embedWindow();
      for (let i = 0; i < items.length; i += sliceSize) {
        const slice = items.slice(i, i + sliceSize);
        if (sliceIsWarm(cache, slice, window)) continue;
        // An UNBOUNDED ledger used purely as a counter: `spent` is the number of
        // texts this slice really put through the model. Deciding the pause from
        // that (rather than from a guess made before the call) is what fixes the
        // pacing bug — the old pre-check only looked at whole-leaf vectors, so a
        // leaf that still needed its CHUNK set reported "no miss" and the whole
        // duty cycle plus the periodic checkpoint were skipped for the single
        // largest inference burst in the system.
        const ledger = makeColdBudget(Infinity);
        const t0 = Date.now();
        await cachedLeafVectors(cache, slice, {
          tokenizer,
          needChunks: true,
          maxChunks,
          fullMaxChunks,
          batchSize: EMBED_BATCH,
          budget: ledger,
        });
        if (ledger.spent > 0) {
          stats.embedded += ledger.spent;
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

// The due-stamp is KEYED BY WIKI ROOT, not a single flat timestamp: the webapp
// warms whichever wiki it is serving while the cron warms the brain, and a flat
// stamp would let either starve the other forever. Best-effort — a missing or
// corrupt file reads as "never warmed", so the next due-check proceeds.
/** @returns {Record<string, string>} */
function readWarmState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(WARM_STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, string>} state @returns {void} */
function writeWarmState(state) {
  try {
    fs.mkdirSync(path.dirname(WARM_STATE_PATH), { recursive: true });
    writeFileAtomic(WARM_STATE_PATH, JSON.stringify(state));
  } catch {
    /* best effort: a missed stamp only costs an extra warm, never correctness */
  }
}

/**
 * Throttled warm for a scheduler (the hourly cron, the webapp's interval timer,
 * `cli.mjs warm --if-due`). Runs only when `embed.warmIntervalMinutes` have
 * elapsed for THIS wiki root, and holds a cross-process lock so two schedulers
 * cannot warm the same wiki at once — concurrent warms would compete for the same
 * inference threads and fight over the same cache file.
 * @param {string} wikiRootDir
 * @param {{ sliceSize?: number, sleep?: (ms: number) => Promise<void>, now?: number }} [opts]
 * @returns {Promise<{ ok: true, skipped: "disabled" | "not-due" | "locked", [k: string]: unknown } | { ok: true, skipped?: undefined, categories: number, leaves: number, embedded: number, paused: number }>}
 */
export async function warmWikiEmbeddingsIfDue(wikiRootDir, opts = {}) {
  const intervalMinutes = embedWarmIntervalMinutes();
  if (intervalMinutes <= 0) {
    return { ok: true, skipped: "disabled", reason: "settings.embed.warmIntervalMinutes is 0" };
  }
  const now = opts.now ?? Date.now();
  const state = readWarmState();
  const lastMs = state[wikiRootDir] ? Date.parse(state[wikiRootDir]) : NaN;
  if (Number.isFinite(lastMs)) {
    const dueMs = lastMs + intervalMinutes * 60_000;
    if (now < dueMs) {
      return {
        ok: true,
        skipped: "not-due",
        intervalMinutes,
        last_run_utc: state[wikiRootDir],
        next_due_utc: new Date(dueMs).toISOString(),
      };
    }
  }
  fs.mkdirSync(path.dirname(WARM_LOCK_PATH), { recursive: true });
  installLockReleaseHandlers(WARM_LOCK_PATH);
  const lock = acquireLock(WARM_LOCK_PATH, { label: "embed-warm" });
  if (!lock.ok) return { ok: true, skipped: "locked", reason: lock.reason };
  const release = /** @type {() => void} */ (lock.release);
  try {
    const stats = await warmWikiEmbeddings(wikiRootDir, opts);
    // Stamp AFTER the run so a long warm doesn't immediately look due again, and
    // stamp even on a no-op pass so an all-warm wiki isn't rechecked every tick.
    writeWarmState({ ...readWarmState(), [wikiRootDir]: new Date().toISOString() });
    return { ok: true, ...stats };
  } finally {
    release();
  }
}

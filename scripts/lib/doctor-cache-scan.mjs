import fs from "node:fs";
import path from "node:path";
import { wikiRoot } from "./env.mjs";
import { embedBackend } from "./settings.mjs";
import {
  isHidden,
  rel,
  curatedCategories,
  indexFilesUnder,
  leavesUnder,
  refsFromIndex,
} from "./doctor-scan.mjs";

/** @typedef {{ cache: string, backend: string, expected: string, dim: number, entries: number }} CacheMismatchEntry */
/** @typedef {{ cache: string, stampDim: number, dims: string, entries: number }} CacheDimEntry */
/** @typedef {{ orphan: string }} OrphanEntry */

// The two doctor scans that look at DERIVED state rather than the index graph:
// a per-category embedding cache stamped with the wrong backend, and a curated
// leaf no index.md anywhere references.

// Every category cache, parsed ONCE. Both scans below run over the same objects: each doing
// its own readdir + read + JSON.parse made `doctor` 27.5% slower (+33.5ms on a 20MB corpus,
// scaling at ~1.65ms/MB) for no extra information.
/**
 * @param {string} wiki
 * @returns {Array<{ cachePath: string, stamp: any }>}
 */
export function readCacheStamps(wiki = wikiRoot()) {
  /** @type {Array<{ cachePath: string, stamp: any }>} */
  const out = [];
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(wiki, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of dirEntries) {
    if (!e.isDirectory() || isHidden(e.name)) continue;
    const cachePath = path.join(wiki, e.name, ".embeddings", "embeddings.json");
    try {
      out.push({ cachePath, stamp: JSON.parse(fs.readFileSync(cachePath, "utf8")) });
    } catch {
      continue;
    }
  }
  return out;
}

// loadCache silently rejects a backend-mismatched cache and cold-re-embeds the
// whole category on the next search; this surfaces that corruption first.
// Backend only: a model swap transiently mismatches every cache mid-migration,
// so flagging model/dim here would cry wolf.
/**
 * @param {string} [wiki]
 * @returns {CacheMismatchEntry[]}
 */
export function findBackendMismatchedCaches(wiki = wikiRoot(), stamps = readCacheStamps(wiki)) {
  const configured = (embedBackend() || "").toLowerCase();
  if (!configured) return [];
  /** @type {CacheMismatchEntry[]} */
  const found = [];
  for (const { cachePath, stamp } of stamps) {
    const backend = String(stamp?.backend || "").toLowerCase();
    if (!backend || backend === configured) continue;
    const entryCount =
      stamp.entries && typeof stamp.entries === "object" ? Object.keys(stamp.entries).length : 0;
    found.push({
      cache: rel(wiki, cachePath),
      backend: stamp.backend,
      expected: configured,
      dim: typeof stamp.dim === "number" ? stamp.dim : 0,
      entries: entryCount,
    });
  }
  return found;
}

export function findOrphanLeaves(wiki = wikiRoot()) {
  /** @type {Set<string>} */
  const referenced = new Set();
  for (const cat of curatedCategories()) {
    for (const idx of indexFilesUnder(path.join(wiki, cat))) {
      const dir = path.dirname(idx);
      let raw;
      try {
        raw = fs.readFileSync(idx, "utf8");
      } catch {
        continue;
      }
      for (const r of refsFromIndex(raw)) {
        if (/^https?:|^obsidian:/.test(r)) continue;
        referenced.add(path.resolve(dir, r));
      }
    }
  }
  /** @type {OrphanEntry[]} */
  const found = [];
  for (const cat of curatedCategories()) {
    for (const leaf of leavesUnder(path.join(wiki, cat))) {
      if (!referenced.has(path.resolve(leaf))) found.push({ orphan: rel(wiki, leaf) });
    }
  }
  return found;
}

// A cache whose own vectors disagree with each other. INTERNAL inconsistency only — this
// deliberately does NOT compare against the configured model's dimension, which is
// unknowable without a forward pass and would cry wolf mid-migration exactly as the backend
// scan's comment explains.
//
// Worth surfacing because the failure is otherwise invisible: `cosine` returns 0 for a
// length mismatch and `scoreLeaf` goes NEGATIVE over a mismatched chunk set, so the affected
// leaves silently stop appearing in results, while the content-hash checks in `sliceIsWarm`
// and `cachedLeafVectors` call them warm and never re-embed. loadCache/saveCache now repair
// this, so a finding here means a cache no live process has SAVED since the fix — loadCache
// repairs only its in-memory copy, so the file itself changes on the next write.
/**
 * @param {string} [wiki]
 * @returns {CacheDimEntry[]}
 */
export function findDimInconsistentCaches(wiki = wikiRoot(), stamps = readCacheStamps(wiki)) {
  /** @type {CacheDimEntry[]} */
  const found = [];
  for (const { cachePath, stamp } of stamps) {
    const entries = stamp?.entries && typeof stamp.entries === "object" ? stamp.entries : null;
    if (!entries) continue;
    // Mirrors dominantDim: whole-leaf vectors define the dimension, chunk vectors are checked
    // against it. Reporting a shape the repairer cannot fix (a cache with no whole-leaf vector
    // at all) would be a permanent finding with no remediation.
    /** @type {Map<number, number>} */
    const counts = new Map();
    /** @type {Set<number>} */
    const chunkDims = new Set();
    for (const entry of Object.values(entries)) {
      if (Array.isArray(entry?.vector)) {
        counts.set(entry.vector.length, (counts.get(entry.vector.length) || 0) + 1);
      }
      for (const c of entry?.chunks || []) {
        chunkDims.add(Array.isArray(c?.vector) ? c.vector.length : -1);
      }
    }
    if (counts.size === 0) continue;
    const leafDim = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    if (counts.size <= 1 && ![...chunkDims].some((d) => d !== leafDim)) continue;
    found.push({
      cache: rel(wiki, cachePath),
      stampDim: typeof stamp.dim === "number" ? stamp.dim : 0,
      dims: [...counts]
        .sort((a, b) => b[1] - a[1])
        .map(([d, n]) => `${n}x${d}`)
        .join(" "),
      entries: Object.keys(entries).length,
    });
  }
  return found;
}

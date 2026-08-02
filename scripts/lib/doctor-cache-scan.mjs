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
/** @typedef {{ orphan: string }} OrphanEntry */

// The two doctor scans that look at DERIVED state rather than the index graph:
// a per-category embedding cache stamped with the wrong backend, and a curated
// leaf no index.md anywhere references.

// loadCache silently rejects a backend-mismatched cache and cold-re-embeds the
// whole category on the next search; this surfaces that corruption first.
// Backend only: a model swap transiently mismatches every cache mid-migration,
// so flagging model/dim here would cry wolf.
/**
 * @param {string} [wiki]
 * @returns {CacheMismatchEntry[]}
 */
export function findBackendMismatchedCaches(wiki = wikiRoot()) {
  const configured = (embedBackend() || "").toLowerCase();
  if (!configured) return [];
  /** @type {CacheMismatchEntry[]} */
  const found = [];
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(wiki, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of dirEntries) {
    if (!e.isDirectory() || isHidden(e.name)) continue;
    const cachePath = path.join(wiki, e.name, ".embeddings", "embeddings.json");
    let stamp;
    try {
      stamp = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
      continue;
    }
    const backend = String(stamp?.backend || "").toLowerCase();
    if (backend && backend !== configured) {
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
  }
  return found;
}

// A curated leaf that no index.md anywhere references (the inverse of a broken ref).
/**
 * @param {string} [wiki]
 * @returns {OrphanEntry[]}
 */
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

import fs from "node:fs";
import path from "node:path";
import { priorityForAtomType, normalisePriority, priorityRank } from "./datasets.mjs";
import { embedCacheFor } from "./env.mjs";
import { recallPriorityBand } from "./settings.mjs";
import { loadCache, saveCache, cachedEmbeddings, embed, cosine } from "./embed.mjs";
import {
  WikiStoreUnavailable,
  root,
  readLeaf,
  leafMemory,
  isActive,
  walkLeaves,
  embedTextForLeaf,
} from "./wiki-core.mjs";
import { toRel, toAbs } from "./wiki-identity.mjs";
import { ensureLayoutLoaded, slotToCategory, getCategories } from "./wiki-layout-state.mjs";
import { scopedCategories } from "./wiki-context.mjs";
import { glanceFields } from "./wiki-render.mjs";

/** @typedef {import("./types.mjs").MemoryMetadata} MemoryMetadata */
/** @typedef {Record<string, unknown>} SearchFilters */

/**
 * @param {{ prefix?: string, enabled?: string | boolean, datasetId?: string }} [opts]
 */
export function listDocuments({ prefix, enabled, datasetId } = {}) {
  const cats = datasetId ? [slotToCategory(datasetId)] : getCategories();
  const documents = [];
  for (const cat of cats) {
    const catAbs = path.join(root(), cat);
    for (const leaf of walkLeaves(catAbs)) {
      const name = path.basename(leaf);
      if (prefix && !name.startsWith(prefix)) continue;
      let data;
      try {
        ({ data } = readLeaf(leaf));
      } catch (err) {
        // Resilient to an unreadable leaf (invalid YAML frontmatter / git conflict
        // in a shared leaf) — skip it, don't abort the whole listing.
        console.error(
          `[list] skipping unreadable leaf ${toRel(leaf)}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const active = isActive(data);
      if (enabled === "true" || enabled === true) {
        if (!active) continue;
      } else if (enabled === "false" || enabled === false) {
        if (active) continue;
      }
      documents.push({ id: toRel(leaf), name, datasetId: cat, enabled: active });
    }
  }
  return { documents };
}

/**
 * @param {{ documentId?: string, datasetId?: string }} [opts]
 */
export function readDocument({ documentId, datasetId: _datasetId } = {}) {
  const abs = toAbs(documentId);
  if (!fs.existsSync(abs)) throw new WikiStoreUnavailable(`leaf not found: ${documentId}`);
  const { data, body } = readLeaf(abs);
  return { text: body, metadata: leafMemory(data), name: path.basename(abs), documentId };
}

// Richer read used by the consolidate orchestrator. Surfaces the full
// frontmatter (top-level `updated`, `parents`, `source.hash`, plus the
// nested `memory` block), which `readDocument` deliberately keeps minimal.
// Returns null if the leaf is missing — callers iterate over a stable list,
// so a vanished leaf is a benign race we want to skip, not throw on.
/**
 * @param {{ documentId?: string }} [opts]
 */
export function readLeafForConsolidate({ documentId } = {}) {
  const abs = toAbs(documentId);
  if (!fs.existsSync(abs)) return null;
  const { data, body } = readLeaf(abs);
  return {
    documentId,
    name: path.basename(abs),
    text: body,
    frontmatter: data,
    memory: leafMemory(data),
    active: isActive(data),
  };
}

// List active leaves in a category. Thin convenience around `listDocuments` +
// `readLeafForConsolidate`, used by the consolidate orchestrator's working
// set + corpus-scoped passes. Skips leaves that vanish mid-walk.
/**
 * @param {{ category?: string }} [opts]
 */
export function listActiveLeavesForConsolidate({ category } = {}) {
  if (!category) return [];
  const { documents } = listDocuments({ datasetId: category, enabled: true });
  const out = [];
  for (const d of documents) {
    const leaf = readLeafForConsolidate({ documentId: d.id });
    if (leaf && leaf.active) out.push(leaf);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} memoryMeta
 * @param {SearchFilters | null | undefined} filters
 * @returns {boolean}
 */
function metaMatchesFilters(memoryMeta, filters) {
  if (!filters) return true;
  for (const [key, val] of Object.entries(filters)) {
    if (val == null || val === "") continue;
    // `subject` is stored as a slug ARRAY; `tags` as a comma string. Both are
    // membership filters (every wanted value must be present), not exact match.
    if (key === "tags" || key === "subject") {
      const raw = memoryMeta[key];
      const haveList = (Array.isArray(raw) ? raw : String(raw || "").split(","))
        .map((t) => String(t).trim().toLowerCase())
        .filter(Boolean);
      const wantList = (Array.isArray(val) ? val : String(val).split(","))
        .map((t) => String(t).trim().toLowerCase())
        .filter(Boolean);
      if (!wantList.every((wt) => haveList.includes(wt))) return false;
      continue;
    }
    if (key === "project_module") {
      const chain = String(memoryMeta[key] || "").toLowerCase();
      const want = String(val).toLowerCase();
      if (chain !== want && !chain.endsWith(`//${want}`)) return false;
      continue;
    }
    const have = String(memoryMeta[key] || "").toLowerCase();
    const want = String(val).toLowerCase();
    if (have !== want) return false;
  }
  return true;
}

// Stable within-band priority tie-break over a cosine-descending list. Cosine
// stays dominant: a hit more than `band` below its group leader keeps its rank;
// only hits within `band` reorder P0 > P1 > P2 (stable sort keeps cosine order
// for equal priority). band <= 0 disables it. `scoreOf` selects the metric the
// band walks (default cosine `score`; fan-out passes adjustedConfidence).
/**
 * @template {{ score: number, priority: string }} T
 * @param {T[]} sortedDesc
 * @param {number} band
 * @param {(r: T) => number} [scoreOf]
 * @returns {T[]}
 */
export function rerankWithinBands(sortedDesc, band, scoreOf = (r) => r.score) {
  if (!(band > 0) || sortedDesc.length < 2) return sortedDesc;
  /** @type {T[]} */
  const out = [];
  let i = 0;
  while (i < sortedDesc.length) {
    const lead = scoreOf(sortedDesc[i]);
    let j = i + 1;
    while (j < sortedDesc.length && lead - scoreOf(sortedDesc[j]) <= band) j += 1;
    const group = sortedDesc.slice(i, j);
    group.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
    out.push(...group);
    i = j;
  }
  return out;
}

// Rank a query against ONE wiki tree (the current `wikiRoot()`): filter by
// frontmatter metadata, embed, score by cosine, priority-band rerank, slice to
// `limit`. This is the single-tree scorer; the federated fan-out
// (wiki-search-fanout.mjs → the public `searchMemoryFiltered`) runs it once per
// level inside a `withWikiRoot` frame and merges the results.
/**
 * @param {{ query?: string, datasetId?: string, limit?: number, filters?: SearchFilters, scoreThreshold?: number, withGlance?: boolean }} [opts]
 */
export async function searchOneTree({
  query,
  datasetId,
  limit = 5,
  filters,
  scoreThreshold,
  withGlance = false,
} = {}) {
  ensureLayoutLoaded();
  const cats = datasetId
    ? [slotToCategory(datasetId)]
    : getCategories().filter((c) => c !== "daily");
  const candidates = [];
  for (const cat of cats) {
    const catAbs = path.join(root(), cat);
    for (const leaf of walkLeaves(catAbs)) {
      let data, body;
      try {
        ({ data, body } = readLeaf(leaf));
      } catch (err) {
        // An unreadable leaf (invalid YAML — e.g. a git merge conflict in a shared
        // repo leaf) must NOT abort the search and blank recall. Skip with a breadcrumb.
        console.error(
          `[search] skipping unreadable leaf ${toRel(leaf)}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (!isActive(data)) continue;
      const mem = leafMemory(data);
      if (!metaMatchesFilters(mem, filters)) continue;
      candidates.push({
        id: toRel(leaf),
        text: body,
        embedText: embedTextForLeaf(data, body),
        documentName: path.basename(leaf),
        datasetId: cat,
        // Lazy-default legacy leaves that predate the priority field by the
        // deterministic rubric (never P0), so ranking has a value without a write.
        priority: normalisePriority(mem.priority) || priorityForAtomType(mem.atom_type),
        // Kept only to build the opt-in glance view; never emitted directly.
        data: withGlance ? data : undefined,
        mem: withGlance ? mem : undefined,
      });
    }
  }
  if (candidates.length === 0) return { records: [] };

  // Embed the query FIRST so the backend is resolved before any cache load
  // (loadCache stamps against the resolved backend + dim, dropping a stale or
  // cross-backend category cache instead of scoring it as all-zero).
  const queryVec = await embed(String(query || ""));
  const wiki = root();
  /** @type {Map<string, import("./embed.mjs").EmbedCache>} */
  const cacheByCat = new Map();
  /** @param {string} cat @returns {import("./embed.mjs").EmbedCache} */
  const cacheFor = (cat) => {
    let c = cacheByCat.get(cat);
    if (!c) {
      c = loadCache(embedCacheFor(wiki, cat), queryVec.length);
      cacheByCat.set(cat, c);
    }
    return c;
  };
  // Batch cold-cache misses per category (one embedMany pass, not a serial call
  // per candidate); score in candidate order so the priority tie-break holds.
  /** @type {Map<string, { id: string, text: string }[]>} */
  const itemsByCat = new Map();
  for (const c of candidates) {
    const arr = itemsByCat.get(c.datasetId);
    if (arr) arr.push({ id: c.id, text: c.embedText });
    else itemsByCat.set(c.datasetId, [{ id: c.id, text: c.embedText }]);
  }
  /** @type {Map<string, number[]>} */
  const vecById = new Map();
  for (const [cat, items] of itemsByCat) {
    const vecs = await cachedEmbeddings(cacheFor(cat), items);
    items.forEach((it, i) => vecById.set(`${cat}\0${it.id}`, vecs[i]));
  }
  const scored = candidates.map((c) => ({
    ...c,
    score: cosine(queryVec, vecById.get(`${c.datasetId}\0${c.id}`) ?? []),
  }));
  for (const [cat, cache] of cacheByCat) {
    // Best-effort persist: vectors are already scored in-memory, so this is only a
    // latency optimization — a READ-ONLY shared tree must not make search throw.
    try {
      saveCache(embedCacheFor(wiki, cat), cache);
    } catch (err) {
      console.error(
        `[search] embed-cache persist skipped for ${cat} (unwritable tree?): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // Relevance gates (cosine + scoreThreshold); priority only breaks near-ties,
  // applied BEFORE the limit so a within-band P0 can make the cut over a P2.
  const eligible = scored.filter((r) => scoreThreshold == null || r.score >= scoreThreshold);
  const ranked = rerankWithinBands(eligible, recallPriorityBand());
  const records = ranked.slice(0, limit).map((r) => {
    const base = {
      datasetId: r.datasetId,
      documentId: r.id,
      documentName: r.documentName,
      score: r.score,
      priority: r.priority,
      content: r.text,
    };
    return withGlance ? { ...base, ...glanceFields(r.data, r.mem, r.text) } : base;
  });

  return { records };
}

export function listDatasets() {
  // Union across the scope chain — advertises a shared repo's brain-absent category.
  const cats = scopedCategories();
  return {
    datasets: cats.map((name) => ({ name, id: name })),
    declaredLocally: cats.map((name) => ({ name, configuredId: name })),
  };
}

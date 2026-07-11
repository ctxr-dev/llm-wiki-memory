import fs from "node:fs";
import path from "node:path";
import { priorityForAtomType, normalisePriority, priorityRank } from "./datasets.mjs";
import { embedCachePath } from "./env.mjs";
import { recallPriorityBand } from "./settings.mjs";
import { loadCache, saveCache, cachedEmbedding, embed, cosine } from "./embed.mjs";
import {
  WikiStoreUnavailable,
  root,
  readLeaf,
  leafMemory,
  isActive,
  walkLeaves,
} from "./wiki-core.mjs";
import { toRel, toAbs } from "./wiki-identity.mjs";
import { ensureLayoutLoaded, slotToCategory, getCategories } from "./wiki-layout-state.mjs";
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
      const { data } = readLeaf(leaf);
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
    const have = String(memoryMeta[key] || "").toLowerCase();
    const want = String(val).toLowerCase();
    if (have !== want) return false;
  }
  return true;
}

// Filter leaves by frontmatter metadata, then rank by embedding similarity.
// Stable within-band priority tie-break over a cosine-descending list. Cosine
// stays dominant: a hit more than `band` below its group leader keeps its rank;
// only hits within `band` of each other are reordered P0 > P1 > P2 (Array.sort
// is stable, so equal-priority ties keep cosine order). band <= 0 disables it.
/**
 * @template {{ score: number, priority: string }} T
 * @param {T[]} sortedDesc
 * @param {number} band
 * @returns {T[]}
 */
export function rerankWithinBands(sortedDesc, band) {
  if (!(band > 0) || sortedDesc.length < 2) return sortedDesc;
  /** @type {T[]} */
  const out = [];
  let i = 0;
  while (i < sortedDesc.length) {
    const lead = sortedDesc[i].score;
    let j = i + 1;
    while (j < sortedDesc.length && lead - sortedDesc[j].score <= band) j += 1;
    const group = sortedDesc.slice(i, j);
    group.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
    out.push(...group);
    i = j;
  }
  return out;
}

/**
 * @param {{ query?: string, datasetId?: string, limit?: number, filters?: SearchFilters, scoreThreshold?: number, withGlance?: boolean }} [opts]
 */
export async function searchMemoryFiltered({
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
      const { data, body } = readLeaf(leaf);
      if (!isActive(data)) continue;
      const mem = leafMemory(data);
      if (!metaMatchesFilters(mem, filters)) continue;
      candidates.push({
        id: toRel(leaf),
        text: body,
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

  const cache = loadCache(embedCachePath());
  const queryVec = await embed(String(query || ""));
  const scored = [];
  for (const c of candidates) {
    const vec = await cachedEmbedding(cache, c.id, c.text);
    scored.push({ ...c, score: cosine(queryVec, vec) });
  }
  saveCache(embedCachePath(), cache);
  scored.sort((a, b) => b.score - a.score);

  // Relevance is the gate (cosine sort + scoreThreshold). Priority is a
  // within-band tie-break only: among near-equally-relevant hits a P0/P1 orders
  // above a P2, but a clearly-more-relevant hit keeps its rank. Applied BEFORE
  // the limit so a within-band P0 can make the cut over a tied P2.
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
  ensureLayoutLoaded();
  const cats = getCategories();
  return {
    datasets: cats.map((name) => ({ name, id: name })),
    declaredLocally: cats.map((name) => ({ name, configuredId: name })),
  };
}

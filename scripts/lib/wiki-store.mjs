import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { wikiRoot, embedCachePath, defaultProjectModule } from "./env.mjs";
import { ensureIndexes } from "./wiki-cli.mjs";
import {
  contentHash,
  loadCache,
  saveCache,
  cachedEmbedding,
  removeFromCache,
  embed,
  cosine,
} from "./embed.mjs";
import { slugify, dailyDatePath } from "./slug.mjs";

// Drop-in replacement for the boilerplate's dify-write.mjs. Same exported
// function names/shapes, but every document is a leaf in the local hosted
// wiki and retrieval is local embeddings. Downstream code (flush, compile,
// exit-plan-mode, the MCP server) calls only these functions.

// Kept name-compatible with the boilerplate so adapted call sites that used
// `DifyBridgeUnavailable` still resolve to a real class.
export class WikiStoreUnavailable extends Error {}
export const DifyBridgeUnavailable = WikiStoreUnavailable;

export const CATEGORIES = ["knowledge", "self_improvement", "plans", "investigations", "daily"];

export function slotToCategory(slot) {
  const s = String(slot || "").trim();
  if (CATEGORIES.includes(s)) return s;
  // Tolerate a few aliases / raw category dirs.
  if (s === "lessons") return "self_improvement";
  if (s === "knowledge_base") return "knowledge";
  return s || "knowledge";
}

function root() {
  return wikiRoot();
}

function toRel(absPath) {
  return path.relative(root(), absPath).split(path.sep).join("/");
}

function toAbs(relOrId) {
  return path.join(root(), String(relOrId).split("/").join(path.sep));
}

function readLeaf(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  const parsed = matter(raw);
  return { data: parsed.data || {}, body: parsed.content || "" };
}

function leafMemory(data) {
  return (data && typeof data.memory === "object" && data.memory) || {};
}

function isActive(data) {
  const status = leafMemory(data).status;
  return status !== "archived";
}

// Pull a human title from explicit metadata, a leading `# heading`, or the name.
function deriveTitle({ metadata, text, name }) {
  if (metadata && metadata.title) return String(metadata.title).trim();
  const h1 = String(text || "").match(/^#\s+(.+?)\s*$/m);
  if (h1) return h1[1].trim();
  return String(name || "untitled").replace(/\.md$/, "").replace(/[-_]/g, " ").slice(0, 80);
}

function oneLine(s, max = 160) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Build the >=3-bullet covers[] the validator requires on leaves. Covers are
// mined from the actual content (title, the structured Why:/How to apply: lines
// the capture prompt encourages, a representative body sentence, and tags) rather
// than boilerplate, so they carry real signal for shared_covers + browsing.
function buildCovers({ title, tags, atomType, body }) {
  const out = [];
  if (title) out.push(oneLine(title, 120));
  const text = String(body || "");
  const why = text.match(/^\s*(?:[-*]\s*)?why\s*:\s*(.+)$/im);
  if (why) out.push(oneLine(`why: ${why[1]}`, 140));
  const how = text.match(/^\s*(?:[-*]\s*)?how\s*to\s*apply\s*:\s*(.+)$/im);
  if (how) out.push(oneLine(`how to apply: ${how[1]}`, 140));
  // First prose sentence that is not a heading or a "- key: value" metadata line.
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^[-*]\s*\w[\w-]*\s*:/.test(line)) continue;
    if (/^(why|how to apply)\s*:/i.test(line)) continue;
    out.push(oneLine(line, 140));
    break;
  }
  for (const t of tags || []) out.push(oneLine(`covers ${t}`, 60));
  const seen = new Set();
  const deduped = out.filter((c) => c && !seen.has(c) && seen.add(c));
  // Floor: the validator requires >= 3 covers. Pad with deterministic, unique fillers.
  while (deduped.length < 3) {
    deduped.push(oneLine(`recall context for ${atomType || "memory"} (${deduped.length + 1})`, 80));
  }
  return deduped.slice(0, 15);
}

// gray-matter serialises frontmatter via js-yaml, whose default lineWidth (80)
// folds long scalars into block scalars (`>-`). skill-llm-wiki's index/validate
// parser reads frontmatter line-by-line; folded scalars made it drop the doc
// from its index. lineWidth -1 disables wrapping so scalars stay single-line.
function stringifyLeaf(body, data) {
  return matter.stringify(`\n${body.trim()}\n`, data, { lineWidth: -1 });
}

// Compose the on-disk leaf (schema-valid frontmatter + body). `memory` carries
// our filterable metadata; the rest satisfies skill-llm-wiki's leaf schema.
function renderLeaf({ id, title, tags, body, memoryMeta }) {
  const frontmatter = {
    id,
    type: "primary",
    depth_role: "leaf",
    focus: oneLine(title) || oneLine(id) || "memory entry",
    parents: ["index.md"],
    covers: buildCovers({ title, tags, atomType: memoryMeta.atom_type, body }),
  };
  if (Array.isArray(tags) && tags.length) frontmatter.tags = tags;
  frontmatter.source = { origin: "inline", hash: `sha256:${contentHash(body)}` };
  frontmatter.updated = new Date().toISOString().slice(0, 10);
  frontmatter.memory = memoryMeta;
  return stringifyLeaf(body, frontmatter);
}

function normaliseMeta(metadata = {}, extra = {}) {
  const m = metadata && typeof metadata === "object" ? metadata : {};
  // `area` is the fine-grained sub-module (facet + fine scope). Legacy atoms put
  // it in `project_module`, so fall back to that. `project_module` itself is the
  // WORKSPACE identifier for this single-project file store, stamped from
  // defaultProjectModule() so recall's default scope matches every leaf (a caller
  // may override it explicitly for a deliberate cross-project save).
  const out = {
    atom_type: String(m.atom_type || extra.atom_type || "").trim(),
    project_module: String(m.project_module_override || defaultProjectModule() || "").trim().toLowerCase(),
    area: String(m.area || m.project_module || "").trim().toLowerCase(),
    language: String(m.language || "").trim().toLowerCase(),
    task_type: String(m.task_type || "").trim().toLowerCase(),
    error_pattern: String(m.error_pattern || "").trim().toLowerCase(),
    status: extra.status || m.status || "active",
  };
  const tags = m.tags;
  if (Array.isArray(tags)) out.tags = tags.join(",");
  else if (tags) out.tags = String(tags);
  // Strip empties so absent fields aren't matched as "". project_module is kept
  // (always the workspace) so the default recall scope always has something to match.
  for (const k of ["area", "language", "task_type", "error_pattern", "tags"]) {
    if (!out[k]) delete out[k];
  }
  if (!out.project_module) delete out.project_module;
  return out;
}

function tagsArray(metadata) {
  const t = metadata && metadata.tags;
  if (Array.isArray(t)) return t;
  if (typeof t === "string" && t) return t.split(",").map((x) => x.trim()).filter(Boolean);
  return [];
}

// Recursively collect leaf files (not index.md) under a directory.
function walkLeaves(dirAbs) {
  const out = [];
  if (!fs.existsSync(dirAbs)) return out;
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkLeaves(abs));
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md") {
      out.push(abs);
    }
  }
  return out;
}

function findByName(categoryAbs, name) {
  for (const leaf of walkLeaves(categoryAbs)) {
    if (path.basename(leaf) === name) return leaf;
  }
  return null;
}

// Normalise an arbitrary document name (which may come from an MCP caller as
// "My Plan.md", a unicode title, or a path) into a skill-valid leaf: a
// kebab-case filename whose stem becomes the leaf `id`. No truncation, so
// timestamped names like knowledge-…-2026-05-22-120000000.md survive intact.
// Without this, an arbitrary name produces a non-kebab `id`/filename that
// fails `skill-llm-wiki validate`.
export function normalizeLeafName(name) {
  const raw = String(name || "").trim().replace(/\.md$/i, "");
  const stem =
    raw
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "") // fold diacritics: café -> cafe
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled";
  return { name: `${stem}.md`, id: stem };
}

// Reject a slot that is not one of the five contract categories, so we never
// create a top-level wiki directory the layout contract does not declare
// (which would break `skill-llm-wiki validate`).
function assertKnownSlot(slot) {
  const category = slotToCategory(slot);
  if (!CATEGORIES.includes(category)) {
    throw new WikiStoreUnavailable(
      `unknown memory category '${slot}'. Valid categories: ${CATEGORIES.join(", ")}.`,
    );
  }
  return category;
}

// Per-category placement facets: the leaf nests under these metadata fields, in
// order, so the on-disk tree mirrors the SAME fields searchMemoryFiltered filters
// on. `daily` is the exception (date-nested, chronological raw intake). A category
// absent here gets no facet nesting (flat under its root) - assertKnownSlot keeps
// that from happening for the five contract categories.
const PLACEMENT_FACETS = {
  knowledge: ["area", "atom_type"],
  self_improvement: ["area", "task_type"],
  plans: ["area"],
  investigations: ["area"],
};

// Kebab folder segment for one facet, with deterministic sentinels when the field
// is absent so a missing facet never collapses leaves back into the category root.
function facetValue(key, meta) {
  const raw = slugify(String((meta && meta[key]) || "").trim());
  if (raw && raw !== "untitled") return raw;
  // Deterministic sentinels for an absent facet field. `task_type` -> "unknown"
  // (already a valid TASK_TYPE), `project_module` -> "unscoped", `atom_type` ->
  // "untyped". atom_type is normally always set by normaliseMeta
  // (slotDefaultAtomType), so "untyped" only surfaces for a malformed legacy
  // leaf during migration.
  const sentinels = { area: "unscoped", task_type: "unknown", atom_type: "untyped" };
  return sentinels[key] || "misc";
}

// Relative dir (under the wiki root) for a leaf, derived from its NORMALISED
// `memory` metadata. Exported so migrate-nest computes the same target from an
// existing leaf's frontmatter. Returns null for `daily` (caller date-nests it).
export function placementDirForMeta(category, meta = {}) {
  if (category === "daily") return null;
  const facets = PLACEMENT_FACETS[category] || [];
  if (facets.length === 0) return category;
  return [category, ...facets.map((k) => facetValue(k, meta))].join("/");
}

// Resolve where a NEW leaf for a slot should live (relative dir under wiki).
function placementDir(slot, { metadata = {}, date = new Date() } = {}) {
  const category = slotToCategory(slot);
  if (category === "daily") return `daily/${dailyDatePath(date)}`;
  return placementDirForMeta(category, metadata) ?? category;
}

// ---- public API (dify-write.mjs parity) ----

// Create a leaf at its facet-derived path. `metadata` is optional but, when
// supplied, drives facet placement (compile passes it here) and may be re-merged
// later via updateDocMetadata. A name collision is replaced in place only when it
// lands at the SAME computed path; dedup across facet folders is the caller's job
// (compile supersedes the prior leaf via `supersedes`). saveDocument is the
// upsert-by-name path that searches the whole category recursively.
export function writeMemory({ name, text, datasetId, supersedes, supersedesAction, metadata, date } = {}) {
  if (!name || !text || !datasetId) {
    throw new WikiStoreUnavailable("writeMemory requires name, text, datasetId");
  }
  const slot = datasetId;
  assertKnownSlot(slot);
  const { name: safeName, id } = normalizeLeafName(name);
  const title = deriveTitle({ metadata, text, name: safeName });
  const memoryMeta = normaliseMeta(metadata, { atom_type: slotDefaultAtomType(slot) });
  const tags = tagsArray(metadata);

  // `date` (optional) pins daily date-nesting to a caller-supplied time (e.g. a
  // flush's capture time) rather than the write time, so a background worker
  // that crosses midnight UTC still nests under the captured day.
  const dir = placementDir(slot, { metadata: memoryMeta, date });
  const leafAbs = path.join(root(), dir.split("/").join(path.sep), safeName);
  fs.mkdirSync(path.dirname(leafAbs), { recursive: true });
  fs.writeFileSync(leafAbs, renderLeaf({ id, title, tags, body: text, memoryMeta }));

  const touched = [leafAbs];
  let supersedeResult;
  if (supersedes) {
    const action = supersedesAction || "disable";
    try {
      supersedeResult =
        action === "delete"
          ? deleteDocument({ documentId: supersedes, datasetId: slot })
          : disableDocument({ documentId: supersedes, datasetId: slot });
    } catch (err) {
      supersedeResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  ensureIndexes(root(), touched);
  upsertEmbedding(toRel(leafAbs), text);

  return {
    ok: true,
    datasetId: slot,
    name: safeName,
    created: { document: { id: toRel(leafAbs) } },
    supersedes: supersedes ? { documentId: supersedes, result: supersedeResult } : undefined,
  };
}

// Upsert-by-name: the leaf is written at the facet path its metadata implies. A
// same-named leaf already at that path is overwritten in place; one found at a
// STALE facet path (its metadata changed) is relocated there so the on-disk path
// always matches the leaf's facets. Applies metadata immediately.
export function saveDocument({ name, text, datasetId, metadata } = {}) {
  if (!name || !text || !datasetId) {
    throw new WikiStoreUnavailable("saveDocument requires name, text, datasetId");
  }
  const slot = datasetId;
  assertKnownSlot(slot);
  const { name: safeName, id } = normalizeLeafName(name);
  const categoryAbs = path.join(root(), slotToCategory(slot));
  const existing = findByName(categoryAbs, safeName);

  const title = deriveTitle({ metadata, text, name: safeName });
  const memoryMeta = normaliseMeta(metadata, { atom_type: slotDefaultAtomType(slot) });
  const tags = tagsArray(metadata);

  const dir = placementDir(slot, { metadata: memoryMeta });
  const leafAbs = path.join(root(), dir.split("/").join(path.sep), safeName);
  const replacedId = existing ? toRel(existing) : undefined;
  const moved = Boolean(existing) && path.resolve(existing) !== path.resolve(leafAbs);

  // If relocating but a DIFFERENT leaf already occupies the target facet path,
  // refuse rather than clobber it and then delete `existing` (double data loss).
  // Such cross-facet basename duplicates can exist because writeMemory places by
  // exact path without a recursive dedup.
  if (moved && fs.existsSync(leafAbs)) {
    return {
      ok: false,
      datasetId: slot,
      name: safeName,
      reason: `destination ${dir}/${safeName} is occupied by a different leaf; refusing to overwrite`,
      conflict: { existing: replacedId, destination: toRel(leafAbs) },
    };
  }

  fs.mkdirSync(path.dirname(leafAbs), { recursive: true });
  fs.writeFileSync(leafAbs, renderLeaf({ id, title, tags, body: text, memoryMeta }));

  const touched = [leafAbs];
  if (moved) {
    fs.rmSync(existing); // relocate: drop the stale-facet copy after the new one is written
    renameEmbedding(toRel(existing), toRel(leafAbs));
    touched.push(existing);
  }
  ensureIndexes(root(), touched);
  upsertEmbedding(toRel(leafAbs), text);

  const metadataAttempted = metadata && Object.keys(metadata).length > 0;
  return {
    ok: true,
    datasetId: slot,
    name: safeName,
    created: { document: { id: toRel(leafAbs) } },
    replacedId,
    relocatedFrom: moved ? replacedId : undefined,
    metadataError: undefined,
    metadataResult: metadataAttempted ? { ok: true } : undefined,
  };
}

// Merge metadata into a leaf's frontmatter `memory` block (idempotent). When a
// facet field (project_module/atom_type/task_type) changes so the leaf's facet
// path no longer matches its current folder, the leaf is RELOCATED so the tree
// keeps mirroring the metadata: the cached vector is preserved (content is
// unchanged) and the old + new ancestor indexes are refreshed. compile re-applies
// the same metadata it placed by, so the common path is a plain in-place rewrite.
export function updateDocMetadata({ datasetId, documentId, metadata } = {}) {
  const abs = toAbs(documentId);
  if (!fs.existsSync(abs)) return { ok: false, reason: `leaf not found: ${documentId}` };
  if (!metadata || Object.keys(metadata).length === 0) return { ok: true, warning: "no metadata" };
  const { data, body } = readLeaf(abs);
  const incoming = normaliseMeta(metadata, { status: leafMemory(data).status });
  // normaliseMeta always emits atom_type (never stripped); on a PARTIAL update
  // that omits it, that empty string would clobber the leaf's existing
  // atom_type. Drop it so a partial merge keeps the current value.
  if (!incoming.atom_type) delete incoming.atom_type;
  const merged = { ...leafMemory(data), ...incoming };
  const rendered = stringifyLeaf(body, { ...data, memory: merged });

  const rel = String(documentId).split("/");
  const newDir = placementDirForMeta(slotToCategory(rel[0]), merged); // null for daily
  const curDir = rel.slice(0, -1).join("/");
  if (newDir && newDir !== curDir) {
    const newRel = `${newDir}/${rel[rel.length - 1]}`;
    const newAbs = toAbs(newRel);
    // Never clobber an occupied destination; fall back to an in-place rewrite.
    if (!fs.existsSync(newAbs)) {
      fs.mkdirSync(path.dirname(newAbs), { recursive: true });
      fs.writeFileSync(newAbs, rendered);
      fs.rmSync(abs);
      renameEmbedding(documentId, newRel);
      ensureIndexes(root(), [abs, newAbs]); // drop the entry from old ancestors, add to new
      return { ok: true, relocated: { from: documentId, to: newRel } };
    }
  }
  fs.writeFileSync(abs, rendered);
  return { ok: true };
}

// Soft-delete: mark archived so listings/search skip it; file stays in git.
export function disableDocument({ documentId, datasetId } = {}) {
  const abs = toAbs(documentId);
  if (!fs.existsSync(abs)) return { ok: false, reason: `leaf not found: ${documentId}` };
  const { data, body } = readLeaf(abs);
  const next = { ...data, memory: { ...leafMemory(data), status: "archived" } };
  fs.writeFileSync(abs, stringifyLeaf(body, next));
  removeEmbedding(toRel(abs));
  return { ok: true, documentId, status: "archived" };
}

export function enableDocument({ documentId, datasetId } = {}) {
  const abs = toAbs(documentId);
  if (!fs.existsSync(abs)) return { ok: false, reason: `leaf not found: ${documentId}` };
  const { data, body } = readLeaf(abs);
  const next = { ...data, memory: { ...leafMemory(data), status: "active" } };
  fs.writeFileSync(abs, stringifyLeaf(body, next));
  upsertEmbedding(toRel(abs), body);
  return { ok: true, documentId, status: "active" };
}

export function deleteDocument({ documentId, datasetId } = {}) {
  const abs = toAbs(documentId);
  if (!fs.existsSync(abs)) return { ok: false, reason: `leaf not found: ${documentId}` };
  fs.rmSync(abs);
  removeEmbedding(documentId);
  // Refresh indexes from the (now-deleted leaf's) parent dir up to the wiki
  // root so the entry disappears from every ancestor index, not just the
  // immediate parent. ensureIndexes walks abs's dirname upward.
  try {
    ensureIndexes(root(), [abs]);
  } catch {
    /* best effort; a later heal will reconcile */
  }
  return { ok: true, documentId, deleted: true };
}

export function listDocuments({ prefix, enabled, datasetId } = {}) {
  const cats = datasetId ? [slotToCategory(datasetId)] : CATEGORIES;
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

export function readDocument({ documentId, datasetId } = {}) {
  const abs = toAbs(documentId);
  if (!fs.existsSync(abs)) throw new WikiStoreUnavailable(`leaf not found: ${documentId}`);
  const { data, body } = readLeaf(abs);
  return { text: body, metadata: leafMemory(data), name: path.basename(abs), documentId };
}

function metaMatchesFilters(memoryMeta, filters) {
  if (!filters) return true;
  for (const [key, val] of Object.entries(filters)) {
    if (val == null || val === "") continue;
    const have = String(memoryMeta[key] || "").toLowerCase();
    const want = String(val).toLowerCase();
    if (key === "tags") {
      const haveTags = have.split(",").map((t) => t.trim());
      const wantTags = want.split(",").map((t) => t.trim()).filter(Boolean);
      if (!wantTags.every((wt) => haveTags.includes(wt))) return false;
    } else if (have !== want) {
      return false;
    }
  }
  return true;
}

// Filter leaves by frontmatter metadata, then rank by embedding similarity.
export async function searchMemoryFiltered({ query, datasetId, limit = 5, filters, scoreThreshold } = {}) {
  const cats = datasetId ? [slotToCategory(datasetId)] : CATEGORIES.filter((c) => c !== "daily");
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

  const records = scored
    .filter((r) => scoreThreshold == null || r.score >= scoreThreshold)
    .slice(0, limit)
    .map((r) => ({
      datasetId: r.datasetId,
      documentId: r.id,
      documentName: r.documentName,
      score: r.score,
      content: r.text,
    }));
  return { records };
}

export function listDatasets() {
  return {
    datasets: CATEGORIES.map((name) => ({ name, id: name })),
    declaredLocally: CATEGORIES.map((name) => ({ name, configuredId: name })),
  };
}

// ---- embedding cache maintenance ----

export function upsertEmbedding(id, text) {
  try {
    const cachePath = embedCachePath();
    const cache = loadCache(cachePath);
    const hash = contentHash(text);
    // Defer the (possibly async) vector compute to search time; we only mark
    // the entry stale here by removing any outdated vector. This keeps the
    // synchronous write path fast and avoids blocking hooks on model load.
    if (cache.entries[id] && cache.entries[id].hash !== hash) {
      delete cache.entries[id];
      saveCache(cachePath, cache);
    }
  } catch {
    /* cache is best-effort */
  }
}

export function removeEmbedding(id) {
  try {
    const cachePath = embedCachePath();
    const cache = loadCache(cachePath);
    if (cache.entries[id]) {
      removeFromCache(cache, id);
      saveCache(cachePath, cache);
    }
  } catch {
    /* best effort */
  }
}

// Move a cache entry from one id to another when a leaf is relocated but its
// content is unchanged (e.g. migrate-nest moving a flat leaf into a facet
// folder). The cached vector stays valid since the content hash is unchanged,
// so this avoids a cold re-embed of the whole moved corpus on the next search.
export function renameEmbedding(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  try {
    const cachePath = embedCachePath();
    const cache = loadCache(cachePath);
    if (cache.entries[oldId]) {
      cache.entries[newId] = cache.entries[oldId];
      delete cache.entries[oldId];
      saveCache(cachePath, cache);
    }
  } catch {
    /* best effort */
  }
}

// Default atom_type for a slot when none is supplied (used for daily capture
// leaves and bare save_to_dataset calls).
function slotDefaultAtomType(slot) {
  const category = slotToCategory(slot);
  if (category === "daily") return "daily-capture";
  if (category === "plans") return "plan";
  if (category === "self_improvement") return "self-improvement-lesson";
  if (category === "investigations") return "investigation";
  return "reference";
}

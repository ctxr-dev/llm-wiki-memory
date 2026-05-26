import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
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
import { inferFacets } from "./facets.mjs";
import { pruneEmptyAncestors } from "./fs-prune.mjs";

// Drop-in replacement for the boilerplate's dify-write.mjs. Same exported
// function names/shapes, but every document is a leaf in the local hosted
// wiki and retrieval is local embeddings. Downstream code (flush, compile,
// exit-plan-mode, the MCP server) calls only these functions.

// Kept name-compatible with the boilerplate so adapted call sites that used
// `DifyBridgeUnavailable` still resolve to a real class.
export class WikiStoreUnavailable extends Error {}
export const DifyBridgeUnavailable = WikiStoreUnavailable;

// --- layout (YAML-driven, falls back to baked-in defaults) ---
//
// CATEGORIES and PLACEMENT_FACETS were previously hardcoded module-level
// constants. They are now sourced from <wiki>/.layout/layout.yaml on first
// access. The defaults below preserve historical behavior for any wiki that
// does NOT declare `layout[].placement_facets` (or has no layout YAML at all).
//
// The YAML schema is:
//   layout:
//     - path: <category-dir-name>            # required
//       placement_facets: [<meta key>, ...]  # optional; if absent we use the
//                                            #   baked-in default for this name
//                                            #   (knowledge/self_improvement/
//                                            #   plans/investigations); for any
//                                            #   NEW category, omitting facets
//                                            #   means flat under the category
//       placement_strategy: daily-date       # optional; only `daily-date` is
//                                            #   recognized (used today for the
//                                            #   `daily` category which nests
//                                            #   by capture date, not facets)
//
// Callers can opt into an exact-placement OVERRIDE per write by passing
// `placementOverride` to writeMemory / saveDocument (or `path` on the MCP
// tools). When supplied, the override bypasses category facet derivation; the
// only remaining role of CATEGORIES is to gate which slots are accepted as a
// `datasetId`.
const DEFAULT_CATEGORIES = Object.freeze([
  "knowledge",
  "self_improvement",
  "plans",
  "investigations",
  "daily",
]);
const DEFAULT_PLACEMENT_FACETS = Object.freeze({
  knowledge: Object.freeze(["area", "atom_type"]),
  self_improvement: Object.freeze(["area", "task_type"]),
  plans: Object.freeze(["area"]),
  investigations: Object.freeze(["area"]),
});

export const CATEGORIES = [];
const PLACEMENT_FACETS = {};
// Per-category facet rules from layout `facet_rules`. A rule marks a facet as
// `kind: path` (array-valued -> one directory segment per element) and can pin
// its first segment to a declared vocabulary, with a `fallback` sentinel used
// when the facet is absent/empty. Facets without a rule stay single-segment.
// null-prototype: keys are author-controlled layout category/vocab names, so a
// `__proto__`/`constructor` key can never reach a prototype slot.
const PLACEMENT_RULES = Object.create(null);
// Declared `vocabularies` (name -> Set<slug>): controlled value sets a
// `kind: path` facet's first segment must belong to.
const VOCABULARIES = Object.create(null);
let _layoutLoaded = false;
let _layoutRootSeen = null;

function ensureLayoutLoaded() {
  // Re-load if the wiki root changed (test isolation flips MEMORY_DATA_DIR).
  const r = root();
  if (_layoutLoaded && _layoutRootSeen === r) return;

  const cats = [...DEFAULT_CATEGORIES];
  const facets = {};
  for (const k of Object.keys(DEFAULT_PLACEMENT_FACETS)) {
    facets[k] = [...DEFAULT_PLACEMENT_FACETS[k]];
  }
  // null-prototype maps: layout keys are author-controlled, so never let a
  // key like `__proto__`/`constructor` reach a prototype slot.
  const rules = Object.create(null);
  const vocabs = Object.create(null);

  // Layout YAML canonical location is <wiki>/.layout/layout.yaml.
  const layoutPath = path.join(r, ".layout", "layout.yaml");
  if (fs.existsSync(layoutPath)) {
    try {
      const parsed = parseYaml(fs.readFileSync(layoutPath, "utf8")) || {};
      // Controlled value sets referenced by `kind: path` facet rules.
      if (parsed.vocabularies && typeof parsed.vocabularies === "object") {
        for (const [vname, vals] of Object.entries(parsed.vocabularies)) {
          if (!Array.isArray(vals)) continue;
          vocabs[vname] = new Set(vals.map((v) => slugify(String(v))).filter(Boolean));
        }
      }
      const entries = Array.isArray(parsed.layout) ? parsed.layout : [];
      if (entries.length > 0) {
        // Replace categories wholesale from the YAML (the YAML is the
        // declared contract).
        cats.length = 0;
        for (const e of entries) {
          const name = String((e && e.path) || "").trim();
          if (!name) continue;
          cats.push(name);
          if (Array.isArray(e.placement_facets)) {
            facets[name] = e.placement_facets.map((s) => String(s));
          } else if (DEFAULT_PLACEMENT_FACETS[name]) {
            facets[name] = [...DEFAULT_PLACEMENT_FACETS[name]];
          } else if (name === "daily" || e.placement_strategy === "daily-date") {
            // daily is special-cased downstream; no facets entry needed.
          } else {
            // Declared but unspecified -> flat under category root.
            facets[name] = [];
          }
          if (e.facet_rules && typeof e.facet_rules === "object") {
            const r2 = Object.create(null);
            for (const [fname, spec] of Object.entries(e.facet_rules)) {
              if (!spec || typeof spec !== "object") continue;
              r2[fname] = {
                kind: spec.kind === "path" ? "path" : "segment",
                vocabulary: spec.vocabulary ? String(spec.vocabulary) : null,
                fallback: spec.fallback != null ? String(spec.fallback) : null,
              };
            }
            rules[name] = r2;
          }
        }
        // Drop default facet keys for categories the YAML did NOT declare.
        for (const k of Object.keys(facets)) {
          if (!cats.includes(k)) delete facets[k];
        }
      }
    } catch (_err) {
      // Malformed YAML -> keep defaults; do not crash callers.
    }
  }

  CATEGORIES.length = 0;
  CATEGORIES.push(...cats);
  for (const k of Object.keys(PLACEMENT_FACETS)) delete PLACEMENT_FACETS[k];
  Object.assign(PLACEMENT_FACETS, facets);
  for (const k of Object.keys(PLACEMENT_RULES)) delete PLACEMENT_RULES[k];
  Object.assign(PLACEMENT_RULES, rules);
  for (const k of Object.keys(VOCABULARIES)) delete VOCABULARIES[k];
  Object.assign(VOCABULARIES, vocabs);

  _layoutLoaded = true;
  _layoutRootSeen = r;
}

// Test/maintenance hook: forces the next layout-touching call to re-parse
// .layout/layout.yaml. Tests rotate MEMORY_DATA_DIR between cases; production
// code never needs this.
export function _resetLayoutCacheForTests() {
  _layoutLoaded = false;
  _layoutRootSeen = null;
}

// Public accessor for category names. Triggers layout load on demand so a
// caller (e.g. the MCP `get_memory_config` tool) that does not first touch a
// write/search path still gets the populated list. Returns a fresh copy.
export function getCategories() {
  ensureLayoutLoaded();
  return [...CATEGORIES];
}

export function slotToCategory(slot) {
  ensureLayoutLoaded();
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

// Normalize a `kind: path` facet value (an array, or a "/"-joined string) into
// clean slug segments. Segments carrying NO sluggable content (empty, pure
// whitespace, or punctuation-only) are DROPPED — not collapsed to slugify's
// "untitled" placeholder — so an empty/odd subject never leaks junk path
// segments. A segment whose content literally slugs to "untitled" is kept
// (it had real content).
export function slugSegments(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split("/")
      : [];
  const out = [];
  for (const s of raw) {
    const str = String(s);
    // slugify yields "untitled" only when the base normalizes to empty; detect
    // that here so we can drop the segment instead of emitting the placeholder.
    const hasContent = /[a-z0-9]/.test(str.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, ""));
    if (!hasContent) continue;
    out.push(slugify(str));
  }
  return out;
}

export function normaliseMeta(metadata = {}, extra = {}) {
  const m = metadata && typeof metadata === "object" ? metadata : {};
  // `area` is the fine-grained sub-module (facet + fine scope). Legacy atoms put
  // it in `project_module`, so fall back to that. `project_module` itself is the
  // WORKSPACE identifier for this single-project file store, stamped from
  // defaultProjectModule() so recall's default scope matches every leaf. A
  // deliberate cross-project save can override the workspace via
  // `metadata.project_module_override`; the plain `metadata.project_module` is
  // reserved as the legacy sub-module alias for `area`, so it is NOT honoured as
  // the workspace value (that is why a separate override key exists).
  //
  // This project_module -> area fallback is WRITE-TIME only. The search filter
  // matcher (metaMatchesFilters) compares stored frontmatter literally, so a
  // stored legacy leaf (only project_module, no area) matches an `area` filter
  // only AFTER `migrate` rewrites its frontmatter. A read-time alias is avoided on
  // purpose: post-split project_module is the workspace, not a sub-module, so
  // aliasing it to `area` at match time would mis-match every migrated leaf.
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
  // `subject`: the hierarchical semantic path (broad->narrow). Persisted as a
  // slug array so it survives into frontmatter (placement reads it back when a
  // leaf is relocated, and it stays browsable/searchable). Accepts an array or
  // a "/"-joined string; content-free segments are dropped. Absent/empty ->
  // omitted (placement applies its fallback).
  const subjectArr = slugSegments(m.subject);
  if (subjectArr.length) out.subject = subjectArr;
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

// Filesystem-safe leaf name that PRESERVES CASE. Used when a caller supplies
// placementOverride and asserts full control over the leaf identity (e.g. the
// Jira hook needs DEV-129957.md on disk, not dev-129957.md). We still strip
// path separators / NUL / OS-reserved chars and reject ".." stems so an
// attacker can't escape the override dir via a crafted name; the resulting
// filename keeps the caller's original casing for everything else. The
// returned `id` mirrors the stem so the skill's leaf id == filename stem
// invariant is preserved.
export function normalizeLeafNamePreservingCase(name) {
  const raw = String(name || "").trim().replace(/\.md$/i, "");
  if (!raw) {
    throw new WikiStoreUnavailable("leaf name is empty after trimming");
  }
  // Reject control chars (incl. NUL) and the small set of filesystem-unsafe
  // punctuation; everything else (letters, digits, hyphen, underscore, dot,
  // tilde, etc.) is kept verbatim.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw) || /[<>:"/\\|?*]/.test(raw)) {
    throw new WikiStoreUnavailable(
      `leaf name contains a filesystem-unsafe character; got: ${JSON.stringify(raw)}`,
    );
  }
  // Reject pure-dots stems (".", "..") and names starting with a leading
  // path-traversal segment.
  if (raw === "." || raw === ".." || raw.startsWith("../") || raw.startsWith("./")) {
    throw new WikiStoreUnavailable(`leaf name is not a valid stem: ${JSON.stringify(raw)}`);
  }
  return { name: `${raw}.md`, id: raw };
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

// (PLACEMENT_FACETS is initialised by ensureLayoutLoaded() at the top of this
// module; the YAML in <wiki>/.layout/layout.yaml is the source of truth and
// the baked-in defaults preserve historical behavior when the YAML is absent
// or declares no `placement_facets` for a category.)

// Kebab folder segment for one facet, with deterministic sentinels when the field
// is absent so a missing facet never collapses leaves back into the category root.
function facetValue(key, meta) {
  const raw = slugify(String((meta && meta[key]) || "").trim());
  if (raw && raw !== "untitled") return raw;
  // Deterministic sentinels for an absent facet field. `area` -> "unscoped" (the
  // sub-module facet key), `task_type` -> "unknown" (already a valid TASK_TYPE),
  // `atom_type` -> "untyped". atom_type is normally always set by normaliseMeta
  // (slotDefaultAtomType), so "untyped" only surfaces for a malformed legacy
  // leaf during migration.
  const sentinels = { area: "unscoped", task_type: "unknown", atom_type: "untyped" };
  return sentinels[key] || "misc";
}

// Expand a `kind: path` facet into one-or-more directory segments (broad->narrow).
// The facet value may be an array (`subject: [a, b, c]`) or a "/"-joined string.
// An absent/empty value collapses to the rule's `fallback` sentinel so a leaf is
// never dropped at the category root. When a `vocabulary` is declared, the FIRST
// segment must belong to it; otherwise we throw (FAIL LOUD) rather than write a
// leaf under an un-curated top-level domain.
function pathFacetSegments(key, meta, rule) {
  const parts = slugSegments(meta ? meta[key] : undefined);
  const fallback = slugify(String(rule.fallback || "general")) || "general";
  if (parts.length === 0) return [fallback];
  const vocab =
    rule.vocabulary && Object.hasOwn(VOCABULARIES, rule.vocabulary)
      ? VOCABULARIES[rule.vocabulary]
      : null;
  if (vocab && vocab.size > 0 && !vocab.has(parts[0])) {
    throw new WikiStoreUnavailable(
      `placement: '${key}' domain '${parts[0]}' is not in vocabulary '${rule.vocabulary}'. ` +
        `Allowed: ${[...vocab].join(", ")}. ` +
        `Provide a valid first '${key}' segment, or omit '${key}' to use the '${fallback}' fallback.`,
    );
  }
  return parts;
}

// Relative dir (under the wiki root) for a leaf, derived from its NORMALISED
// `memory` metadata. Exported so migrate-nest computes the same target from an
// existing leaf's frontmatter. Returns null for `daily` (caller date-nests it).
export function placementDirForMeta(category, meta = {}) {
  ensureLayoutLoaded();
  if (category === "daily") return null;
  const facets = PLACEMENT_FACETS[category] || [];
  if (facets.length === 0) return category;
  const catRules = PLACEMENT_RULES[category] || {};
  const segs = [category];
  for (const k of facets) {
    const rule = catRules[k];
    if (rule && rule.kind === "path") {
      segs.push(...pathFacetSegments(k, meta, rule));
    } else {
      segs.push(facetValue(k, meta));
    }
  }
  return segs.join("/");
}

// Resolve where a NEW leaf for a slot should live (relative dir under wiki).
function placementDir(slot, { metadata = {}, date = new Date() } = {}) {
  const category = slotToCategory(slot);
  if (category === "daily") return `daily/${dailyDatePath(date)}`;
  return placementDirForMeta(category, metadata) ?? category;
}

// Validate a caller-supplied `placementOverride` path: must be a relative
// directory under the wiki root, no traversal, no nulls, no leading slash.
// Returns the normalised relative dir (forward-slash separated) on success;
// throws WikiStoreUnavailable on a rejected path.
function normalisePlacementOverride(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new WikiStoreUnavailable(
      `placementOverride must be a non-empty string; got: ${JSON.stringify(raw)}`,
    );
  }
  if (raw.includes("\0")) {
    throw new WikiStoreUnavailable("placementOverride contains a NUL byte");
  }
  // Reject absolute paths and Windows drive letters defensively.
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new WikiStoreUnavailable(
      `placementOverride must be relative to the wiki root; got: ${raw}`,
    );
  }
  // Forbid `..` segments so a caller can't escape the wiki root, even though
  // path.join would normalise some of them away. We also strip empty segments.
  const segs = raw.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  if (segs.length === 0) {
    throw new WikiStoreUnavailable(
      `placementOverride must include at least one path segment; got: ${raw}`,
    );
  }
  if (segs.some((s) => s === "..")) {
    throw new WikiStoreUnavailable(
      `placementOverride must not contain '..' segments; got: ${raw}`,
    );
  }
  return segs.join("/");
}

// ---- public API (dify-write.mjs parity) ----

// Create a leaf at its facet-derived path. `metadata` is optional but, when
// supplied, drives facet placement (compile passes it here) and may be re-merged
// later via updateDocMetadata. A name collision is replaced in place only when it
// lands at the SAME computed path; dedup across facet folders is the caller's job
// (compile supersedes the prior leaf via `supersedes`). saveDocument is the
// upsert-by-name path that searches the whole category recursively.
export function writeMemory({
  name,
  text,
  datasetId,
  supersedes,
  supersedesAction,
  metadata,
  date,
  placementOverride,
} = {}) {
  if (!name || !text || !datasetId) {
    throw new WikiStoreUnavailable("writeMemory requires name, text, datasetId");
  }
  const slot = datasetId;
  const category = assertKnownSlot(slot);

  // `placementOverride` (optional): when supplied, the leaf is written verbatim
  // at <override>/<name> and facet inference is skipped. CASING is preserved
  // in BOTH the directory segments AND the filename stem (we call
  // normalizeLeafNamePreservingCase instead of normalizeLeafName, so a caller
  // passing "DEV-129957.md" gets exactly "DEV-129957.md" on disk and the same
  // string as the leaf `id`). Metadata is still normalised for the frontmatter
  // `memory` block so the leaf remains searchable / filterable by
  // `searchMemoryFiltered`.
  let dir;
  let memoryMeta;
  let tags;
  let safeName;
  let id;
  if (placementOverride !== undefined && placementOverride !== null) {
    dir = normalisePlacementOverride(placementOverride);
    ({ name: safeName, id } = normalizeLeafNamePreservingCase(name));
    memoryMeta = normaliseMeta(metadata || {}, { atom_type: slotDefaultAtomType(slot) });
    tags = tagsArray(metadata);
  } else {
    ({ name: safeName, id } = normalizeLeafName(name));
    // Infer/validate placement facets so a leaf is never written under an
    // unknown/unscoped area or an out-of-set atom_type (daily is a no-op).
    // Heuristic + deterministic fallback only, so this stays synchronous.
    const facets = inferFacets({ category, meta: metadata || {}, tags: tagsArray(metadata) });
    const effectiveMeta = { ...(metadata || {}), ...facets };
    memoryMeta = normaliseMeta(effectiveMeta, { atom_type: slotDefaultAtomType(slot) });
    tags = tagsArray(effectiveMeta);

    // `date` (optional) pins daily date-nesting to a caller-supplied time (e.g. a
    // flush's capture time) rather than the write time, so a background worker
    // that crosses midnight UTC still nests under the captured day.
    dir = placementDir(slot, { metadata: memoryMeta, date });
  }
  const title = deriveTitle({ metadata, text, name: safeName });
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
export function saveDocument({ name, text, datasetId, metadata, placementOverride } = {}) {
  if (!name || !text || !datasetId) {
    throw new WikiStoreUnavailable("saveDocument requires name, text, datasetId");
  }
  const slot = datasetId;
  const category = assertKnownSlot(slot);

  // `placementOverride` (optional): when supplied, the existence check is
  // scoped to the override path only (we do NOT broad-search the category
  // tree by name, because the caller is asserting a specific location). This
  // also disables the cross-facet "relocate" behaviour - the override IS the
  // target. CASING is preserved in the filename so a caller passing
  // "DEV-129957.md" gets exactly that on disk. Metadata is still normalised
  // so the leaf stays searchable.
  let dir;
  let memoryMeta;
  let tags;
  let existing;
  let safeName;
  let id;
  if (placementOverride !== undefined && placementOverride !== null) {
    dir = normalisePlacementOverride(placementOverride);
    ({ name: safeName, id } = normalizeLeafNamePreservingCase(name));
    memoryMeta = normaliseMeta(metadata || {}, { atom_type: slotDefaultAtomType(slot) });
    tags = tagsArray(metadata);
    const candidateAbs = path.join(root(), dir.split("/").join(path.sep), safeName);
    existing = fs.existsSync(candidateAbs) ? candidateAbs : null;
  } else {
    ({ name: safeName, id } = normalizeLeafName(name));
    const categoryAbs = path.join(root(), slotToCategory(slot));
    existing = findByName(categoryAbs, safeName);
    // Infer/validate placement facets so a leaf is never saved under an
    // unknown/unscoped area or an out-of-set atom_type. Heuristic + deterministic
    // fallback only, so this stays synchronous.
    const facets = inferFacets({ category, meta: metadata || {}, tags: tagsArray(metadata) });
    const effectiveMeta = { ...(metadata || {}), ...facets };
    memoryMeta = normaliseMeta(effectiveMeta, { atom_type: slotDefaultAtomType(slot) });
    tags = tagsArray(effectiveMeta);
    dir = placementDir(slot, { metadata: memoryMeta });
  }
  const title = deriveTitle({ metadata, text, name: safeName });

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
  // After a relocation, drop any source ancestor dir left holding only an
  // orphaned index.md (prune AFTER ensureIndexes, which may have rewritten it).
  if (moved) pruneEmptyAncestors(path.dirname(existing), root());

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
      // Remove any source ancestor dir left holding only an orphaned index.md.
      pruneEmptyAncestors(path.dirname(abs), root());
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
export async function searchMemoryFiltered({ query, datasetId, limit = 5, filters, scoreThreshold } = {}) {
  ensureLayoutLoaded();
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
  ensureLayoutLoaded();
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

// On-demand garbage collection for the embedding cache. The write path keeps
// the cache in sync for API-driven deletes/moves (removeEmbedding /
// renameEmbedding), but a leaf removed OUT OF BAND — a manual `rm`, a `git`
// checkout, a wiki wipe+re-migrate, or the skill's own balance/flatten moves —
// strands its cache entry forever (rank() only ever scores LIVE candidates, so
// orphans are never re-touched). This sweep drops every entry whose id is not a
// live leaf on disk. NOT wired into any background job — run it explicitly.
//
// Returns { ok, before, after, removed, removedIds } (removedIds capped at 50
// for reporting). A `dryRun` reports what WOULD be removed without writing.
export function pruneEmbeddingCache({ dryRun = false } = {}) {
  const cachePath = embedCachePath();
  const cache = loadCache(cachePath);
  const ids = Object.keys(cache.entries);
  const before = ids.length;

  // Live-leaf id set: toRel of every leaf under every category (all categories,
  // so we never wrongly prune a live leaf's entry — daily/issues included).
  ensureLayoutLoaded();
  const live = new Set();
  for (const cat of getCategories()) {
    for (const leaf of walkLeaves(path.join(root(), cat))) live.add(toRel(leaf));
  }

  const removedIds = ids.filter((id) => !live.has(id));
  if (!dryRun && removedIds.length > 0) {
    for (const id of removedIds) delete cache.entries[id];
    saveCache(cachePath, cache);
  }
  return {
    ok: true,
    cachePath,
    dryRun,
    before,
    after: before - (dryRun ? 0 : removedIds.length),
    removed: removedIds.length,
    removedIds: removedIds.slice(0, 50),
  };
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

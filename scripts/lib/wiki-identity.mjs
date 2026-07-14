import path from "node:path";
import { slugify } from "./slug.mjs";
import { defaultProjectModule } from "./env.mjs";
import { priorityForAtomType, normalisePriority } from "./datasets.mjs";
import { WikiStoreUnavailable, root } from "./wiki-core.mjs";

/** @typedef {import("./types.mjs").MemoryMetadata} MemoryMetadata */
/** @typedef {import("./types.mjs").MetadataInput} MetadataInput */

/**
 * @param {string} absPath
 * @returns {string}
 */
export function toRel(absPath) {
  return path.relative(root(), absPath).split(path.sep).join("/");
}

/**
 * @param {string | null | undefined} relOrId
 * @returns {string}
 */
export function toAbs(relOrId) {
  return path.join(root(), String(relOrId).split("/").join(path.sep));
}

// The category a leaf id belongs to is its first path segment (ids are the
// "/"-joined rel path from the wiki root, e.g. "knowledge/foo/bar.md"). This is
// how the per-category embed cache is located for a given leaf.
/**
 * @param {string | null | undefined} id
 * @returns {string}
 */
export function categoryOfId(id) {
  return String(id || "").split("/")[0] || "";
}

// Normalize a `kind: path` facet value (an array, or a "/"-joined string) into
// clean slug segments. Segments carrying NO sluggable content (empty, pure
// whitespace, or punctuation-only) are DROPPED — not collapsed to slugify's
// "untitled" placeholder — so an empty/odd subject never leaks junk path
// segments. A segment whose content literally slugs to "untitled" is kept
// (it had real content).
/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function slugSegments(value) {
  /** @type {unknown[]} */
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split("/") : [];
  /** @type {string[]} */
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

/**
 * @param {MetadataInput} [metadata]
 * @param {{ atom_type?: string, status?: string }} [extra]
 * @returns {MemoryMetadata}
 */
export function normaliseMeta(metadata = {}, extra = {}) {
  /** @type {MetadataInput} */
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
  /** @type {Record<string, unknown>} */
  const out = {
    atom_type: String(m.atom_type || extra.atom_type || "").trim(),
    project_module: String(m.project_module_override || defaultProjectModule() || "")
      .trim()
      .toLowerCase(),
    area: String(m.area || m.project_module || "")
      .trim()
      .toLowerCase(),
    language: String(m.language || "")
      .trim()
      .toLowerCase(),
    task_type: String(m.task_type || "")
      .trim()
      .toLowerCase(),
    error_pattern: String(m.error_pattern || "")
      .trim()
      .toLowerCase(),
    status: extra.status || m.status || "active",
  };
  // Apply-strength priority. Honour an explicit valid value (incl. a gated P0 —
  // the P0-scarcity guard for non-gated writes lives at the MCP boundary, not
  // here, since this choke point also serves system/consolidate writers and the
  // gated lesson path); otherwise fill the deterministic rubric default by
  // atom_type (never P0). Always present, never stripped.
  out.priority = normalisePriority(m.priority) || priorityForAtomType(out.atom_type);
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
  // Consolidate / refresh fields. Optional pass-throughs: absent in metadata
  // stays absent in the output. Coerced defensively (stale is a real boolean).
  // Mutated only by consolidate.mjs, which carries the system-maintenance tag.
  if (typeof m.stale === "boolean") out.stale = m.stale;
  if (typeof m.supersedes_id === "string" && m.supersedes_id.trim() !== "") {
    out.supersedes_id = m.supersedes_id.trim();
  }
  if (typeof m.consolidated_at === "string" && m.consolidated_at.trim() !== "") {
    out.consolidated_at = m.consolidated_at.trim();
  }
  if (typeof m.last_refreshed_at === "string" && m.last_refreshed_at.trim() !== "") {
    out.last_refreshed_at = m.last_refreshed_at.trim();
  }
  if (typeof m.consolidate_truncated_at === "string" && m.consolidate_truncated_at.trim() !== "") {
    out.consolidate_truncated_at = m.consolidate_truncated_at.trim();
  }
  // Strip empties so absent fields aren't matched as "". project_module is kept
  // (always the workspace) so the default recall scope always has something to match.
  for (const k of ["area", "language", "task_type", "error_pattern", "tags"]) {
    if (!out[k]) delete out[k];
  }
  if (!out.project_module) delete out.project_module;
  return /** @type {MemoryMetadata} */ (out);
}

/**
 * Re-supply an existing leaf's workspace identity as `project_module_override` so
 * a maintenance RE-SAVE preserves it. normaliseMeta derives `project_module` from
 * `project_module_override || defaultProjectModule()` and NEVER from the raw
 * `project_module` (that key is the legacy `area` alias), so a re-save that
 * re-emits a leaf's own memory WITHOUT the override would rewrite a deliberately
 * cross-project leaf's identity to the workspace default. When the caller already
 * re-identifies (a non-empty override) or the leaf never had an identity, the
 * metadata is returned unchanged.
 * @param {MetadataInput | null | undefined} metadata
 * @param {{ project_module?: string } | null | undefined} existingMemory
 * @returns {MetadataInput}
 */
export function preserveIdentityOnResave(metadata, existingMemory) {
  const md = metadata && typeof metadata === "object" ? metadata : {};
  const reidentifies =
    typeof md.project_module_override === "string" && md.project_module_override.trim() !== "";
  const existing = existingMemory && existingMemory.project_module;
  if (reidentifies || !existing) return md;
  return { ...md, project_module_override: existing };
}

/**
 * @param {MetadataInput | null | undefined} metadata
 * @returns {string[]}
 */
export function tagsArray(metadata) {
  const t = metadata && metadata.tags;
  if (Array.isArray(t)) return t;
  if (typeof t === "string" && t)
    return t
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  return [];
}

// Normalise an arbitrary document name (which may come from an MCP caller as
// "My Plan.md", a unicode title, or a path) into a skill-valid leaf: a
// kebab-case filename whose stem becomes the leaf `id`. No truncation, so
// timestamped names like knowledge-…-2026-05-22-120000000.md survive intact.
// Without this, an arbitrary name produces a non-kebab `id`/filename that
// fails `skill-llm-wiki validate`.
/**
 * @param {string} name
 * @returns {{ name: string, id: string }}
 */
export function normalizeLeafName(name) {
  // Preserve the `.plan.md` compound extension so facet-placed plan leaves keep
  // the suffix the plan-lifecycle machinery (syncAllPlans / plan-frontmatter-sync)
  // keys on. Without this, the stem slugify below folds `.plan` into `-plan` and
  // the leaf is no longer recognised as a plan (so its lifecycle never syncs).
  const isPlan = /\.plan\.md$/i.test(String(name || ""));
  const raw = String(name || "")
    .trim()
    .replace(/\.plan\.md$/i, "")
    .replace(/\.md$/i, "");
  const stem =
    raw
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "") // fold diacritics: café -> cafe
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled";
  return isPlan
    ? { name: `${stem}.plan.md`, id: `${stem}.plan` }
    : { name: `${stem}.md`, id: stem };
}

// Filesystem-safe leaf name that PRESERVES CASE. Used when a caller supplies
// placementOverride and asserts full control over the leaf identity (e.g. the
// Jira hook needs DEV-129957.md on disk, not dev-129957.md). We still strip
// path separators / NUL / OS-reserved chars and reject ".." stems so an
// attacker can't escape the override dir via a crafted name; the resulting
// filename keeps the caller's original casing for everything else. The
// returned `id` mirrors the stem so the skill's leaf id == filename stem
// invariant is preserved.
/**
 * @param {string} name
 * @returns {{ name: string, id: string }}
 */
export function normalizeLeafNamePreservingCase(name) {
  const raw = String(name || "")
    .trim()
    .replace(/\.md$/i, "");
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

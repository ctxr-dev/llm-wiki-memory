// Layered-layout merge for the federated wiki.
//
// A wiki level may carry a shared `layout.yaml` (checked in, the contract) and
// an OPTIONAL personal `layout.local.yaml` (per-user overrides). The merge rule
// is deliberately asymmetric: SHARED WINS on any conflict; the local file may
// only ADD entries/keys the shared layout does not already define. This keeps a
// personal override file from silently diverging the checked-in contract while
// still letting an individual layer extra categories or vocabularies on top.
//
// Per-key semantics:
//   layout[]      keyed by `path`; a shared entry wins wholesale over a
//                 same-`path` local entry (no field-level merge within an
//                 entry); local-only paths are appended.
//   vocabularies  deep-merged by key; a colliding key takes the SHARED array;
//                 a local-only vocab key is preserved.
//   everything else (scalars, scalar string arrays, other maps like
//                 versioning) is shared-wins wholesale-replace.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { LayoutYamlSchema } from "./layout-schema.mjs";

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * @param {unknown} v
 * @returns {unknown[]}
 */
function asArray(v) {
  return Array.isArray(v) ? /** @type {unknown[]} */ (v) : [];
}

/**
 * Merge the top-level `layout[]` arrays. Shared entries are kept verbatim; a
 * local entry is appended only when its `path` is not already claimed by a
 * shared entry (shared wins wholesale on a path collision).
 * @param {unknown} sharedLayout
 * @param {unknown} localLayout
 * @returns {unknown[]}
 */
function mergeLayoutArray(sharedLayout, localLayout) {
  const shared = asArray(sharedLayout);
  const local = asArray(localLayout);
  /** @type {Set<string>} */
  const sharedPaths = new Set();
  for (const e of shared) {
    if (isPlainObject(e) && typeof e.path === "string") sharedPaths.add(e.path);
  }
  const out = [...shared];
  for (const e of local) {
    const p = isPlainObject(e) && typeof e.path === "string" ? e.path : null;
    if (p !== null && sharedPaths.has(p)) continue;
    out.push(e);
  }
  return out;
}

/**
 * Deep-merge the `vocabularies` map by key: a colliding key takes the shared
 * array; a local-only key is preserved.
 * @param {unknown} sharedVocab
 * @param {unknown} localVocab
 * @returns {Record<string, unknown>}
 */
function mergeVocabularies(sharedVocab, localVocab) {
  const s = isPlainObject(sharedVocab) ? sharedVocab : {};
  const l = isPlainObject(localVocab) ? localVocab : {};
  return { ...l, ...s };
}

/**
 * Merge two PARSED layout objects. Shared wins on any conflict; local may only
 * ADD keys/entries the shared layout does not define (see module header).
 * @param {Record<string, unknown> | null | undefined} shared
 * @param {Record<string, unknown> | null | undefined} local
 * @returns {Record<string, unknown>}
 */
export function mergeLayouts(shared, local) {
  /** @type {Record<string, unknown>} */
  const base = isPlainObject(shared) ? shared : {};
  if (!isPlainObject(local) || Object.keys(local).length === 0) {
    return base;
  }
  /** @type {Record<string, unknown>} */
  const result = { ...local, ...base };
  if (Array.isArray(base.layout) || Array.isArray(local.layout)) {
    result.layout = mergeLayoutArray(base.layout, local.layout);
  }
  if (isPlainObject(base.vocabularies) || isPlainObject(local.vocabularies)) {
    result.vocabularies = mergeVocabularies(base.vocabularies, local.vocabularies);
  }
  return result;
}

/**
 * @param {string} filePath
 * @returns {{ present: boolean, obj: Record<string, unknown> | null }}
 */
function safeReadLayoutYaml(filePath) {
  if (!fs.existsSync(filePath)) return { present: false, obj: null };
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return { present: true, obj: null };
  }
  try {
    const parsed = parseYaml(text);
    return { present: true, obj: isPlainObject(parsed) ? parsed : null };
  } catch {
    return { present: true, obj: null };
  }
}

/**
 * Read `<layoutDir>/layout.yaml` (shared, required) and the OPTIONAL personal
 * `<layoutDir>/layout.local.yaml`, safe-parse both, merge them (shared wins),
 * validate the merged layout against `LayoutYamlSchema`, and return it.
 *
 * A malformed/absent local file is ignored with a warning (shared is used
 * alone). A malformed/absent shared file falls back to the engine defaults
 * without crashing the parse. A merged layout that fails schema validation is
 * surfaced by throwing with the collected issues.
 * @param {string} layoutDir
 * @returns {Record<string, unknown>}
 */
export function loadMergedLayout(layoutDir) {
  const sharedPath = path.join(layoutDir, "layout.yaml");
  const localPath = path.join(layoutDir, "layout.local.yaml");

  const sharedRead = safeReadLayoutYaml(sharedPath);
  if (sharedRead.obj === null) {
    console.warn(
      `loadMergedLayout: shared layout at ${sharedPath} is absent or malformed; falling back to defaults`,
    );
  }

  const localRead = safeReadLayoutYaml(localPath);
  /** @type {Record<string, unknown> | null} */
  let local = null;
  if (localRead.present && localRead.obj === null) {
    console.warn(
      `loadMergedLayout: personal layout.local.yaml at ${localPath} is malformed; ignoring it (using shared layout only)`,
    );
  } else {
    local = localRead.obj;
  }

  const merged = mergeLayouts(sharedRead.obj, local);
  const result = LayoutYamlSchema.safeParse(merged);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    const sources = local ? `${sharedPath} + ${localPath}` : sharedPath;
    throw new Error(`merged layout failed validation (${sources}): ${detail}`);
  }
  return merged;
}

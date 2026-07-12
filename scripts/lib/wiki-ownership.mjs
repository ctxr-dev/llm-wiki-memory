// Per-category OWNERSHIP for the federated (layered) wiki, and the commit-batch
// partition the auto-commit flush relies on.
//
// A federated level's merged layout tags each category `ownership: repo` (the
// category is checked into the CONSUMING project and committed by the USER) or
// `ownership: wiki` (a private category the engine may commit, like the brain).
// Baseline single-level wikis omit the field entirely; an absent ownership is
// treated as NOT shared (committable by the engine), which keeps pre-federation
// behaviour byte-identical.
//
// R11 (user-locked): the engine NEVER runs git against a shared/host repo. Two
// guards enforce it here: partitionEntriesForCommit DROPS every repo-owned leaf
// before staging (R20/V3), and it GROUPS the survivors by their owning wiki
// root so one commit can never span two git roots (M5).

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { mergeLayouts } from "./layout-merge.mjs";

/** @typedef {import("./wiki-commit.mjs").CommitEntry} CommitEntry */

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The object-shaped `layout[]` entries of a parsed layout (empty when the
 * layout is absent or malformed).
 * @param {Record<string, unknown>} layout
 * @returns {Record<string, unknown>[]}
 */
function layoutEntries(layout) {
  const arr = Array.isArray(layout.layout) ? /** @type {unknown[]} */ (layout.layout) : [];
  return arr.filter(isObj);
}

/**
 * Map every declared category (layout entry `path`) to its `ownership`. Entries
 * without an `ownership` field are omitted, so a caller reads an absent category
 * as NOT shared.
 * @param {Record<string, unknown>} layout
 * @returns {Map<string, "repo" | "wiki">}
 */
export function ownershipMap(layout) {
  /** @type {Map<string, "repo" | "wiki">} */
  const map = new Map();
  for (const e of layoutEntries(layout)) {
    const p = e.path;
    const own = e.ownership;
    if (typeof p === "string" && (own === "repo" || own === "wiki")) map.set(p, own);
  }
  return map;
}

/**
 * Category dirs declared `ownership: repo` — the shared, repo-tracked categories
 * a mount's gitignore TRACKS. Order follows the layout's `layout[]` order.
 * @param {Record<string, unknown>} layout
 * @returns {string[]}
 */
export function sharedCategories(layout) {
  /** @type {string[]} */
  const out = [];
  for (const [cat, own] of ownershipMap(layout)) if (own === "repo") out.push(cat);
  return out;
}

/**
 * @param {string} rel a wiki-relative path or leaf id
 * @returns {string} its first segment (the category dir)
 */
function categoryOfRel(rel) {
  return String(rel || "").split("/")[0] || "";
}

/**
 * @param {string} file
 * @returns {Record<string, unknown> | null}
 */
function readYamlObject(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = parseYaml(fs.readFileSync(file, "utf8"));
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Merge a wiki root's shared `layout.yaml` with its optional personal
 * `layout.local.yaml` WITHOUT the warn-on-absent side effect of
 * `loadMergedLayout` — this runs on the hot commit path, where a rootDir with no
 * `.layout` (e.g. a bare test repo) must degrade silently to `{}`.
 * @param {string} rootDir absolute wiki root directory
 * @returns {Record<string, unknown>}
 */
export function mergedLayoutForRoot(rootDir) {
  const dir = path.join(rootDir, ".layout");
  return mergeLayouts(
    readYamlObject(path.join(dir, "layout.yaml")),
    readYamlObject(path.join(dir, "layout.local.yaml")),
  );
}

/**
 * Partition commit entries for the auto-commit flush. DROP every shared
 * (`ownership: repo`) leaf so the engine never even stages a shared-owned path
 * (R20/V3), then GROUP the survivors by their owning wiki root so a single
 * commit never spans two git roots (M5). Each distinct root's merged layout is
 * read at most once.
 * @param {CommitEntry[]} entries
 * @param {string} fallbackRoot wiki root for entries with no recorded `rootDir`
 * @returns {Map<string, CommitEntry[]>} owning root -> committable entries
 */
export function partitionEntriesForCommit(entries, fallbackRoot) {
  /** @type {Map<string, CommitEntry[]>} */
  const byRoot = new Map();
  /** @type {Map<string, Map<string, "repo" | "wiki">>} */
  const ownByRoot = new Map();
  for (const e of entries || []) {
    const rootDir = e.rootDir || fallbackRoot;
    let own = ownByRoot.get(rootDir);
    if (!own) {
      own = ownershipMap(mergedLayoutForRoot(rootDir));
      ownByRoot.set(rootDir, own);
    }
    if (own.get(categoryOfRel(e.leafRelPath)) === "repo") continue;
    const bucket = byRoot.get(rootDir);
    if (bucket) bucket.push(e);
    else byRoot.set(rootDir, [e]);
  }
  return byRoot;
}

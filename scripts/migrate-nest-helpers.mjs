import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { MEMORY_DIR } from "./lib/env.mjs";
import { getCategories, placementDirForMeta } from "./lib/wiki-store.mjs";
import { dailyDatePath, parseDailyDocName } from "./lib/slug.mjs";
import { pathFor, validateFacets } from "./lib/topology-runtime.mjs";
import { parseIssueKey, inferLifecycle } from "./lib/tracker-parse.mjs";

/** @typedef {import("./lib/topology-loader.mjs").Topology} Topology */

/**
 * The tracker facets derived for a flat topology leaf being re-nested.
 * @typedef {Object} TrackerFacets
 * @property {string} tracker
 * @property {string} prefix
 * @property {number} number
 * @property {string} [slug]
 * @property {string} [lifecycle]
 */

/**
 * A flat leaf sitting directly in a category root.
 * @typedef {Object} FlatLeaf
 * @property {string} category
 * @property {string} name
 * @property {string} abs
 */

/**
 * A planned relocation from a flat category root into the nested layout.
 * @typedef {Object} Move
 * @property {string} from
 * @property {string} to
 * @property {string} abs
 * @property {string} destAbs
 */

/** @type {Record<string, number>} */
const LIFECYCLE_RANK = { pending: 0, "in-progress": 1, done: 2 };

/**
 * @param {string} wiki
 * @param {string} abs
 * @returns {string}
 */
export function relPosix(wiki, abs) {
  return path.relative(wiki, abs).split(path.sep).join("/");
}

/**
 * @param {string} abs
 * @returns {Record<string, unknown>}
 */
export function leafMemoryOf(abs) {
  try {
    const data = matter(fs.readFileSync(abs, "utf8")).data || {};
    return data.memory && typeof data.memory === "object" ? data.memory : {};
  } catch {
    return {};
  }
}

// Lifecycle for a tracker plan being re-nested: the MORE-ADVANCED of the
// checkbox-inferred state and any valid stored lifecycle (top-level `status:`
// or `memory.status`), by pending < in-progress < done. `archived` is never
// auto-assigned (manual-only), and the non-lifecycle `active` sentinel is
// ignored. This rescues done-but-unchecked plans while still self-correcting a
// stale `pending` whose boxes are all checked.
/**
 * @param {string} abs
 * @returns {string}
 */
function resolvePlanLifecycle(abs) {
  const raw = fs.readFileSync(abs, "utf8");
  const parsed = matter(raw);
  const inferred = inferLifecycle(parsed.content);
  /** @type {string[]} */
  const candidates = [inferred];
  for (const v of [parsed.data?.status, parsed.data?.memory?.status]) {
    const s = String(v || "")
      .trim()
      .toLowerCase();
    if (s in LIFECYCLE_RANK) candidates.push(s);
  }
  return candidates.reduce(
    (best, c) => (LIFECYCLE_RANK[c] > LIFECYCLE_RANK[best] ? c : best),
    "pending",
  );
}

// Derive {kind, facets} for a flat leaf in a topology category from its
// filename (+ plan body). Returns null when the filename can't yield a tracker
// key — the caller records it as a skipped/failed item (FAIL LOUD, never
// default to the category root).
/**
 * @param {{ topo: Topology, name: string, abs: string }} args
 * @returns {{ kind: string, facets: TrackerFacets } | null}
 */
function deriveTrackerFacets({ topo, name, abs }) {
  const isPlan = name.endsWith(".plan.md");
  const stem = name.replace(/\.plan\.md$/, "").replace(/\.md$/, "");
  const kind = isPlan ? "plan" : "knowledge";
  // The leading `PREFIX-NUMBER` is the issue key; the rest of a plan stem is
  // the slug (mirrors from_path.mjs's split).
  const keyMatch = /^([A-Z][A-Z0-9]{1,9}-\d{1,7})(?:-(.+))?$/.exec(stem);
  if (!keyMatch) return null;
  const parsedKey = parseIssueKey(keyMatch[1]);
  if (!parsedKey) return null;
  const tracker =
    /** @type {{ default?: string } | undefined} */ (topo.facetInputs?.tracker)?.default || "JIRA";
  /** @type {TrackerFacets} */
  const facets = { tracker, prefix: parsedKey.prefix, number: parsedKey.number };
  if (isPlan) {
    const slug = keyMatch[2] || "";
    if (!slug) return null;
    facets.slug = slug;
    facets.lifecycle = resolvePlanLifecycle(abs);
  } else if (keyMatch[2]) {
    // Knowledge kind keys ONLY on the issue number (`<PREFIX>-<N>.md`); a
    // trailing segment (`DEV-123-extra.md`) has nowhere to go and pathFor would
    // silently drop it, renaming the leaf and risking a same-dest collision
    // with another `DEV-123-*.md`. Refuse (record unresolved) rather than
    // silently reshape the identity — the leaf needs manual placement.
    return null;
  }
  const check = validateFacets(topo, kind, facets);
  if (!check.ok) return null;
  return { kind, facets };
}

// FULL relative destination path (dir + filename) for a flat leaf. Topology
// categories resolve via the path-compiler and use ITS basename verbatim — the
// compiler normalises the number (e.g. DEV-007 -> DEV-7), so reusing the
// original filename would land at a path whose stem no longer round-trips
// through from_path. Returns null on underivable facets (recorded as skipped,
// never defaulted to the category root). Facet categories mirror placementDir.
/**
 * @param {{ category: string, name: string, abs: string, meta: Record<string, unknown>, mtime: Date, topo: Topology | null | undefined }} args
 * @returns {string | null}
 */
export function targetRelFor({ category, name, abs, meta, mtime, topo }) {
  if (category === "daily") {
    const parsed = parseDailyDocName(name);
    const datePath = parsed ? parsed.date.split("-").join("/") : dailyDatePath(mtime);
    return `daily/${datePath}/${name}`;
  }
  if (topo) {
    const derived = deriveTrackerFacets({ topo, name, abs });
    if (!derived) return null;
    try {
      return pathFor(topo, derived.kind, derived.facets); // full path, normalised basename
    } catch {
      return null;
    }
  }
  const dir = placementDirForMeta(category, meta) ?? category;
  return `${dir}/${name}`;
}

// Files sitting directly in a category root (not index.md, not dotfiles, not
// already in a subdirectory). Subdirectories are skipped: they are already nested.
/**
 * @param {string} wiki
 * @returns {FlatLeaf[]}
 */
export function flatLeaves(wiki) {
  /** @type {FlatLeaf[]} */
  const out = [];
  for (const cat of getCategories()) {
    const catAbs = path.join(wiki, cat);
    if (!fs.existsSync(catAbs)) continue;
    for (const entry of fs.readdirSync(catAbs, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      if (!entry.name.endsWith(".md") || entry.name === "index.md") continue;
      out.push({ category: cat, name: entry.name, abs: path.join(catAbs, entry.name) });
    }
  }
  return out;
}

// Seed the baseline contract ONLY when the wiki has none. NEVER overwrite an
// existing layout: an install may have customised it (e.g. layered the
// tracker-issues topology onto the baseline), and clobbering it with the
// shipped default would silently drop that topology block — exactly the
// nesting contract this migration depends on. Contract UPDATES are bootstrap's
// job, not nest's.
/**
 * @param {string} wiki
 * @returns {void}
 */
export function seedContractIfAbsent(wiki) {
  const dest = path.join(wiki, ".layout", "layout.yaml");
  if (fs.existsSync(dest)) return;
  const tmpl = path.join(MEMORY_DIR, "examples", "layouts", "default", "layout.yaml");
  if (!fs.existsSync(tmpl)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(tmpl, dest);
}

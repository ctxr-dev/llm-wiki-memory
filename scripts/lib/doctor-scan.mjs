// Filesystem scan helpers + category selectors for the wiki health `doctor`
// (see `doctor.mjs`, which composes these into the detector functions and the
// orchestrator). All read-only: directory walks, frontmatter probes, index-ref
// extraction, and the layout-derived category selectors that decide which trees
// each detector class runs on.
import fs from "node:fs";
import path from "node:path";
import {
  getCategories,
  getConsolidateLayout,
  categoryHasTopology,
  getPlacementFacets,
} from "./wiki-store.mjs";

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isHidden(name) {
  return name.startsWith(".");
}

// Categories whose index.md trees are worth a broken-ref scan: every declared
// category except topology ones (their nesting is validated by the compiler).
export function brokenRefCategories() {
  return getCategories().filter((c) => !categoryHasTopology(c));
}

// The curated human zone, where the one-index-per-folder + stamped-frontmatter
// conventions hold: explicitly `consolidate: none`, NOT facet-managed (a flat /
// path-nested human taxonomy), not topology, not the date-nested `daily`. This
// excludes facet machine categories (knowledge / self_improvement / plans …)
// even when they happen to be `consolidate: none`.
export function curatedCategories() {
  return getConsolidateLayout().excluded.filter(
    (c) => !categoryHasTopology(c) && c !== "daily" && getPlacementFacets(c).length === 0,
  );
}

/**
 * @param {string} absDir
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function indexFilesUnder(absDir, out = []) {
  let ents;
  try {
    ents = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (isHidden(e.name)) continue;
    const p = path.join(absDir, e.name);
    if (e.isDirectory()) indexFilesUnder(p, out);
    else if (e.name === "index.md") out.push(p);
  }
  return out;
}

/**
 * @param {string} absDir
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function leavesUnder(absDir, out = []) {
  let ents;
  try {
    ents = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (isHidden(e.name)) continue;
    const p = path.join(absDir, e.name);
    if (e.isDirectory()) leavesUnder(p, out);
    else if (e.name.endsWith(".md") && e.name !== "index.md") out.push(p);
  }
  return out;
}

/**
 * @param {string} absFile
 * @returns {boolean}
 */
export function hasFrontmatter(absFile) {
  try {
    return fs.readFileSync(absFile, "utf8").startsWith("---");
  } catch {
    return false;
  }
}

/**
 * @param {string} wiki
 * @param {string} abs
 * @returns {string}
 */
export function rel(wiki, abs) {
  return path.relative(wiki, abs).split(path.sep).join("/");
}

// Every leaf reference an index.md makes: frontmatter `children:` list, the
// `entries[].file` values, and inline markdown `](....md)` links.
/**
 * @param {string} raw
 * @returns {string[]}
 */
export function refsFromIndex(raw) {
  /** @type {Set<string>} */
  const refs = new Set();
  const fm = raw.split(/^---$/m)[1] || "";
  for (const m of fm.matchAll(/^\s*-\s*"?([^"\n]+\.md)"?\s*$/gm)) refs.add(m[1].trim());
  for (const m of fm.matchAll(/\bfile:\s*"?([^"\n]+\.md)"?/g)) refs.add(m[1].trim());
  for (const m of raw.matchAll(/\]\(([^)]+?\.md)\)/g)) refs.add(decodeURIComponent(m[1].trim()));
  return [...refs];
}

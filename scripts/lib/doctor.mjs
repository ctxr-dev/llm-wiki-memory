// Read-only health scan for the curated wiki: detects the damage a cloud-sync
// daemon (Drive/iCloud/Dropbox/OneDrive) inflicts by relocating files —
// index.md references that no longer resolve (Obsidian then materialises phantom
// empty files on click), leaves missing from their folder's index, raw
// no-frontmatter leaves (restore artifacts), and orphan leaves no index links.
//
// Layout-derived, never a hardcoded category set:
//   - broken-index-ref check runs on every declared NON-topology category
//     (topology trees are round-trip-validated by `nest`/the path compiler).
//   - the structural heuristics (unlisted / stray / orphan) run ONLY on the
//     curated human zone (`consolidate: none`, non-topology, non-daily), where
//     the one-index-per-folder + stamped-frontmatter conventions hold. Facet/
//     machine categories are engine-managed and covered by `validate`.
//
// Read-only by DEFAULT (doctor REPORTS; `ensureIndexes`/`nest` are the fixers).
// The opt-in `{ fix }` path rebuilds the parents that hold a broken ref via
// index-rebuild-one (disk-authoritative), then re-scans — the surgical repair
// for stale parent->pruned-child refs. strays/orphans/unlisted are still only
// reported (different damage classes).
import fs from "node:fs";
import path from "node:path";
import { wikiRoot } from "./env.mjs";
import {
  getCategories,
  getConsolidateLayout,
  categoryHasTopology,
  getPlacementFacets,
} from "./wiki-store.mjs";
import { indexRebuildOne } from "./wiki-cli.mjs";
import { recordWikiChange } from "./wiki-commit.mjs";

function isHidden(name) {
  return name.startsWith(".");
}

// Categories whose index.md trees are worth a broken-ref scan: every declared
// category except topology ones (their nesting is validated by the compiler).
function brokenRefCategories() {
  return getCategories().filter((c) => !categoryHasTopology(c));
}

// The curated human zone, where the one-index-per-folder + stamped-frontmatter
// conventions hold: explicitly `consolidate: none`, NOT facet-managed (a flat /
// path-nested human taxonomy), not topology, not the date-nested `daily`. This
// excludes facet machine categories (knowledge / self_improvement / plans …)
// even when they happen to be `consolidate: none`.
function curatedCategories() {
  return getConsolidateLayout().excluded.filter(
    (c) =>
      !categoryHasTopology(c) &&
      c !== "daily" &&
      getPlacementFacets(c).length === 0,
  );
}

function indexFilesUnder(absDir, out = []) {
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

function leavesUnder(absDir, out = []) {
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

function hasFrontmatter(absFile) {
  try {
    return fs.readFileSync(absFile, "utf8").startsWith("---");
  } catch {
    return false;
  }
}

function rel(wiki, abs) {
  return path.relative(wiki, abs).split(path.sep).join("/");
}

// Every leaf reference an index.md makes: frontmatter `children:` list, the
// `entries[].file` values, and inline markdown `](....md)` links.
function refsFromIndex(raw) {
  const refs = new Set();
  const fm = raw.split(/^---$/m)[1] || "";
  for (const m of fm.matchAll(/^\s*-\s*"?([^"\n]+\.md)"?\s*$/gm)) refs.add(m[1].trim());
  for (const m of fm.matchAll(/\bfile:\s*"?([^"\n]+\.md)"?/g)) refs.add(m[1].trim());
  for (const m of raw.matchAll(/\]\(([^)]+?\.md)\)/g)) refs.add(decodeURIComponent(m[1].trim()));
  return [...refs];
}

// index.md links a ref that doesn't exist on disk -> Obsidian phantom-file source.
export function findBrokenIndexRefs(wiki = wikiRoot()) {
  const found = [];
  for (const cat of brokenRefCategories()) {
    for (const idx of indexFilesUnder(path.join(wiki, cat))) {
      const dir = path.dirname(idx);
      let raw;
      try {
        raw = fs.readFileSync(idx, "utf8");
      } catch {
        continue;
      }
      const broken = refsFromIndex(raw).filter(
        (r) => !/^https?:|^obsidian:/.test(r) && !fs.existsSync(path.resolve(dir, r)),
      );
      if (broken.length) found.push({ index: rel(wiki, idx), broken });
    }
  }
  return found;
}

// A real child (leaf or sub-index) not listed in its folder's index.md.
export function findUnlistedChildren(wiki = wikiRoot()) {
  const found = [];
  // Global basename frequency across the curated zone, to flag dup-basename collisions.
  const freq = Object.create(null);
  for (const cat of curatedCategories()) {
    for (const leaf of leavesUnder(path.join(wiki, cat))) {
      const b = path.basename(leaf, ".md");
      freq[b] = (freq[b] || 0) + 1;
    }
  }
  for (const cat of curatedCategories()) {
    for (const idx of indexFilesUnder(path.join(wiki, cat))) {
      const dir = path.dirname(idx);
      let raw;
      try {
        raw = fs.readFileSync(idx, "utf8");
      } catch {
        continue;
      }
      const listed = new Set();
      for (const m of raw.matchAll(/\]\(([^)]+?\.md)\)/g)) {
        listed.add(decodeURIComponent(m[1]).replace(/^\.\//, ""));
      }
      const actual = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (isHidden(e.name) || e.name === "index.md") continue;
        if (e.isFile() && e.name.endsWith(".md")) actual.push(e.name);
        else if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, "index.md"))) {
          actual.push(`${e.name}/index.md`);
        }
      }
      const unlisted = actual
        .filter((a) => !listed.has(a) && !listed.has(`./${a}`))
        .map((name) => {
          const base = path.basename(name, ".md");
          let why = "?";
          if (name.endsWith("/index.md")) why = "subdir index not listed";
          else if (freq[base] > 1) why = `DUP-BASENAME x${freq[base]}`;
          else if (!hasFrontmatter(path.join(dir, name))) why = "no frontmatter";
          return { name, why };
        });
      if (unlisted.length) found.push({ index: rel(wiki, idx), unlisted });
    }
  }
  return found;
}

// Raw leaves (no YAML frontmatter) in the curated zone — the signature of a
// cloud-sync restore artifact or a hand-dropped file the engine never stamped.
export function findStrayLeaves(wiki = wikiRoot()) {
  const found = [];
  for (const cat of curatedCategories()) {
    for (const leaf of leavesUnder(path.join(wiki, cat))) {
      if (!hasFrontmatter(leaf)) found.push({ stray: rel(wiki, leaf), reason: "no frontmatter" });
    }
  }
  return found;
}

// A curated leaf that no index.md anywhere references (the inverse of a broken ref).
export function findOrphanLeaves(wiki = wikiRoot()) {
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
  const found = [];
  for (const cat of curatedCategories()) {
    for (const leaf of leavesUnder(path.join(wiki, cat))) {
      if (!referenced.has(path.resolve(leaf))) found.push({ orphan: rel(wiki, leaf) });
    }
  }
  return found;
}

// Orchestrator: run all detectors, return a structured report. Read-only unless
// `fix` is set, in which case it rebuilds every broken-ref parent and re-scans;
// the returned `brokenRefs` then reflects the POST-fix state and `fixed` lists
// the refs that were cleared.
export function doctor(wiki = wikiRoot(), { fix = false } = {}) {
  const w = path.resolve(wiki);
  let brokenRefs = findBrokenIndexRefs(w);
  let fixed;
  if (fix && brokenRefs.length) {
    const before = brokenRefs;
    for (const entry of before) {
      try {
        indexRebuildOne(path.dirname(path.resolve(w, entry.index)), w);
        // Commit the repair when run inside a wiki-commit frame (cli doctor
        // --fix wraps one); a no-op outside a git wiki.
        recordWikiChange({ action: "reindexed", leafRelPath: entry.index, reason: "doctor --fix reindex" });
      } catch {
        /* best-effort; the re-scan reports whatever remains broken */
      }
    }
    const after = findBrokenIndexRefs(w);
    const remainingByIndex = new Map(after.map((e) => [e.index, new Set(e.broken)]));
    fixed = before
      .map((e) => {
        const remaining = remainingByIndex.get(e.index) || new Set();
        const cleared = e.broken.filter((r) => !remaining.has(r));
        return cleared.length ? { index: e.index, fixed: cleared } : null;
      })
      .filter(Boolean);
    brokenRefs = after;
  }
  const unlisted = findUnlistedChildren(w);
  const strays = findStrayLeaves(w);
  const orphans = findOrphanLeaves(w);
  const summary = {
    brokenRefs: brokenRefs.reduce((n, r) => n + r.broken.length, 0),
    unlisted: unlisted.reduce((n, r) => n + r.unlisted.length, 0),
    strays: strays.length,
    orphans: orphans.length,
  };
  const ok = Object.values(summary).every((n) => n === 0);
  const report = {
    ok,
    wiki: w,
    scanned: { brokenRefCategories: brokenRefCategories(), curatedCategories: curatedCategories() },
    brokenRefs,
    unlisted,
    strays,
    orphans,
    summary,
  };
  if (fix) report.fixed = fixed || [];
  return report;
}

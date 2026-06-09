import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import matter from "gray-matter";
import { wikiRoot } from "./lib/env.mjs";
import { getCategories, categoryHasTopology, updateDocMetadata } from "./lib/wiki-store.mjs";
import { ensureIndexes, validate } from "./lib/wiki-cli.mjs";
import { facetIssues, classifyFacetsLLM } from "./lib/facets.mjs";

// One-shot, idempotent backfill: re-identify placement facets on leaves whose
// `area` is unknown/unscoped/the workspace name, or (for knowledge) whose
// `atom_type` is out of the valid set (the doubled `knowledge/<area>/knowledge/`
// bucket). For each offender it runs classifyFacetsLLM (the write path's
// heuristic baseline, escalated to a single LLM call to pin a precise
// sub-module / atom_type), rewrites the frontmatter, and RELOCATES the leaf via
// updateDocMetadata so the on-disk tree matches the corrected facets. Empty
// source dirs are pruned.
//
// `--check` reports offenders without mutating (no LLM); `--dry-run` lists the
// offenders + their issues (no LLM); a real run calls the LLM only for the
// offenders. A clean wiki is a no-op.

// Live list (getCategories triggers layout load; the module-level CATEGORIES
// binding is empty until then). Excludes `daily` (date-placed) and any topology
// category (path-compiler-placed, no facet `area` — would be flagged forever
// and reject the unpinned updateDocMetadata).
function facetCategories() {
  return getCategories().filter((c) => c !== "daily" && !categoryHasTopology(c));
}

function relPosix(wiki, abs) {
  return path.relative(wiki, abs).split(path.sep).join("/");
}

function walkLeaves(dirAbs, out = []) {
  if (!fs.existsSync(dirAbs)) return out;
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) walkLeaves(abs, out);
    else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md") out.push(abs);
  }
  return out;
}

function leafOf(abs) {
  try {
    const parsed = matter(fs.readFileSync(abs, "utf8"));
    const data = parsed.data || {};
    return { ok: true, meta: data.memory && typeof data.memory === "object" ? data.memory : {}, body: parsed.content || "", focus: data.focus || "" };
  } catch {
    return { ok: false, meta: {}, body: "", focus: "" };
  }
}

// Find offenders cheaply (no LLM). Unparseable leaves are reported separately,
// not treated as offenders: re-identifying them would be a wasted LLM call and
// updateDocMetadata would only fail on them anyway (gray-matter can't parse).
function findOffenders(wiki) {
  const offenders = [];
  const unparseable = [];
  for (const cat of facetCategories()) {
    for (const abs of walkLeaves(path.join(wiki, cat))) {
      const leaf = leafOf(abs);
      if (!leaf.ok) {
        unparseable.push(relPosix(wiki, abs));
        continue;
      }
      const issues = facetIssues(cat, leaf.meta);
      if (issues.length) offenders.push({ category: cat, abs, id: relPosix(wiki, abs), issues });
    }
  }
  return { offenders, unparseable };
}

// Remove directories under the facet categories that no longer hold any leaf
// (only an index.md, or empty). Deletes the stale index.md too; parents are
// re-indexed by the caller. Bottom-up so nested empties collapse.
function pruneEmptyDirs(wiki) {
  const pruned = [];
  for (const cat of facetCategories()) {
    const catAbs = path.join(wiki, cat);
    if (!fs.existsSync(catAbs)) continue;
    const dirs = [];
    const collect = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith(".")) {
          const abs = path.join(d, e.name);
          collect(abs);
          dirs.push(abs);
        }
      }
    };
    collect(catAbs);
    for (const dir of dirs.sort((a, b) => b.length - a.length)) {
      // deepest first. Only prune when the directory holds NOTHING but its own
      // index.md (plus dotfiles): any other entry (a non-md file, a stray data
      // file, or a subdirectory) means real content we must not delete.
      const entries = fs.readdirSync(dir).filter((n) => !n.startsWith("."));
      const onlyIndex = entries.every((n) => n === "index.md");
      if (onlyIndex) {
        fs.rmSync(dir, { recursive: true, force: true });
        pruned.push(relPosix(wiki, dir));
      }
    }
  }
  return pruned;
}

export async function reidentifyFacets({ dryRun = false, check = false } = {}) {
  // Always operate on the env-bound wiki root: the relocations go through
  // updateDocMetadata, which resolves paths against wikiRoot() internally, so
  // scanning/pruning/validate MUST use the same root (no divergent `wiki` arg).
  const wiki = wikiRoot();
  const { offenders, unparseable } = findOffenders(wiki);

  if (check) {
    return { ok: offenders.length === 0, mode: "check", offenderCount: offenders.length, offenders: offenders.map((o) => ({ id: o.id, issues: o.issues })), unparseable };
  }
  if (dryRun) {
    return { ok: true, mode: "dry-run", offenderCount: offenders.length, offenders: offenders.map((o) => ({ id: o.id, issues: o.issues })), unparseable };
  }

  const applied = [];
  const skipped = [];
  for (const o of offenders) {
    const { meta, body, focus } = leafOf(o.abs);
    const patch = await classifyFacetsLLM({ category: o.category, meta, title: focus, text: body, tags: meta.tags });
    // updateDocMetadata relocates the leaf and refreshes the OLD + NEW ancestor
    // indexes itself, so moves need no extra index work here. Guard it: a single
    // malformed leaf (e.g. unparseable frontmatter) must not abort the whole run.
    let res;
    try {
      res = updateDocMetadata({ datasetId: o.category, documentId: o.id, metadata: patch });
    } catch (err) {
      res = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (res && res.ok) {
      applied.push({ from: o.id, to: res.relocated ? res.relocated.to : o.id, patch });
    } else {
      skipped.push({ id: o.id, reason: res && res.reason ? res.reason : "update failed" });
    }
  }

  // Prune dirs emptied by the relocations, then rebuild each pruned dir's PARENT
  // index. ensureIndexes() expects LEAF paths (it walks up from path.dirname),
  // so pass a synthetic `<parent>/index.md` whose dirname is the parent to rebuild.
  const pruned = pruneEmptyDirs(wiki);
  if (pruned.length) {
    const synthetic = pruned.map((rel) => {
      const prunedAbs = path.join(wiki, rel.split("/").join(path.sep));
      return path.join(path.dirname(prunedAbs), "index.md");
    });
    try {
      ensureIndexes(wiki, synthetic);
    } catch {
      /* best effort; validate will surface anything left */
    }
  }
  const validation = applied.length || pruned.length ? validate(wiki) : { ok: true, errors: 0, warnings: 0 };

  return {
    ok: validation.ok && skipped.length === 0,
    mode: "reidentify",
    reidentified: applied.length,
    moves: applied.map(({ from, to }) => ({ from, to })),
    prunedDirs: pruned,
    skipped,
    unparseable,
    validate: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings },
  };
}

const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  const res = await reidentifyFacets({ dryRun: process.argv.includes("--dry-run"), check: process.argv.includes("--check") });
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  if (res.mode === "check" && !res.ok) process.exit(3);
  if (res.mode === "reidentify" && !res.ok) process.exit(2);
}

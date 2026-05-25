import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import matter from "gray-matter";
import { wikiRoot } from "./lib/env.mjs";
import { CATEGORIES, updateDocMetadata } from "./lib/wiki-store.mjs";
import { ensureIndexes, validate } from "./lib/wiki-cli.mjs";
import { facetIssues, classifyFacetsLLM } from "./lib/facets.mjs";

// One-shot, idempotent backfill: re-identify placement facets on leaves whose
// `area` is unknown/unscoped/the workspace name, or (for knowledge) whose
// `atom_type` is out of the valid set (the doubled `knowledge/<area>/knowledge/`
// bucket). For each offender it runs the SAME inferFacets the write path uses,
// rewrites the frontmatter, and RELOCATES the leaf via updateDocMetadata so the
// on-disk tree matches the corrected facets. Empty source dirs are pruned.
//
// `--check` reports offenders without mutating (no LLM); `--dry-run` lists the
// offenders + their issues (no LLM); a real run calls the LLM only for the
// offenders. A clean wiki is a no-op.

const FACET_CATEGORIES = CATEGORIES.filter((c) => c !== "daily");

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
    return { meta: data.memory && typeof data.memory === "object" ? data.memory : {}, body: parsed.content || "", focus: data.focus || "" };
  } catch {
    return { meta: {}, body: "", focus: "" };
  }
}

// Find offenders cheaply (no LLM).
function findOffenders(wiki) {
  const offenders = [];
  for (const cat of FACET_CATEGORIES) {
    for (const abs of walkLeaves(path.join(wiki, cat))) {
      const { meta } = leafOf(abs);
      const issues = facetIssues(cat, meta);
      if (issues.length) offenders.push({ category: cat, abs, id: relPosix(wiki, abs), issues });
    }
  }
  return offenders;
}

// Remove directories under the facet categories that no longer hold any leaf
// (only an index.md, or empty). Deletes the stale index.md too; parents are
// re-indexed by the caller. Bottom-up so nested empties collapse.
function pruneEmptyDirs(wiki) {
  const pruned = [];
  for (const cat of FACET_CATEGORIES) {
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
      // deepest first
      const entries = fs.readdirSync(dir).filter((n) => !n.startsWith("."));
      const hasLeaf = entries.some((n) => n.endsWith(".md") && n !== "index.md");
      const hasSubdir = entries.some((n) => fs.statSync(path.join(dir, n)).isDirectory());
      if (!hasLeaf && !hasSubdir) {
        fs.rmSync(dir, { recursive: true, force: true });
        pruned.push(relPosix(wiki, dir));
      }
    }
  }
  return pruned;
}

export async function reidentifyFacets({ wiki = wikiRoot(), dryRun = false, check = false } = {}) {
  const offenders = findOffenders(wiki);

  if (check) {
    return { ok: offenders.length === 0, mode: "check", offenderCount: offenders.length, offenders: offenders.map((o) => ({ id: o.id, issues: o.issues })) };
  }
  if (dryRun) {
    return { ok: true, mode: "dry-run", offenderCount: offenders.length, offenders: offenders.map((o) => ({ id: o.id, issues: o.issues })) };
  }

  const applied = [];
  const skipped = [];
  const touchedParents = new Set();
  for (const o of offenders) {
    const { meta, body, focus } = leafOf(o.abs);
    const patch = await classifyFacetsLLM({ category: o.category, meta, title: focus, text: body, tags: meta.tags });
    const res = updateDocMetadata({ datasetId: o.category, documentId: o.id, metadata: patch });
    if (res && res.ok) {
      const to = res.relocated ? res.relocated.to : o.id;
      applied.push({ from: o.id, to, patch });
      touchedParents.add(path.dirname(o.abs));
    } else {
      skipped.push({ id: o.id, reason: res && res.reason ? res.reason : "update failed" });
    }
  }

  const pruned = pruneEmptyDirs(wiki);
  // Refresh indexes for every parent that lost a leaf or a pruned subdir.
  const refresh = [...touchedParents, ...pruned.map((p) => path.dirname(path.join(wiki, p.split("/").join(path.sep))))];
  if (refresh.length) {
    try {
      ensureIndexes(wiki, refresh);
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

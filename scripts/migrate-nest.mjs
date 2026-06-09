import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import matter from "gray-matter";
import { MEMORY_DIR, wikiRoot } from "./lib/env.mjs";
import {
  getCategories,
  categoryHasTopology,
  placementDirForMeta,
  renameEmbedding,
} from "./lib/wiki-store.mjs";
import { ensureIndexes, validate } from "./lib/wiki-cli.mjs";
import { dailyDatePath, parseDailyDocName } from "./lib/slug.mjs";
import { loadTopology, pathFor, validateFacets } from "./lib/topology-runtime.mjs";
import { parseIssueKey, inferLifecycle } from "./lib/tracker-parse.mjs";
import { recordWikiChange, withWikiCommit } from "./lib/wiki-commit.mjs";

// One-shot, idempotent migration: move FLAT leaves (files sitting directly in a
// category root) into the nested layout the writer now produces. For facet
// categories the target dir is computed via placementDirForMeta (reading each
// leaf's own `memory` block); for daily it is the date path. For a category
// with a `topology:` block (tracker `issues`) the target is computed by the
// topology path-compiler from facets DERIVED from the filename (prefix/number/
// slug) + the plan body (lifecycle) — these flats predate the topology and
// carry no facets in metadata.
//
// `--check` reports flat leaves without mutating (CI/preflight guard); `--dry-run`
// lists the planned moves without mutating. A clean wiki is a no-op (aside from a
// contract refresh on a real run).

const LIFECYCLE_RANK = { pending: 0, "in-progress": 1, done: 2 };

function relPosix(wiki, abs) {
  return path.relative(wiki, abs).split(path.sep).join("/");
}

function leafMemoryOf(abs) {
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
function resolvePlanLifecycle(abs) {
  const raw = fs.readFileSync(abs, "utf8");
  const parsed = matter(raw);
  const inferred = inferLifecycle(parsed.content);
  const candidates = [inferred];
  for (const v of [parsed.data?.status, parsed.data?.memory?.status]) {
    const s = String(v || "").trim().toLowerCase();
    if (s in LIFECYCLE_RANK) candidates.push(s);
  }
  return candidates.reduce((best, c) => (LIFECYCLE_RANK[c] > LIFECYCLE_RANK[best] ? c : best), "pending");
}

// Derive {kind, facets} for a flat leaf in a topology category from its
// filename (+ plan body). Returns null when the filename can't yield a tracker
// key — the caller records it as a skipped/failed item (FAIL LOUD, never
// default to the category root).
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
  const tracker = (topo.facetInputs?.tracker?.default) || "JIRA";
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
function targetRelFor({ category, name, abs, meta, mtime, topo }) {
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
function flatLeaves(wiki) {
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
function seedContractIfAbsent(wiki) {
  const dest = path.join(wiki, ".layout", "layout.yaml");
  if (fs.existsSync(dest)) return;
  const tmpl = path.join(MEMORY_DIR, "templates", "llmwiki.layout.yaml");
  if (!fs.existsSync(tmpl)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(tmpl, dest);
}

export function migrateNest(opts = {}) {
  const wiki = opts.wiki || wikiRoot();
  // One nest run = one commit; --check/--dry-run record nothing, so their
  // batch flushes empty and no commit happens.
  return withWikiCommit({ op: "migrate-nest", actor: "migrate-nest", rootDir: wiki }, () =>
    migrateNestInner({ ...opts, wiki }));
}

async function migrateNestInner({ wiki = wikiRoot(), dryRun = false, check = false } = {}) {
  const flats = flatLeaves(wiki);
  // Load the topology ONCE if any flat sits in a topology category. loadTopology
  // is async + cached by mtime; targetDirFor stays sync per item.
  const topoByCategory = new Map();
  for (const leaf of flats) {
    if (categoryHasTopology(leaf.category) && !topoByCategory.has(leaf.category)) {
      try {
        topoByCategory.set(leaf.category, await loadTopology(wiki, { categoryPath: leaf.category }));
      } catch {
        topoByCategory.set(leaf.category, null);
      }
    }
  }

  const moves = [];
  const unresolved = []; // topology flats whose facets can't be derived — never defaulted to root
  for (const leaf of flats) {
    const mtime = (() => {
      try {
        return fs.statSync(leaf.abs).mtime;
      } catch {
        return new Date();
      }
    })();
    const topo = categoryHasTopology(leaf.category) ? topoByCategory.get(leaf.category) : null;
    if (categoryHasTopology(leaf.category) && !topo) {
      unresolved.push(relPosix(wiki, leaf.abs));
      continue;
    }
    const meta = leafMemoryOf(leaf.abs);
    const toRel = targetRelFor({ category: leaf.category, name: leaf.name, abs: leaf.abs, meta, mtime, topo });
    if (toRel === null) {
      // FAIL LOUD per file (recorded, not thrown — never crash --check/--dry-run
      // and never default a topology leaf to the category root).
      unresolved.push(relPosix(wiki, leaf.abs));
      continue;
    }
    moves.push({
      from: relPosix(wiki, leaf.abs),
      to: toRel,
      abs: leaf.abs,
      destAbs: path.join(wiki, toRel.split("/").join(path.sep)),
    });
  }

  if (check) {
    return {
      ok: flats.length === 0,
      mode: "check",
      flatCount: flats.length,
      flat: moves.map((m) => m.from),
      unresolved,
    };
  }
  if (dryRun) {
    const wouldConflict = moves.filter((m) => fs.existsSync(m.destAbs)).map(({ from, to }) => ({ from, to }));
    return {
      ok: wouldConflict.length === 0 && unresolved.length === 0,
      mode: "dry-run",
      flatCount: flats.length,
      moves: moves.map(({ from, to }) => ({ from, to })),
      conflicts: wouldConflict,
      unresolved,
    };
  }

  seedContractIfAbsent(wiki);

  const applied = [];
  const conflicts = [];
  for (const m of moves) {
    // Never clobber an existing destination. If a leaf with the same basename
    // already lives at the target path (a same-named nested leaf, or a
    // re-introduced flat copy), renaming onto it would overwrite it (data loss
    // on POSIX) or abort the whole run (Windows EEXIST). Skip and record it so
    // the caller can resolve it by hand; the rest of the migration proceeds.
    if (fs.existsSync(m.destAbs)) {
      conflicts.push({ from: m.from, to: m.to });
      continue;
    }
    fs.mkdirSync(path.dirname(m.destAbs), { recursive: true });
    fs.renameSync(m.abs, m.destAbs);
    renameEmbedding(m.from, m.to); // content unchanged, so keep the cached vector
    recordWikiChange({
      action: "relocated",
      leafRelPath: m.to,
      reason: "migrate-nest from flat category root",
      extraPaths: [m.from],
    });
    applied.push({ from: m.from, to: m.to, destAbs: m.destAbs });
  }

  // No ancestor-prune here: flatLeaves() only moves leaves sitting at the
  // CATEGORY ROOT into subdirs, and a category root never empties — so a
  // move can never orphan a dir. (Mis-placed already-nested leaves are out of
  // scope for nest.)
  let validation = { ok: true, errors: 0, warnings: 0 };
  if (applied.length > 0) {
    ensureIndexes(wiki, applied.map((m) => m.destAbs));
    validation = validate(wiki);
  }

  return {
    ok: validation.ok && conflicts.length === 0 && unresolved.length === 0,
    mode: "migrate",
    moved: applied.length,
    moves: applied.map(({ from, to }) => ({ from, to })),
    conflicts,
    unresolved,
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
  const res = await migrateNest({ dryRun: process.argv.includes("--dry-run"), check: process.argv.includes("--check") });
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  if (res.mode === "check" && !res.ok) process.exit(3);
  if (res.mode === "migrate" && !res.ok) process.exit(2);
}

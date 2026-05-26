import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import matter from "gray-matter";
import { MEMORY_DIR, wikiRoot } from "./lib/env.mjs";
import { CATEGORIES, placementDirForMeta, renameEmbedding } from "./lib/wiki-store.mjs";
import { ensureIndexes, validate } from "./lib/wiki-cli.mjs";
import { dailyDatePath, parseDailyDocName } from "./lib/slug.mjs";

// One-shot, idempotent migration: move FLAT leaves (files sitting directly in a
// category root) into the nested layout the writer now produces. The target dir
// is computed the SAME way as a fresh write - placementDirForMeta for facet
// categories, date for daily - by reading each leaf's own frontmatter `memory`
// block, so the result is deterministic and matches new writes exactly.
//
// `--check` reports flat leaves without mutating (CI/preflight guard); `--dry-run`
// lists the planned moves without mutating. A clean wiki is a no-op (aside from a
// contract refresh on a real run).

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

// Target relative dir for a flat leaf, mirroring placementDir's two branches.
function targetDirFor(category, name, meta, mtime) {
  if (category === "daily") {
    const parsed = parseDailyDocName(name);
    const datePath = parsed ? parsed.date.split("-").join("/") : dailyDatePath(mtime);
    return `daily/${datePath}`;
  }
  return placementDirForMeta(category, meta) ?? category;
}

// Files sitting directly in a category root (not index.md, not dotfiles, not
// already in a subdirectory). Subdirectories are skipped: they are already nested.
function flatLeaves(wiki) {
  const out = [];
  for (const cat of CATEGORIES) {
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

function refreshContract(wiki) {
  const tmpl = path.join(MEMORY_DIR, "templates", "llmwiki.layout.yaml");
  if (!fs.existsSync(tmpl)) return;
  const dest = path.join(wiki, "layout", "layout.yaml");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(tmpl, dest);
}

export function migrateNest({ wiki = wikiRoot(), dryRun = false, check = false } = {}) {
  const flats = flatLeaves(wiki);
  const moves = flats.map((leaf) => {
    const mtime = (() => {
      try {
        return fs.statSync(leaf.abs).mtime;
      } catch {
        return new Date();
      }
    })();
    const meta = leafMemoryOf(leaf.abs);
    const dir = targetDirFor(leaf.category, leaf.name, meta, mtime);
    return { from: relPosix(wiki, leaf.abs), to: `${dir}/${leaf.name}`, abs: leaf.abs, destAbs: path.join(wiki, dir.split("/").join(path.sep), leaf.name) };
  });

  if (check) {
    return { ok: flats.length === 0, mode: "check", flatCount: flats.length, flat: moves.map((m) => m.from) };
  }
  if (dryRun) {
    const wouldConflict = moves.filter((m) => fs.existsSync(m.destAbs)).map(({ from, to }) => ({ from, to }));
    return {
      ok: wouldConflict.length === 0,
      mode: "dry-run",
      flatCount: flats.length,
      moves: moves.map(({ from, to }) => ({ from, to })),
      conflicts: wouldConflict,
    };
  }

  refreshContract(wiki);

  const applied = [];
  const conflicts = [];
  for (const m of moves) {
    // Never clobber an existing destination. If a leaf with the same basename
    // already lives at the target facet path (a same-named nested leaf, or a
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
    applied.push({ from: m.from, to: m.to, destAbs: m.destAbs });
  }

  let validation = { ok: true, errors: 0, warnings: 0 };
  if (applied.length > 0) {
    ensureIndexes(wiki, applied.map((m) => m.destAbs));
    validation = validate(wiki);
  }

  return {
    ok: validation.ok && conflicts.length === 0,
    mode: "migrate",
    moved: applied.length,
    moves: applied.map(({ from, to }) => ({ from, to })),
    conflicts,
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
  const res = migrateNest({ dryRun: process.argv.includes("--dry-run"), check: process.argv.includes("--check") });
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  if (res.mode === "check" && !res.ok) process.exit(3);
  if (res.mode === "migrate" && !res.ok) process.exit(2);
}

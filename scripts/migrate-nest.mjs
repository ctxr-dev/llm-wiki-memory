import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { wikiRoot } from "./lib/env.mjs";
import { categoryHasTopology, renameEmbedding } from "./lib/wiki-store.mjs";
import { ensureIndexes, validate } from "./lib/wiki-cli.mjs";
import { loadTopology } from "./lib/topology-runtime.mjs";
import { recordWikiChange, withWikiCommit } from "./lib/wiki-commit.mjs";
import { withFsRetry } from "./lib/fs-retry.mjs";
import {
  relPosix,
  leafMemoryOf,
  targetRelFor,
  flatLeaves,
  seedContractIfAbsent,
} from "./migrate-nest-helpers.mjs";
import { helpGuard, formatHelp, docsUrl } from "./lib/cli-args.mjs";

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

/** @typedef {import("./lib/topology-loader.mjs").Topology} Topology */
/** @typedef {import("./migrate-nest-helpers.mjs").Move} Move */

/**
 * The result of a nest run, discriminated by `mode`.
 * @typedef {Object} MigrateNestResult
 * @property {boolean} ok
 * @property {string} mode
 * @property {number} [flatCount]
 * @property {string[]} [flat]
 * @property {string[]} unresolved
 * @property {Array<{ from: string, to: string }>} [moves]
 * @property {Array<{ from: string, to: string }>} [conflicts]
 * @property {number} [moved]
 * @property {{ ok: boolean, errors: number, warnings: number }} [validate]
 */

/**
 * @param {{ wiki?: string, dryRun?: boolean, check?: boolean }} [opts]
 * @returns {Promise<MigrateNestResult>}
 */
export function migrateNest(opts = {}) {
  const wiki = opts.wiki || wikiRoot();
  // One nest run = one commit; --check/--dry-run record nothing, so their
  // batch flushes empty and no commit happens.
  return /** @type {Promise<MigrateNestResult>} */ (
    withWikiCommit({ op: "migrate-nest", actor: "migrate-nest", rootDir: wiki }, () =>
      migrateNestInner({ ...opts, wiki }),
    )
  );
}

/**
 * @param {{ wiki?: string, dryRun?: boolean, check?: boolean }} [opts]
 * @returns {Promise<MigrateNestResult>}
 */
async function migrateNestInner({ wiki = wikiRoot(), dryRun = false, check = false } = {}) {
  const flats = flatLeaves(wiki);
  // Load the topology ONCE if any flat sits in a topology category. loadTopology
  // is async + cached by mtime; targetDirFor stays sync per item.
  /** @type {Map<string, Topology | null>} */
  const topoByCategory = new Map();
  for (const leaf of flats) {
    if (categoryHasTopology(leaf.category) && !topoByCategory.has(leaf.category)) {
      try {
        topoByCategory.set(
          leaf.category,
          /** @type {Topology} */ (await loadTopology(wiki, { categoryPath: leaf.category })),
        );
      } catch {
        topoByCategory.set(leaf.category, null);
      }
    }
  }

  /** @type {Move[]} */
  const moves = [];
  /** @type {string[]} */
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
    const toRel = targetRelFor({
      category: leaf.category,
      name: leaf.name,
      abs: leaf.abs,
      meta,
      mtime,
      topo,
    });
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
    const wouldConflict = moves
      .filter((m) => fs.existsSync(m.destAbs))
      .map(({ from, to }) => ({ from, to }));
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

  /** @type {Array<{ from: string, to: string, destAbs: string }>} */
  const applied = [];
  /** @type {Array<{ from: string, to: string }>} */
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
    withFsRetry(() => fs.mkdirSync(path.dirname(m.destAbs), { recursive: true }));
    withFsRetry(() => fs.renameSync(m.abs, m.destAbs));
    renameEmbedding(m.from, m.to); // content unchanged, so keep the cached vector
    recordWikiChange(
      /** @type {Parameters<typeof recordWikiChange>[0]} */ (
        /** @type {unknown} */ ({
          action: "relocated",
          leafRelPath: m.to,
          reason: "migrate-nest from flat category root",
          extraPaths: [m.from],
        })
      ),
    );
    applied.push({ from: m.from, to: m.to, destAbs: m.destAbs });
  }

  // No ancestor-prune here: flatLeaves() only moves leaves sitting at the
  // CATEGORY ROOT into subdirs, and a category root never empties — so a
  // move can never orphan a dir. (Mis-placed already-nested leaves are out of
  // scope for nest.)
  let validation = { ok: true, errors: 0, warnings: 0 };
  if (applied.length > 0) {
    ensureIndexes(
      wiki,
      applied.map((m) => m.destAbs),
    );
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
  const HELP = formatHelp({
    name: "migrate-nest",
    summary:
      "one-shot relocation of flat leaves sitting at a category root into the nested (facet/date/topology) layout the writer now produces",
    usage: "node scripts/migrate-nest.mjs [--dry-run | --check]",
    docs: docsUrl("AI-INSTALL-PROMPT.md"),
  });
  helpGuard(process.argv.slice(2), HELP);
  const res = await migrateNest({
    dryRun: process.argv.includes("--dry-run"),
    check: process.argv.includes("--check"),
  });
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  if (res.mode === "check" && !res.ok) process.exit(3);
  if (res.mode === "migrate" && !res.ok) process.exit(2);
}

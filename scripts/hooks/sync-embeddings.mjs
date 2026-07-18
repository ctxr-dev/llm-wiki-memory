// After a host-repo git merge/checkout/rewrite, refresh the SHARED (ownership:
// repo) categories: warm their embedding caches AND rebuild the index.md tree
// (via @ctxr/skill-llm-wiki — deterministic, so an already-correct tree rewrites
// byte-identically; only a merge-mangled index shows a diff, the desired repair).
// Work is routed through a durable per-wiki job queue and self-drained by the
// firing hook, so rapid branch-switching coalesces and a killed run is retried,
// never lost. Always detached + best-effort: never blocks or fails the git op;
// lazy-embed at search + next-write index rebuild are the correctness net. If the
// queue backend (better-sqlite3) can't load, the work runs directly instead.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { withWikiRoot, embedCacheFor, envValue, envBool, SYNC_QUEUE_PATH } from "../lib/env.mjs";
import { loadCache, saveCache, getTokenizer } from "../lib/embed.mjs";
import { cachedLeafVectors } from "../lib/embed-chunk.mjs";
import { embedChunk } from "../lib/settings.mjs";
import { walkLeaves, readLeaf, isActive, embedTextForLeaf, leafMemory } from "../lib/wiki-core.mjs";
import { isLeafFull } from "../lib/wiki-layout-state.mjs";
import { indexRebuildAll, ensureIndexes } from "../lib/wiki-cli.mjs";
import { toRel } from "../lib/wiki-identity.mjs";
import { mergedLayoutForRoot, sharedCategories } from "../lib/wiki-ownership.mjs";

/**
 * The shared category a changed repo-relative path belongs to, or "" when the
 * path is not a leaf under `<mount>/.llm-wiki-memory/wiki/<category>/…`.
 * @param {string} p
 * @returns {string}
 */
function categoryFromMountPath(p) {
  const segs = String(p || "")
    .split(/[\\/]+/)
    .filter((s) => s && s !== ".");
  // Anchor on the mount marker `.llm-wiki-memory`, NOT a bare `wiki` segment: a
  // repo can have its own `wiki/` dir on the path to the mount (e.g. a subpackage
  // mount at `<repo>/wiki/.llm-wiki-memory/…`), and `indexOf("wiki")` would then
  // match that spurious leading segment and mis-detect (or miss) the category.
  const i = segs.indexOf(".llm-wiki-memory");
  if (i < 0 || segs[i + 1] !== "wiki" || i + 2 >= segs.length) return "";
  return segs[i + 2];
}

/**
 * Warm one category's embedding cache by embedding every active leaf under it.
 * Runs inside a `withWikiRoot` frame so `toRel` keys ids against `wikiRootDir`.
 * @param {string} wikiRootDir
 * @param {string} category
 * @returns {Promise<number>} count of leaves embedded
 */
async function warmCategory(wikiRootDir, category) {
  const cachePath = embedCacheFor(wikiRootDir, category);
  const cache = loadCache(cachePath);
  /** @type {{ id: string, embedText: string, body: string, full: boolean }[]} */
  const items = [];
  for (const leaf of walkLeaves(path.join(wikiRootDir, category))) {
    let data, body;
    try {
      ({ data, body } = readLeaf(leaf));
    } catch (err) {
      // Parity with searchOneTree: an unreadable leaf (git-conflicted YAML in a
      // shared leaf) must not abort the whole warm — skip it with a breadcrumb
      // (lazy embed-at-search time is the correctness net).
      console.error(
        `[sync-embeddings] skipping unreadable leaf ${toRel(leaf)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!isActive(data)) continue;
    // Resolve `full` here IDENTICALLY to searchOneTree so warm + search agree on
    // the chunk count (a mismatch would cause needless re-embed on first search).
    items.push({
      id: toRel(leaf),
      embedText: embedTextForLeaf(data, body),
      body,
      full: isLeafFull(category, leafMemory(data)),
    });
  }
  // One batched forward pass over all changed leaves (bounded internally by
  // embedMany's chunk size). Warm the recall vectors too (needChunks) so a long
  // leaf's chunks are ready, not cold, on the first post-merge search.
  const { enabled, maxChunks, fullMaxChunks } = embedChunk();
  const tokenizer = enabled ? await getTokenizer() : null;
  await cachedLeafVectors(cache, items, { tokenizer, needChunks: true, maxChunks, fullMaxChunks });
  const count = items.length;
  // Best-effort persist (parity with searchOneTree): a READ-ONLY / unwritable
  // shared-repo tree (a teammate consuming another owner's curated memory) must
  // not make the warm THROW — .embeddings/ is gitignored, so persisting would try
  // to create it and fail. The vectors are already cached in-memory for this run;
  // lazy embed-at-search time is the correctness net.
  try {
    saveCache(cachePath, cache);
  } catch (err) {
    console.error(
      `[sync-embeddings] embed-cache persist skipped for ${category} (unwritable tree?): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return count;
}

/** Any LEAF-ANCESTOR dir (leaf's dir up to the wiki root) missing an index.md? */
/** @param {string} leaf @param {string} wikiRootDir @returns {boolean} */
function ancestorMissingIndex(leaf, wikiRootDir) {
  for (let dir = path.dirname(leaf); ; dir = path.dirname(dir)) {
    if (!fs.existsSync(path.join(dir, "index.md"))) return true;
    if (dir === wikiRootDir || path.dirname(dir) === dir) return false;
  }
}

/**
 * Rebuild the (gitignored, per-clone) index.md tree for the shared categories.
 * `indexRebuildAll` refreshes every EXISTING index in one subprocess; then, if any
 * LEAF-ANCESTOR dir lacks an index (a fresh clone, a new dir, or a partially-built
 * tree left by a killed prior run), `ensureIndexes` over ALL shared leaves creates
 * the missing ancestors deepest-first — including an intermediate dir that holds only
 * subdirs. Only leaf-ancestor dirs count (the exact set ensureIndexes can build), so
 * a leaf-less dir never forces an endless rebuild. Refresh and create-missing are
 * INDEPENDENT. Best-effort.
 * @param {string} wikiRootDir @param {string[]} sharedCats
 */
function rebuildIndexTree(wikiRootDir, sharedCats) {
  try {
    indexRebuildAll(wikiRootDir);
  } catch (err) {
    console.error(
      `[sync-embeddings] index refresh skipped (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  /** @type {string[]} */
  const leaves = [];
  let missing = false;
  for (const cat of sharedCats) {
    const catRoot = path.join(wikiRootDir, cat);
    if (!fs.existsSync(catRoot)) continue;
    for (const leaf of walkLeaves(catRoot)) {
      leaves.push(leaf);
      if (!missing && ancestorMissingIndex(leaf, wikiRootDir)) missing = true;
    }
  }
  if (missing && leaves.length) ensureIndexes(wikiRootDir, leaves);
}

/**
 * The queue WORKER: a full refresh of one mount's shared tree — warm every shared
 * category (the embed cache skips unchanged leaves by content-hash, so warming all
 * is cheap) + rebuild the index.md tree. Jobs are detail-less, so this refreshes
 * the whole shared tree. Best-effort throughout.
 * @param {string} mountDir
 * @returns {Promise<{ warmed: string[], indexed: boolean }>}
 */
async function runSyncJob(mountDir) {
  const wikiRootDir = path.join(mountDir, ".llm-wiki-memory", "wiki");
  if (!fs.existsSync(wikiRootDir)) return { warmed: [], indexed: false };
  const shared = [...sharedCategories(mergedLayoutForRoot(wikiRootDir))];
  if (shared.length === 0) return { warmed: [], indexed: false };
  return withWikiRoot(wikiRootDir, async () => {
    /** @type {string[]} */
    const warmed = [];
    for (const cat of shared) {
      await warmCategory(wikiRootDir, cat);
      warmed.push(cat);
    }
    let indexed = false;
    try {
      rebuildIndexTree(wikiRootDir, shared);
      indexed = true;
    } catch (err) {
      console.error(
        `[sync-embeddings] index rebuild skipped (${err instanceof Error ? err.message : String(err)}): next write/validate heals`,
      );
    }
    return { warmed, indexed };
  });
}

/**
 * Enqueue a detail-less job for the wiki and self-drain the durable queue. Falls
 * back to a direct run when the queue is disabled (`LWM_SYNC_NO_QUEUE`) or its
 * backend (better-sqlite3) can't load / its dir is unwritable.
 * @param {string} mountDir @param {string} wikiRootDir
 * @returns {Promise<{ ok: boolean, queued: boolean, warmed: string[], indexed: boolean }>}
 */
async function refreshViaQueue(mountDir, wikiRootDir) {
  if (!envBool("LWM_SYNC_NO_QUEUE", false)) {
    try {
      const { openQueue } = await import("../lib/sync-queue.mjs");
      const q = openQueue(envValue("LWM_SYNC_QUEUE_PATH", SYNC_QUEUE_PATH));
      try {
        q.enqueue(wikiRootDir, mountDir);
        /** @type {{ warmed: string[], indexed: boolean }[]} */
        const runs = [];
        await q.drain(async (job) => {
          runs.push(await runSyncJob(job.mount_dir));
        });
        return {
          ok: true,
          queued: true,
          warmed: runs.flatMap((r) => r.warmed),
          indexed: runs.some((r) => r.indexed),
        };
      } finally {
        try {
          q.close();
        } catch {
          /* a close error must not discard a successful drain / trigger a redundant run */
        }
      }
    } catch (err) {
      console.error(
        `[sync-embeddings] queue unavailable (${err instanceof Error ? err.message : String(err)}); running directly`,
      );
    }
  }
  const r = await runSyncJob(mountDir);
  return { ok: true, queued: false, ...r };
}

/**
 * Gate a git event: act only if a SHARED category changed (or a degenerate range),
 * then enqueue + drain the durable refresh. `full` covers an unresolvable range.
 * @param {{ mountDir?: string, changedPaths?: string[], full?: boolean }} [args]
 * @returns {Promise<{ ok: boolean, queued?: boolean, warmed?: string[], indexed?: boolean, skipped?: string }>}
 */
export async function syncEmbeddings({ mountDir, changedPaths = [], full = false } = {}) {
  const wikiRootDir = path.join(String(mountDir || ""), ".llm-wiki-memory", "wiki");
  if (!mountDir || !fs.existsSync(wikiRootDir)) return { ok: false, skipped: "no-wiki" };
  const shared = new Set(sharedCategories(mergedLayoutForRoot(wikiRootDir)));
  if (shared.size === 0) return { ok: true, warmed: [] };
  const changed =
    full ||
    (changedPaths || []).some((p) => {
      const cat = categoryFromMountPath(p);
      return Boolean(cat) && shared.has(cat);
    });
  if (!changed) return { ok: true, warmed: [] };
  return refreshViaQueue(String(mountDir), wikiRootDir);
}

/**
 * Changed repo-relative paths for a git event. Returns `full:true` when NO range
 * resolves (root commit / shallow clone / ORIG_HEAD unset|==HEAD) so the caller warms
 * every shared category instead of silently missing changes; `full:false` with a
 * (possibly empty) `paths` list when a range DID resolve — an empty list there is a
 * legitimate "nothing shared changed".
 * @param {string} cwd
 * @param {string[]} argv git hook arguments (e.g. post-checkout prev/new SHAs)
 * @returns {{ paths: string[], full: boolean }}
 */
export function changedPathsFromGit(cwd, argv) {
  const shas = argv.filter((a) => /^[0-9a-f]{7,64}$/i.test(a));
  const primary = shas.length >= 2 ? `${shas[0]}..${shas[1]}` : "ORIG_HEAD..HEAD";
  for (const range of [primary, "HEAD~1..HEAD"]) {
    // `-z` disables git's C-quoting of non-ASCII/space paths (NUL-separated raw
    // bytes instead), so a changed leaf like `knowledge/café.md` parses to its
    // real category rather than a quoted string that fails categoryFromMountPath.
    const r = spawnSync("git", ["-C", cwd, "diff", "--name-only", "-z", range], {
      encoding: "utf8",
    });
    if (r.status === 0) return { paths: r.stdout.split("\0").filter(Boolean), full: false };
  }
  return { paths: [], full: true };
}

async function mainCli() {
  try {
    // The installed hook prepends the mount dir as an ABSOLUTE first arg, so a
    // subpackage mount BELOW the git root (git fires hooks with cwd = the
    // worktree root, not the mount) is still warmed. Git never passes an
    // absolute path as its own first hook arg (SHAs / flags / command names), so
    // this is unambiguous; an old hook without it falls back to cwd (unchanged).
    const argv = process.argv.slice(2);
    const hasMountArg = argv[0] && path.isAbsolute(argv[0]);
    const mountDir = hasMountArg ? argv[0] : process.cwd();
    const gitArgs = hasMountArg ? argv.slice(1) : argv;
    const { paths, full } = changedPathsFromGit(mountDir, gitArgs);
    await syncEmbeddings({ mountDir, changedPaths: paths, full });
  } catch {
    /* best-effort: a sync hook must never fail a git operation */
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mainCli();
  process.exit(0);
}

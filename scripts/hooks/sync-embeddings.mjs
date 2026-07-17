// Best-effort re-embed of changed SHARED wiki categories after a host-repo git
// merge/checkout/rewrite (Phase G). It only WARMS the per-category embedding
// caches for the shared categories that actually changed, so the first search
// after a pull isn't a cold re-embed. Lazy-embed at search time remains the
// correctness net — this hook is a latency optimisation and is always
// best-effort: it never fails or blocks the git operation.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { withWikiRoot, embedCacheFor } from "../lib/env.mjs";
import { loadCache, saveCache, getTokenizer } from "../lib/embed.mjs";
import { cachedLeafVectors } from "../lib/embed-chunk.mjs";
import { embedChunk } from "../lib/settings.mjs";
import { walkLeaves, readLeaf, isActive, embedTextForLeaf } from "../lib/wiki-core.mjs";
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
  /** @type {{ id: string, embedText: string, body: string }[]} */
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
    items.push({ id: toRel(leaf), embedText: embedTextForLeaf(data, body), body });
  }
  // One batched forward pass over all changed leaves (bounded internally by
  // embedMany's chunk size). Warm the recall vectors too (needChunks) so a long
  // leaf's chunks are ready, not cold, on the first post-merge search.
  const { enabled, maxChunks } = embedChunk();
  const tokenizer = enabled ? await getTokenizer() : null;
  await cachedLeafVectors(cache, items, { tokenizer, needChunks: true, maxChunks });
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

/**
 * Re-embed the SHARED (ownership: repo) categories that changed in a git event.
 * When `full` is set, warm EVERY shared category (used for a degenerate git range).
 * @param {{ mountDir?: string, changedPaths?: string[], full?: boolean }} [args]
 * @returns {Promise<{ ok: boolean, warmed?: string[], skipped?: string }>}
 */
export async function syncEmbeddings({ mountDir, changedPaths = [], full = false } = {}) {
  const wikiRootDir = path.join(String(mountDir || ""), ".llm-wiki-memory", "wiki");
  if (!mountDir || !fs.existsSync(wikiRootDir)) return { ok: false, skipped: "no-wiki" };
  const shared = new Set(sharedCategories(mergedLayoutForRoot(wikiRootDir)));
  if (shared.size === 0) return { ok: true, warmed: [] };
  /** @type {Set<string>} */
  let changed;
  if (full) {
    // Degenerate git range (root/shallow/ORIG_HEAD-unset) — we can't tell what changed,
    // so warm EVERY shared category rather than silently skip (embeddings must not go stale).
    changed = shared;
  } else {
    changed = new Set();
    for (const p of changedPaths || []) {
      const cat = categoryFromMountPath(p);
      if (cat && shared.has(cat)) changed.add(cat);
    }
  }
  if (changed.size === 0) return { ok: true, warmed: [] };
  return withWikiRoot(wikiRootDir, async () => {
    /** @type {string[]} */
    const warmed = [];
    for (const cat of changed) {
      await warmCategory(wikiRootDir, cat);
      warmed.push(cat);
    }
    return { ok: true, warmed };
  });
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

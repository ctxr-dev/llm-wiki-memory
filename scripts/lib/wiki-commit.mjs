// Auto-commit layer for the wiki's own git repo.
//
// Every wiki mutation funnels through the wiki-store writers, which call
// recordWikiChange() after the bytes land on disk. Orchestrators (MCP tool
// handlers, the flush worker, compile, consolidate, plan-sync, migrate-nest)
// wrap their run in withWikiCommit() so a whole logical operation becomes ONE
// commit whose body lists every touched leaf with its action and reason.
// A write outside any frame commits immediately as a one-leaf operation.
//
// Safety properties (each one is load-bearing):
// - Commits go ONLY to the wiki's own repository: the probe requires
//   `git rev-parse --show-toplevel` to equal the wiki root. Without its own
//   .git, `git -C <wiki>` would resolve to the enclosing WORKSPACE repo and
//   auto-commit the user's project — never acceptable.
// - Best-effort: a git failure never fails the write path. Failures leave a
//   breadcrumb in state/.wiki-commit.log and the next commit's directory-set
//   staging folds the uncommitted delta in.
// - The probe result is cached per root, so wikis without a repo (every test
//   workspace) cost one existsSync and zero git spawns per process.
//
// The low-level git plumbing (runGit, gitUsable, buildDirset, stageAll,
// buildMessage, commitWithRetry, breadcrumb) lives in wiki-commit-git.mjs;
// this module owns the batch state and the public API.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { wikiRoot } from "./env.mjs";
import { wikiAutoCommit } from "./settings.mjs";
import { partitionEntriesForCommit } from "./wiki-ownership.mjs";
import {
  oneLine,
  gitUsable,
  runGit,
  buildDirset,
  stageAll,
  buildMessage,
  commitWithRetry,
  breadcrumb,
  _resetGitProbeCache,
} from "./wiki-commit-git.mjs";

export { _resetGitProbeCache };

/**
 * @typedef {Object} CommitEntry
 * @property {string} action
 * @property {string} leafRelPath
 * @property {string} reason
 * @property {string[]} extraPaths
 * @property {string} [rootDir] absolute wiki root this entry's paths are relative to (M5: a batch may span roots)
 */

/**
 * @typedef {Object} CommitBatch
 * @property {string} op
 * @property {string} actor
 * @property {string} summary
 * @property {boolean} noCommit
 * @property {string} rootDir
 * @property {boolean} flushed
 * @property {CommitEntry[]} entries
 */

/**
 * @typedef {Object} CommitMeta
 * @property {string} [op]
 * @property {string} [actor]
 * @property {string} [summary]
 * @property {boolean} [noCommit]
 * @property {string} [rootDir]
 */

/**
 * @typedef {Object} WikiChangeInput
 * @property {string} [action]
 * @property {string} [leafRelPath]
 * @property {string} [reason]
 * @property {string[]} [extraPaths]
 */

/** @type {import("node:async_hooks").AsyncLocalStorage<CommitBatch>} */
const STORE = new AsyncLocalStorage();

// Batches that have not flushed yet. A wrapped operation may bail out via
// process.exit() (compile does, on bridge loss mid-loop), which skips the
// promise-resolution flush; the commit path is fully synchronous (spawnSync),
// so an exit hook can still flush whatever was recorded.
/** @type {Set<CommitBatch>} */
const openBatches = new Set();
let exitHookInstalled = false;

/**
 * @param {CommitBatch} batch
 * @returns {void}
 */
function trackBatch(batch) {
  openBatches.add(batch);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const b of [...openBatches]) flushBatch(b, true);
    });
  }
}

// Run `fn` with a fresh commit batch; flush ONE commit when it settles.
// A nested call joins the outer batch (the outer frame owns the commit), so
// e.g. writeMemory's internal supersede-disable lands in the same commit.
// The batch flushes on BOTH resolve and reject: recorded entries reflect
// writes that already landed on disk, and a later failure does not undo them.
/**
 * @param {CommitMeta | undefined} meta
 * @param {() => unknown} fn
 * @returns {unknown}
 */
export function withWikiCommit(meta, fn) {
  if (STORE.getStore()) return fn();
  /** @type {CommitBatch} */
  const batch = {
    op: oneLine(meta?.op) || "memory",
    actor: oneLine(meta?.actor) || "unknown",
    summary: oneLine(meta?.summary),
    noCommit: Boolean(meta?.noCommit),
    // Optional override for callers operating on a non-default wiki root
    // (migrate-nest accepts one); empty string means "use env wikiRoot()".
    rootDir: meta?.rootDir ? String(meta.rootDir) : "",
    flushed: false,
    entries: [],
  };
  trackBatch(batch);
  return STORE.run(batch, () => {
    /** @type {unknown} */
    let result;
    try {
      result = fn();
    } catch (err) {
      flushBatch(batch, true);
      throw err;
    }
    if (result && typeof (/** @type {{ then?: unknown }} */ (result).then) === "function") {
      return /** @type {PromiseLike<unknown>} */ (result).then(
        (value) => {
          flushBatch(batch, false);
          return value;
        },
        (err) => {
          flushBatch(batch, true);
          throw err;
        },
      );
    }
    flushBatch(batch, false);
    return result;
  });
}

/**
 * @param {WikiChangeInput} [change]
 * @returns {void}
 */
export function recordWikiChange({ action, leafRelPath, reason = "", extraPaths = [] } = {}) {
  if (!action || !leafRelPath) return;
  const batch = STORE.getStore();
  // The ABSOLUTE root this write landed under: the batch's explicit override
  // (migrate-nest / plan-sync) or the active wiki root (Phase F routes writes
  // to different levels within one batch, so it is captured per entry).
  const absRoot = batch?.rootDir || wikiRoot();
  const entry = {
    action: oneLine(action),
    leafRelPath: toRel(leafRelPath, absRoot),
    reason: oneLine(reason),
    extraPaths: (extraPaths || []).filter(Boolean).map((p) => toRel(p, absRoot)),
    rootDir: absRoot,
  };
  if (batch) {
    batch.entries.push(entry);
    return;
  }
  flushBatch(
    {
      op: "memory",
      actor: "direct",
      summary: "",
      noCommit: false,
      rootDir: "",
      flushed: false,
      entries: [entry],
    },
    false,
  );
}

/**
 * @param {string} p
 * @param {string} base
 * @returns {string}
 */
function toRel(p, base) {
  const s = String(p || "");
  // A leaf's wiki-relative path is a forward-slash id on every OS (it becomes a
  // git pathspec); path.relative emits backslashes on Windows.
  return path.isAbsolute(s)
    ? path
        .relative(base || wikiRoot(), s)
        .split(path.sep)
        .join("/")
    : s;
}

/**
 * @returns {boolean}
 */
function autoCommitEnabled() {
  // A broken settings load must not produce git side effects: default OFF.
  try {
    return wikiAutoCommit();
  } catch {
    return false;
  }
}

/**
 * @param {CommitBatch | undefined} batch
 * @param {boolean} failed
 * @returns {void}
 */
function flushBatch(batch, failed) {
  try {
    if (!batch || batch.flushed) return;
    batch.flushed = true;
    openBatches.delete(batch);
    if (batch.noCommit || batch.entries.length === 0) return;
    if (!autoCommitEnabled()) return;
    const fallbackRoot = batch.rootDir || wikiRoot();
    // V3/R20: drop shared (repo-owned) leaves — the engine never stages, let
    // alone commits, a shared repo. M5: group the survivors by their owning wiki
    // root so a single `git add`/commit never spans two roots.
    for (const [rootDir, entries] of partitionEntriesForCommit(batch.entries, fallbackRoot)) {
      if (!gitUsable(rootDir)) continue;
      const specs = buildDirset(rootDir, entries);
      if (specs.length === 0) continue;
      if (!stageAll(rootDir, specs)) {
        breadcrumb(`staging failed for op=${batch.op} (${specs.length} pathspec(s))`);
        continue;
      }
      // diff --cached --quiet exits 0 when nothing is staged (dry-run passes,
      // content-identical rewrites): skip the empty commit silently.
      if (runGit(rootDir, ["diff", "--cached", "--quiet"]).status === 0) continue;
      commitWithRetry(rootDir, buildMessage({ ...batch, entries }, failed));
    }
  } catch (err) {
    breadcrumb(
      `flush error (${oneLine(String(/** @type {{ message?: unknown }} */ (err)?.message || err)).slice(0, 200)})`,
    );
  }
}

// Keep the wiki repo's object store compact. Hourly auto-commits churn many
// index.md blobs and NOTHING else ever gc's a repo that only machines write
// to — without this it grows unbounded. `git gc --auto` is itself
// self-throttling (a no-op below git's loose-object threshold), so the cron
// can call this every tick. Best-effort: gc failure never matters.
export function maybeGcWikiRepo() {
  try {
    if (!autoCommitEnabled()) return;
    const rootDir = wikiRoot();
    if (!gitUsable(rootDir)) return;
    const r = spawnSync("git", ["-C", rootDir, "gc", "--auto", "--quiet"], {
      encoding: "utf8",
      // gc can legitimately take longer than ordinary git ops on a big repo;
      // it is also safe to interrupt, so a timeout kill loses nothing.
      timeout: 120_000,
    });
    if (r.status !== 0 && r.error) {
      breadcrumb(
        `gc --auto failed (${oneLine(String(r.error?.message || r.stderr || r.status)).slice(0, 200)})`,
      );
    }
  } catch (err) {
    breadcrumb(
      `gc error (${oneLine(String(/** @type {{ message?: unknown }} */ (err)?.message || err)).slice(0, 200)})`,
    );
  }
}

export const _internals = { flushBatch, buildMessage, buildDirset, gitUsable, runGit, stageAll };

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
// - recall-touch bookkeeping is git-silent by design: it is telemetry, not an
//   authored edit, and would otherwise produce a commit per search hit.

import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { MEMORY_DATA_DIR, wikiRoot } from "./env.mjs";
import { wikiAutoCommit } from "./settings.mjs";

const STORE = new AsyncLocalStorage();
const RECALL_TOUCH = "recall-touch";
const GIT_TIMEOUT_MS = 10_000;
const MAX_BODY_ENTRIES = 200;
const LOCK_RETRY_DELAYS_MS = [50, 100, 200];

const probeCache = new Map();

const oneLine = (v) => String(v || "").replace(/[\r\n]+/g, " ").trim();

// Batches that have not flushed yet. A wrapped operation may bail out via
// process.exit() (compile does, on bridge loss mid-loop), which skips the
// promise-resolution flush; the commit path is fully synchronous (spawnSync),
// so an exit hook can still flush whatever was recorded.
const openBatches = new Set();
let exitHookInstalled = false;

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
export function withWikiCommit(meta, fn) {
  if (STORE.getStore()) return fn();
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
    let result;
    try {
      result = fn();
    } catch (err) {
      flushBatch(batch, true);
      throw err;
    }
    if (result && typeof result.then === "function") {
      return result.then(
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

export function recordWikiChange({ action, leafRelPath, reason = "", extraPaths = [] } = {}) {
  if (!action || !leafRelPath) return;
  if (reason === RECALL_TOUCH) return;
  const batch = STORE.getStore();
  const base = batch?.rootDir || "";
  const entry = {
    action: oneLine(action),
    leafRelPath: toRel(leafRelPath, base),
    reason: oneLine(reason),
    extraPaths: (extraPaths || []).filter(Boolean).map((p) => toRel(p, base)),
  };
  if (batch) {
    batch.entries.push(entry);
    return;
  }
  flushBatch(
    { op: "memory", actor: "direct", summary: "", noCommit: false, rootDir: "", flushed: false, entries: [entry] },
    false,
  );
}

export function isWikiCommitBatchActive() {
  return Boolean(STORE.getStore());
}

export function _resetGitProbeCache() {
  probeCache.clear();
}

function toRel(p, base) {
  const s = String(p || "");
  return path.isAbsolute(s) ? path.relative(base || wikiRoot(), s) : s;
}

function autoCommitEnabled() {
  // A broken settings load must not produce git side effects: default OFF.
  try {
    return wikiAutoCommit();
  } catch {
    return false;
  }
}

function runGit(rootDir, args, { input } = {}) {
  try {
    const r = spawnSync("git", ["-C", rootDir, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      input,
    });
    if (r.error) return { status: -1, stdout: "", stderr: String(r.error.message || r.error) };
    return r;
  } catch (err) {
    return { status: -1, stdout: "", stderr: String(err?.message || err) };
  }
}

function samePath(a, b) {
  // git prints the symlink-resolved toplevel (macOS: /var/... → /private/var/
  // ...); compare realpaths so a wiki under a symlinked tmp/home still matches.
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function gitUsable(rootDir) {
  // Cache only the POSITIVE result: a repo doesn't vanish, but one can appear
  // later (bootstrap git-inits the wiki while the long-lived MCP server stays
  // up). A cached negative would silently disable auto-commit until restart;
  // re-probing a repo-less wiki costs one existsSync per flush, no git spawn.
  if (probeCache.get(rootDir) === true) return true;
  let usable = false;
  try {
    // .git may be a dir or a worktree gitdir-file; existsSync covers both.
    if (fs.existsSync(path.join(rootDir, ".git"))) {
      const r = runGit(rootDir, ["rev-parse", "--show-toplevel"]);
      usable = r.status === 0 && samePath(oneLine(r.stdout), rootDir);
    }
  } catch {
    usable = false;
  }
  if (usable) probeCache.set(rootDir, true);
  return usable;
}

// Pathspecs that BOUND this batch's blast radius to the touched directories:
// each touched path's parent dir (recursively: the leaf, its sibling
// index.md, prunes) plus every higher ancestor's regenerated index.md, plus
// the wiki-root index.md. A concurrent uncommitted write by ANOTHER process
// into one of these same dirs can be folded in and attributed to this op —
// acceptable for a private audit log. Never a bare "." though: that would
// sweep the entire wiki into every commit.
function buildDirset(rootDir, entries) {
  const specs = new Set();
  for (const e of entries) {
    for (const raw of [e.leafRelPath, ...(e.extraPaths || [])]) {
      const rel = path.normalize(String(raw || ""));
      if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      const dir = path.dirname(rel);
      if (dir === "." || dir === "") {
        specs.add(rel);
      } else {
        specs.add(dir);
        let up = path.dirname(dir);
        while (up && up !== "." && up !== "/") {
          specs.add(path.join(up, "index.md"));
          up = path.dirname(up);
        }
      }
      specs.add("index.md");
    }
  }
  return [...specs].sort();
}

// `git add -A -- <spec>` errors when a spec matches nothing (neither on disk
// nor tracked). Batches mix real paths with maybe-missing ancestors, so try
// the whole set first and fall back to per-spec staging, swallowing the
// no-match failures.
function stageAll(rootDir, specs) {
  const all = runGit(rootDir, ["add", "-A", "--", ...specs]);
  if (all.status === 0) return true;
  let any = false;
  for (const spec of specs) {
    const r = runGit(rootDir, ["add", "-A", "--", spec]);
    if (r.status === 0) any = true;
  }
  return any;
}

function buildMessage(batch, failed) {
  const counts = new Map();
  for (const e of batch.entries) counts.set(e.action, (counts.get(e.action) || 0) + 1);
  const countsStr = [...counts.entries()].map(([a, n]) => `${a} ${n}`).join(", ");
  let subject = `memory(${batch.op}): ${batch.summary || countsStr || "update"}`;
  if (subject.length > 72) subject = `${subject.slice(0, 69)}...`;
  const lines = [subject, ""];
  for (const e of batch.entries.slice(0, MAX_BODY_ENTRIES)) {
    // recordWikiChange already collapses fields; re-collapsing here makes
    // buildMessage injection-safe standalone (a raw batch object cannot
    // forge a trailer line).
    lines.push(`- ${oneLine(e.action)} ${oneLine(e.leafRelPath)}${e.reason ? ` — ${oneLine(e.reason)}` : ""}`);
  }
  if (batch.entries.length > MAX_BODY_ENTRIES) {
    lines.push(`... and ${batch.entries.length - MAX_BODY_ENTRIES} more`);
  }
  if (failed) lines.push("", "Outcome: the operation failed after these writes had already landed");
  lines.push("", `Op: ${batch.op}`, `Actor: ${batch.actor}`, `Leaves: ${batch.entries.length}`);
  return `${lines.join("\n")}\n`;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function commitWithRetry(rootDir, message) {
  for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) sleepMs(LOCK_RETRY_DELAYS_MS[attempt - 1]);
    const r = runGit(
      rootDir,
      [
        "-c", "user.name=llm-wiki-memory",
        "-c", "user.email=memory@llm-wiki-memory.local",
        "-c", "commit.gpgsign=false",
        "commit", "--no-verify", "-F", "-",
      ],
      { input: message },
    );
    if (r.status === 0) return true;
    const err = `${r.stderr || ""}${r.stdout || ""}`;
    if (!/index\.lock|another git process/i.test(err)) {
      breadcrumb(`commit failed (${oneLine(err).slice(0, 200)})`);
      return false;
    }
  }
  breadcrumb("commit gave up after index.lock retries");
  return false;
}

function flushBatch(batch, failed) {
  try {
    if (!batch || batch.flushed) return;
    batch.flushed = true;
    openBatches.delete(batch);
    if (batch.noCommit || batch.entries.length === 0) return;
    if (!autoCommitEnabled()) return;
    const rootDir = batch.rootDir || wikiRoot();
    if (!gitUsable(rootDir)) return;
    const specs = buildDirset(rootDir, batch.entries);
    if (specs.length === 0) return;
    if (!stageAll(rootDir, specs)) {
      breadcrumb(`staging failed for op=${batch.op} (${specs.length} pathspec(s))`);
      return;
    }
    // diff --cached --quiet exits 0 when nothing is staged (dry-run passes,
    // content-identical rewrites): skip the empty commit silently.
    if (runGit(rootDir, ["diff", "--cached", "--quiet"]).status === 0) return;
    commitWithRetry(rootDir, buildMessage(batch, failed));
  } catch (err) {
    breadcrumb(`flush error (${oneLine(String(err?.message || err)).slice(0, 200)})`);
  }
}

function breadcrumb(line) {
  try {
    const p = path.join(MEMORY_DATA_DIR, "state", ".wiki-commit.log");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${new Date().toISOString()} wiki-commit: ${line}\n`);
  } catch {
    /* the breadcrumb itself must never fail the write path */
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
      breadcrumb(`gc --auto failed (${oneLine(String(r.error?.message || r.stderr || r.status)).slice(0, 200)})`);
    }
  } catch (err) {
    breadcrumb(`gc error (${oneLine(String(err?.message || err)).slice(0, 200)})`);
  }
}

export const _internals = { flushBatch, buildMessage, buildDirset, gitUsable, runGit, stageAll };

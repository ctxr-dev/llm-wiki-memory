// Low-level git plumbing for the wiki auto-commit layer.
//
// Everything here talks to the wiki repo via `git -C <rootDir>` or logs a
// breadcrumb; nothing here owns batch state. The orchestration (batches,
// withWikiCommit, flushBatch) lives in wiki-commit.mjs, which composes these
// helpers. Dependency direction is one-way: wiki-commit.mjs -> this module.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MEMORY_DATA_DIR } from "./env.mjs";
import { sharedCategories, mergedLayoutForRoot } from "./wiki-ownership.mjs";

/** @typedef {import("./wiki-commit.mjs").CommitEntry} CommitEntry */
/** @typedef {import("./wiki-commit.mjs").CommitBatch} CommitBatch */

/**
 * @typedef {Object} GitResult
 * @property {number | null} status
 * @property {string} stdout
 * @property {string} stderr
 */

const GIT_TIMEOUT_MS = 10_000;
const MAX_BODY_ENTRIES = 200;
const LOCK_RETRY_DELAYS_MS = [50, 100, 200];

/** @type {Map<string, boolean>} */
const probeCache = new Map();

/** @param {unknown} v @returns {string} */
export const oneLine = (v) =>
  String(v || "")
    .replace(/[\r\n]+/g, " ")
    .trim();

/** @returns {void} */
export function _resetGitProbeCache() {
  probeCache.clear();
}

/**
 * @param {string} rootDir
 * @param {string[]} args
 * @param {{ input?: string }} [opts]
 * @returns {GitResult}
 */
export function runGit(rootDir, args, { input } = {}) {
  try {
    const r = spawnSync("git", ["-C", rootDir, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      input,
    });
    if (r.error) return { status: -1, stdout: "", stderr: String(r.error.message || r.error) };
    return r;
  } catch (err) {
    return {
      status: -1,
      stdout: "",
      stderr: String(/** @type {{ message?: unknown }} */ (err)?.message || err),
    };
  }
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  // git prints the symlink-resolved toplevel (macOS: /var/... → /private/var/
  // ...); compare realpaths so a wiki under a symlinked tmp/home still matches.
  const norm = (/** @type {string} */ p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const ra = norm(a);
  const rb = norm(b);
  if (ra === rb) return true;
  // Windows: `git rev-parse --show-toplevel` prints forward slashes and often a
  // lowercase drive letter (`c:/…`), while realpathSync yields `C:\…`. The FS is
  // case-insensitive, so compare separator- and case-normalized.
  if (process.platform === "win32") {
    const canon = (/** @type {string} */ p) => path.resolve(p).toLowerCase();
    return canon(ra) === canon(rb);
  }
  return false;
}

/**
 * @param {string} rootDir
 * @returns {boolean}
 */
export function gitUsable(rootDir) {
  // Git-safety: a wiki declaring an `ownership: repo` category is a shared mount —
  // never auto-commit it. Refused above the cache so a stray `.git` at the wiki
  // root can't re-enable it; a private brain declares no such category.
  try {
    if (sharedCategories(mergedLayoutForRoot(rootDir)).length > 0) return false;
  } catch {
    /* no readable layout → fall through to the structural probe */
  }
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
/**
 * @param {string} rootDir
 * @param {CommitEntry[]} entries
 * @returns {string[]}
 */
export function buildDirset(rootDir, entries) {
  /** @type {Set<string>} */
  const specs = new Set();
  for (const e of entries) {
    for (const raw of [e.leafRelPath, ...(e.extraPaths || [])]) {
      // Wiki-relative paths AND git pathspecs are ALWAYS forward-slash on every
      // OS — normalize with path.posix. Plain path.normalize/dirname/join emit
      // backslashes on Windows, which `git add -- <spec>` fails to match, so
      // nothing gets staged and the commit silently becomes a no-op.
      const rel = path.posix.normalize(String(raw || "").replace(/\\/g, "/"));
      if (!rel || rel === "." || rel.startsWith("..") || rel.startsWith("/")) continue;
      const dir = path.posix.dirname(rel);
      if (dir === "." || dir === "") {
        specs.add(rel);
      } else {
        specs.add(dir);
        let up = path.posix.dirname(dir);
        while (up && up !== "." && up !== "/") {
          specs.add(path.posix.join(up, "index.md"));
          up = path.posix.dirname(up);
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
/**
 * @param {string} rootDir
 * @param {string[]} specs
 * @returns {boolean}
 */
export function stageAll(rootDir, specs) {
  const all = runGit(rootDir, ["add", "-A", "--", ...specs]);
  if (all.status === 0) return true;
  let any = false;
  for (const spec of specs) {
    const r = runGit(rootDir, ["add", "-A", "--", spec]);
    if (r.status === 0) any = true;
  }
  return any;
}

/**
 * @param {CommitBatch} batch
 * @param {boolean} failed
 * @returns {string}
 */
export function buildMessage(batch, failed) {
  /** @type {Map<string, number>} */
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
    lines.push(
      `- ${oneLine(e.action)} ${oneLine(e.leafRelPath)}${e.reason ? ` — ${oneLine(e.reason)}` : ""}`,
    );
  }
  if (batch.entries.length > MAX_BODY_ENTRIES) {
    lines.push(`... and ${batch.entries.length - MAX_BODY_ENTRIES} more`);
  }
  if (failed) lines.push("", "Outcome: the operation failed after these writes had already landed");
  lines.push("", `Op: ${batch.op}`, `Actor: ${batch.actor}`, `Leaves: ${batch.entries.length}`);
  return `${lines.join("\n")}\n`;
}

/** @param {number} ms @returns {void} */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {string} rootDir
 * @param {string} message
 * @returns {boolean}
 */
export function commitWithRetry(rootDir, message) {
  for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) sleepMs(LOCK_RETRY_DELAYS_MS[attempt - 1]);
    const r = runGit(
      rootDir,
      [
        "-c",
        "user.name=llm-wiki-memory",
        "-c",
        "user.email=memory@llm-wiki-memory.local",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--no-verify",
        "-F",
        "-",
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

/**
 * @param {string} line
 * @returns {void}
 */
export function breadcrumb(line) {
  try {
    const p = path.join(MEMORY_DATA_DIR, "state", ".wiki-commit.log");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${new Date().toISOString()} wiki-commit: ${line}\n`);
  } catch {
    /* the breadcrumb itself must never fail the write path */
  }
}

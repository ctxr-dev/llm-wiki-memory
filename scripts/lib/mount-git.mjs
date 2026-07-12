// Per-mount git primitives for the federated wiki (Phase G).
//
// R11 (user-locked): the engine NEVER commits a shared/host repo. These helpers
// only ever (a) init a PRIVATE git repo for a mount's personal subtree, (b) warn
// when the host repo would shadow the mount, and (c) install a best-effort
// re-embed hook. None of them commits anything into the consuming project.
//
// R9: the personal repo is init'd at `<mount>/.llm-wiki-memory/personal/`, NOT
// at the mount root and NOT per-category — so its `.git` can never sit at (or
// above) the shared wiki root and thus can never make `gitUsable()` true for the
// shared subtree.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.mjs";

const MOUNT_DIRNAME = ".llm-wiki-memory";
// The git-hook events we chain into, and the fence markers wrapping our
// invocation block. Exported so the uninstaller strips the EXACT same block
// (single source of truth for the marker strings).
export const HOOK_EVENTS = ["post-merge", "post-checkout", "post-rewrite"];
export const MARKER_START = "# >>> llm-wiki-memory sync-embeddings >>>";
export const MARKER_END = "# <<< llm-wiki-memory sync-embeddings <<<";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, "../..");
const SYNC_WRAPPER = path.join(SRC_DIR, "scripts", "hooks", "sync-embeddings.sh");

/**
 * Init ONE private git repo under `<mount>/.llm-wiki-memory/personal/` (R9).
 * Idempotent: an existing repo is left untouched.
 * @param {string} mountDir directory that HOLDS the `.llm-wiki-memory` mount
 * @returns {{ ok: boolean, path: string, created: boolean }}
 */
export function initPersonalGit(mountDir) {
  const dir = path.join(mountDir, MOUNT_DIRNAME, "personal");
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(path.join(dir, ".git"))) return { ok: true, path: dir, created: false };
  const r = spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });
  return { ok: r.status === 0, path: dir, created: r.status === 0 };
}

/**
 * Throw an ACTIONABLE error when the enclosing (host) repo already git-ignores
 * the mount (R8). Git will not descend into an ignored directory, so a nested
 * negated `.gitignore` inside the mount can never re-include the shared
 * categories. A mount not inside any git repo (or not ignored) passes.
 * @param {string} mountDir directory that HOLDS the `.llm-wiki-memory` mount
 * @returns {{ ok: true }}
 */
export function assertMountNotHostIgnored(mountDir) {
  const r = spawnSync("git", ["-C", mountDir, "check-ignore", MOUNT_DIRNAME], { encoding: "utf8" });
  // exit 0 => the path IS ignored by the host repo; 1 => not ignored (good);
  // 128 => not a git repo, so there is no host repo to shadow the mount.
  if (r.status === 0 && r.stdout.trim()) {
    const matched = r.stdout.trim().split(/\r?\n/)[0];
    throw new Error(
      `the mount "${MOUNT_DIRNAME}" is git-ignored by the enclosing repo (matched by: ${matched}). ` +
        `Git will not descend into an ignored directory, so the mount's negated .gitignore cannot ` +
        `re-include the shared categories. Fix it: add "!/${MOUNT_DIRNAME}/" to the repo-root .gitignore, ` +
        `or move the mount out of the ignored subtree.`,
    );
  }
  return { ok: true };
}

/**
 * Resolve the effective git hooks directory for a repo, honouring
 * `core.hooksPath` (husky, custom hook managers) so we never clobber it.
 * @param {string} repoDir
 * @returns {string | null} absolute hooks dir, or null when repoDir is not a repo
 */
export function hooksDirFor(repoDir) {
  const cfg = spawnSync("git", ["-C", repoDir, "config", "--get", "core.hooksPath"], {
    encoding: "utf8",
  });
  if (cfg.status === 0 && cfg.stdout.trim()) {
    const hp = cfg.stdout.trim();
    return path.isAbsolute(hp) ? hp : path.join(repoDir, hp);
  }
  const common = spawnSync("git", ["-C", repoDir, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
  });
  if (common.status !== 0) return null;
  const gitDir = common.stdout.trim();
  return path.join(path.isAbsolute(gitDir) ? gitDir : path.join(repoDir, gitDir), "hooks");
}

/**
 * @param {string} target absolute hook-file path
 * @param {string} block the marker-fenced invocation block (newline-terminated)
 * @returns {"created" | "chained" | "present"}
 */
function chainHookFile(target, block) {
  if (fs.existsSync(target)) {
    const content = fs.readFileSync(target, "utf8");
    if (content.includes(MARKER_START)) return "present";
    const sep = content.endsWith("\n") ? "\n" : "\n\n";
    writeFileAtomic(target, `${content}${sep}${block}`, { mode: 0o755 });
    return "chained";
  }
  writeFileAtomic(target, `#!/usr/bin/env bash\n${block}`, { mode: 0o755 });
  return "created";
}

/**
 * Install the sync-embeddings hook into a repo's git-hook path, chained AFTER
 * any existing hook (husky/core.hooksPath preserved — we append a marker-fenced
 * block, never overwrite). Idempotent: a hook already carrying our marker is
 * left untouched. The invocation is best-effort (the wrapper backgrounds and
 * exits 0), so it can never block or fail a merge/checkout.
 * @param {string} repoDir the (host) repo whose hooks fire on merge/checkout
 * @param {{ wrapper?: string }} [opts] override the wrapper path (tests)
 * @returns {{ ok: boolean, hooksDir?: string, results?: Record<string, string>, skipped?: string }}
 */
export function installSyncEmbeddingsHook(repoDir, { wrapper = SYNC_WRAPPER } = {}) {
  const hooksDir = hooksDirFor(repoDir);
  if (!hooksDir) return { ok: false, skipped: "not-a-repo" };
  fs.mkdirSync(hooksDir, { recursive: true });
  const block = `${MARKER_START}\n"${wrapper}" "$@" || true\n${MARKER_END}\n`;
  /** @type {Record<string, string>} */
  const results = {};
  for (const event of HOOK_EVENTS) {
    results[event] = chainHookFile(path.join(hooksDir, event), block);
  }
  return { ok: true, hooksDir, results };
}

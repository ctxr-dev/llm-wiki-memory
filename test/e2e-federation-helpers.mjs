// Shared /tmp scaffolding for the federation end-to-end suite. Real isolated
// `lwm-e2e-*` trees, real git (committer pinned so commits don't depend on the
// host's global git identity), macOS realpath-normalised so path comparisons
// survive the /tmp -> /private/tmp symlink. Every helper is JSDoc-typed (no any).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(SRC, "scripts", "cli.mjs");
export const MOUNT_INIT = path.join(SRC, "scripts", "mount-init.mjs");
export const SKILL_CLI = path.join(SRC, "node_modules/@ctxr/skill-llm-wiki/scripts/cli.mjs");

// Committer identity for deterministic commits (mirrors wiki-commit-federation).
const GIT_ID = ["-c", "user.email=t@t.local", "-c", "user.name=t"];

/**
 * A fresh, symlink-resolved temp directory named `lwm-e2e-<prefix>-*`.
 * @param {string} prefix
 * @returns {string}
 */
export function realTmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `lwm-e2e-${prefix}-`)));
}

/**
 * @param {string[]} dirs
 * @returns {void}
 */
export function rmAll(dirs) {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * @param {string} dir
 * @param {string} rel forward-slash relative path under dir
 * @returns {string} absolute path created
 */
export function mkdirp(dir, rel = "") {
  const abs = rel ? path.join(dir, rel.split("/").join(path.sep)) : dir;
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

/**
 * @param {string} dir
 * @param {string[]} args
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
export function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/**
 * @param {string} dir
 * @returns {void}
 */
export function gitInit(dir) {
  git(dir, ["init", "-q"]);
}

/**
 * Stage everything and record one commit under the pinned identity.
 * @param {string} dir
 * @param {string} message
 * @returns {void}
 */
export function gitCommitAll(dir, message) {
  git(dir, [...GIT_ID, "add", "-A"]);
  git(dir, [...GIT_ID, "commit", "-q", "-m", message]);
}

/**
 * @param {string} dir
 * @returns {number} HEAD commit count (0 when there is no HEAD)
 */
export function commitCount(dir) {
  const r = git(dir, ["rev-list", "--count", "HEAD"]);
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
}

/**
 * @param {string} dir
 * @returns {string[]} tracked paths (git ls-files)
 */
export function lsFiles(dir) {
  return git(dir, ["ls-files"]).stdout.split("\n").filter(Boolean);
}

// `-uall` lists individual untracked FILES rather than collapsing them to the
// shallowest untracked directory, so an assertion can pin the exact leaf path.
/**
 * @param {string} dir
 * @returns {string} porcelain status output (untracked files expanded)
 */
export function porcelain(dir) {
  return git(dir, ["status", "--porcelain", "-uall"]).stdout;
}

// git check-ignore -q: exit 0 => ignored, 1 => not ignored.
/**
 * @param {string} repoDir
 * @param {string} rel
 * @returns {boolean}
 */
export function isIgnored(repoDir, rel) {
  return (
    spawnSync("git", ["-C", repoDir, "check-ignore", "-q", rel], { encoding: "utf8" }).status === 0
  );
}

/**
 * Write a mount's shared layout.yaml, returning the mount's wiki root.
 * @param {string} mountDir directory that HOLDS the `.llm-wiki-memory` mount
 * @param {string} yaml layout.yaml body
 * @returns {string} absolute wiki root (`<mountDir>/.llm-wiki-memory/wiki`)
 */
export function writeMountLayout(mountDir, yaml) {
  const wikiRoot = path.join(mountDir, ".llm-wiki-memory", "wiki");
  const layoutDir = path.join(wikiRoot, ".layout");
  fs.mkdirSync(layoutDir, { recursive: true });
  fs.writeFileSync(path.join(layoutDir, "layout.yaml"), yaml);
  return wikiRoot;
}

/**
 * @param {string} wikiRoot
 * @param {string} rel forward-slash relative leaf path under the wiki root
 * @param {string} body
 * @returns {string} absolute leaf path
 */
export function seedLeafFile(wikiRoot, rel, body) {
  const abs = path.join(wikiRoot, rel.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

/**
 * Base env for a subprocess `cli.mjs` invocation against an isolated data dir.
 * @param {string} dataDir
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function cliEnv(dataDir, extra = {}) {
  return {
    ...process.env,
    MEMORY_DATA_DIR: dataDir,
    LLM_WIKI_SKILL_CLI: SKILL_CLI,
    LLM_WIKI_NO_PROMPT: "1",
    LLM_WIKI_FIXED_TIMESTAMP: "1700000000",
    MEMORY_EMBED_BACKEND: "lexical",
    ...extra,
  };
}

/**
 * @param {string} dataDir
 * @returns {void} write a lexical settings.yaml so no embedding model downloads.
 */
export function writeLexicalSettings(dataDir) {
  const dir = path.join(dataDir, "settings");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.yaml"), "embed:\n  backend: lexical\n");
}

/**
 * @param {string} dataDir
 * @param {string[]} args extra `init` argv (e.g. ["--template", "repo"])
 * @param {Record<string, string>} [extraEnv]
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
export function runInit(dataDir, args = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, "init", ...args], {
    encoding: "utf8",
    env: cliEnv(dataDir, extraEnv),
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

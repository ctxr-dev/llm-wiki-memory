// Shared /tmp scaffolding for the federation end-to-end suite. Real isolated
// `lwm-e2e-*` trees, real git (committer pinned so commits don't depend on the
// host's global git identity), macOS realpath-normalised so path comparisons
// survive the /tmp -> /private/tmp symlink. Every helper is JSDoc-typed (no any).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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

/**
 * @typedef {"default"|"repo"|"tracker-issues"} TemplateName
 * @typedef {{ rel: string, template?: TemplateName, local?: string }} MountSpec
 * @typedef {{ rel: string, dir: string, wikiRoot: string, template: TemplateName }} BuiltMount
 * @typedef {{ home: string, brainDataDir: string, brainWiki: string, mounts: BuiltMount[], restore: () => void }} FakeHome
 * @typedef {{ seeded?: string, gitignore?: boolean, personalGit?: { created: boolean, path: string, ok?: boolean }, hostIgnore?: { ok: boolean, message?: string }, syncHook?: { ok: boolean, hooksDir: string, results: Record<string, string> }, skipped?: string }} MountResult
 * @typedef {{ rel: string, dir: string, result: MountResult, wikiRoot: string }} NestedMount
 */

/**
 * @param {string} prefix
 * @param {string[]} tmps sink for cleanup (dirs pushed here)
 * @returns {string} a fresh realpath'd HOME with process.env.HOME pointed at it
 */
export function freshHome(prefix, tmps) {
  const home = realTmp(prefix);
  tmps.push(home);
  // os.homedir() honours $HOME → the real scanner default resolves under /tmp.
  process.env.HOME = home;
  return home;
}

// Engine modules are imported LAZILY (inside the builders, not at file top):
// a top-level import of mount-init/layout-template perturbs shared module state
// enough to change consolidate behaviour in sibling e2e files — imports here
// must stay side-effect-free for callers that only want the fs/git helpers.
/**
 * @param {string} mountDir directory holding `.llm-wiki-memory`
 * @param {TemplateName} template
 * @param {string} [local] optional layout.local.yaml body
 * @returns {Promise<string>} wiki root
 */
async function installWiki(mountDir, template, local) {
  const { installLayoutTemplate } = await import("../../scripts/lib/layout-template.mjs");
  const wikiRoot = path.join(mountDir, ".llm-wiki-memory", "wiki");
  const layoutDir = path.join(wikiRoot, ".layout");
  installLayoutTemplate(layoutDir, template);
  if (local != null) fs.writeFileSync(path.join(layoutDir, "layout.local.yaml"), local);
  return wikiRoot;
}

/**
 * Build a realpath'd fake $HOME with a brain + repo mounts at chosen depths,
 * each with a chosen template + optional layout.local.yaml. Sets HOME +
 * MEMORY_DATA_DIR + MEMORY_EMBED_BACKEND (+ project module); returns restore().
 * @param {{ prefix: string, brainTemplate?: TemplateName, brainLocal?: string, mounts?: MountSpec[], projectModule?: string }} spec
 * @returns {Promise<FakeHome>}
 */
export async function buildFakeHome(spec) {
  const { prefix, brainTemplate = "default", brainLocal, mounts = [], projectModule } = spec;
  /** @type {Record<string, string | undefined>} */
  const saved = {
    HOME: process.env.HOME,
    MEMORY_DATA_DIR: process.env.MEMORY_DATA_DIR,
    MEMORY_EMBED_BACKEND: process.env.MEMORY_EMBED_BACKEND,
    MEMORY_DEFAULT_PROJECT_MODULE: process.env.MEMORY_DEFAULT_PROJECT_MODULE,
  };
  const home = realTmp(prefix);
  const brainDataDir = path.join(home, ".llm-wiki-memory");
  process.env.HOME = home;
  process.env.MEMORY_DATA_DIR = brainDataDir;
  process.env.MEMORY_EMBED_BACKEND = "lexical";
  if (projectModule != null) process.env.MEMORY_DEFAULT_PROJECT_MODULE = projectModule;
  const brainWiki = await installWiki(home, brainTemplate, brainLocal);
  writeLexicalSettings(brainDataDir);
  /** @type {BuiltMount[]} */
  const built = [];
  for (const m of mounts) {
    const dir = mkdirp(home, m.rel);
    const template = m.template || "default";
    built.push({ rel: m.rel, dir, wikiRoot: await installWiki(dir, template, m.local), template });
  }
  const restore = () => {
    for (const k of Object.keys(saved)) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { home, brainDataDir, brainWiki, mounts: built, restore };
}

/**
 * Build a fake $HOME with real git repos at the given rel paths and run the
 * real `initMount` on each. Sets process.env.HOME (via freshHome).
 * @param {{ prefix: string, tmps: string[], repos: { rel: string }[], template?: TemplateName }} spec
 * @returns {Promise<{ home: string, brainDataDir: string, repos: NestedMount[] }>}
 */
export async function installNest(spec) {
  const { initMount } = await import("../../scripts/mount-init.mjs");
  const { prefix, tmps, repos, template } = spec;
  const home = freshHome(prefix, tmps);
  const brainDataDir = path.join(home, ".llm-wiki-memory");
  /** @type {NestedMount[]} */
  const out = [];
  for (const r of repos) {
    const dir = mkdirp(home, r.rel);
    gitInit(dir);
    const result = /** @type {MountResult} */ (template ? initMount(dir, { template }) : initMount(dir));
    out.push({ rel: r.rel, dir, result, wikiRoot: path.join(dir, ".llm-wiki-memory", "wiki") });
  }
  return { home, brainDataDir, repos: out };
}

/**
 * @param {string} target absolute existing path
 * @param {string} linkPath absolute symlink to create (parents made)
 * @returns {string} linkPath
 */
export function symlinkAlias(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath);
  return linkPath;
}

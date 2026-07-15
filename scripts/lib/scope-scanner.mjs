// Deterministic scope scanner for the federated (layered) wiki.
//
// Given a set of scope directories (e.g. the agent's cwd plus any extra roots),
// this walks each one UPWARD toward the user's home directory, collecting every
// wiki mount it finds on the way. A mount is a directory `<dir>` that holds a
// `<dir>/.llm-wiki-memory/wiki/.layout/layout.yaml`. The result is an ordered
// stack of level descriptors (shallowest first, the brain at depth 0) that a
// later resolver enriches with parsed layouts and embedding-cache paths.
//
// It NEVER throws: this feeds a capture hook that must exit 0. A missing or
// unreadable scope, or a permission wall part-way up a walk, is caught and the
// scan returns whatever it has already collected plus the brain.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MEMORY_DATA_DIR, defaultProjectModule } from "./env.mjs";
import { OWNERSHIP } from "./context/enums.mjs";

const MOUNT_DIRNAME = ".llm-wiki-memory";
const WIKI_DIRNAME = "wiki";

/**
 * One discovered level of the federated wiki stack. A subset of
 * {@link import("./wiki-context.mjs").WikiLevel}: the scanner emits placement
 * facts only (no parsed `layout`); the resolver enriches this later.
 *
 * @typedef {Object} ScopeLevel
 * @property {string} mountDir absolute path to the directory that holds the `.llm-wiki-memory` mount
 * @property {string} root absolute path to the wiki tree (`<mountDir>/.llm-wiki-memory/wiki`, matching `wikiRoot()`)
 * @property {"repo" | "wiki"} ownership `wiki` for the brain mount, `repo` for any other discovered mount
 * @property {string} projectModule module identifier: the `mountDir` basename (the env default for the brain)
 * @property {number} depth 0-based position from the shallowest level (the brain is always 0)
 */

/**
 * @param {string} p
 * @returns {string} the fully symlink-resolved path, or `p` unchanged if it cannot be resolved
 */
function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * @param {string} dir
 * @returns {string}
 */
function layoutPathFor(dir) {
  return path.join(dir, MOUNT_DIRNAME, WIKI_DIRNAME, ".layout", "layout.yaml");
}

/**
 * @param {string} dir
 * @returns {string}
 */
function wikiRootFor(dir) {
  return path.join(dir, MOUNT_DIRNAME, WIKI_DIRNAME);
}

/**
 * `dir` is within the home subtree when it is home itself or a descendant.
 * @param {string} dir
 * @param {string} homeReal
 * @returns {boolean}
 */
function withinHome(dir, homeReal) {
  return dir === homeReal || dir.startsWith(homeReal + path.sep);
}

/**
 * A permission wall (rather than a plain "no mount here") stops a walk.
 * @param {unknown} err
 * @returns {boolean}
 */
function isAccessError(err) {
  const code = err && typeof err === "object" ? /** @type {{ code?: string }} */ (err).code : "";
  return code === "EACCES" || code === "EPERM";
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function hasMount(dir) {
  return fs.statSync(layoutPathFor(dir)).isFile();
}

/**
 * Walk a single scope upward, collecting mounts into `out` (keyed by resolved
 * root so a shared ancestor is collected once across scopes). The brain's own
 * root is skipped — it is added separately with `wiki` ownership.
 *
 * @param {string} scope
 * @param {string} homeReal
 * @param {string} brainRootKey
 * @param {Map<string, ScopeLevel>} out
 */
function walkScope(scope, homeReal, brainRootKey, out) {
  let dir;
  try {
    dir = fs.realpathSync(scope);
  } catch {
    return;
  }
  /** @param {string} d @returns {boolean} */
  const collect = (d) => {
    let mounted = false;
    try {
      mounted = hasMount(d);
    } catch (err) {
      if (isAccessError(err)) return false;
    }
    if (!mounted) return false;
    const root = wikiRootFor(d);
    const key = realpathOr(root);
    if (key !== brainRootKey && !out.has(key)) {
      out.set(key, {
        mountDir: d,
        root,
        ownership: OWNERSHIP.REPO,
        projectModule: path.basename(d),
        depth: 0,
      });
    }
    return true;
  };
  if (!withinHome(dir, homeReal)) {
    collect(dir);
    return;
  }
  while (withinHome(dir, homeReal)) {
    collect(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/**
 * @param {string} p
 * @returns {number} count of non-empty path segments
 */
function segmentCount(p) {
  return p.split(path.sep).filter(Boolean).length;
}

/**
 * Shallowest first (fewer path segments), ties broken by path for stability.
 * @param {ScopeLevel} a
 * @param {ScopeLevel} b
 * @returns {number}
 */
function byDepthThenPath(a, b) {
  const bySegments = segmentCount(a.mountDir) - segmentCount(b.mountDir);
  if (bySegments !== 0) return bySegments;
  if (a.mountDir < b.mountDir) return -1;
  if (a.mountDir > b.mountDir) return 1;
  return 0;
}

/**
 * True when `ancestor` is a STRICT path-ancestor of `descendant` (descendant is
 * nested inside ancestor and they are not the same dir). Both are realpath'd
 * mount dirs, so a plain relative check is exact.
 * @param {string} ancestor
 * @param {string} descendant
 * @returns {boolean}
 */
function isStrictAncestorDir(ancestor, descendant) {
  if (ancestor === descendant) return false;
  const rel = path.relative(ancestor, descendant);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Scan the given scope directories for federated-wiki mounts.
 *
 * @param {string[]} [scopes] directories to scope from (walked upward toward home)
 * @param {{ home?: string, brainDataDir?: string }} [opts]
 *   `home` bounds each walk (default `os.homedir()`); `brainDataDir` locates the
 *   private wiki (default `MEMORY_DATA_DIR`). Injectable so tests can build fake
 *   trees under a temp directory.
 * @returns {ScopeLevel[]} the ordered stack, brain at depth 0, deepest repo last
 */
export function scanScopes(scopes, { home = os.homedir(), brainDataDir = MEMORY_DATA_DIR } = {}) {
  const brainMountDir = path.dirname(brainDataDir);
  const brainRoot = path.join(brainDataDir, WIKI_DIRNAME);
  const brainRootKey = realpathOr(brainRoot);
  /** @type {ScopeLevel} */
  const brain = {
    mountDir: brainMountDir,
    root: brainRoot,
    ownership: OWNERSHIP.WIKI,
    projectModule: defaultProjectModule() || path.basename(brainMountDir),
    depth: 0,
  };

  /** @type {Map<string, ScopeLevel>} */
  const repos = new Map();
  const homeReal = home ? realpathOr(home) : "";
  if (homeReal && Array.isArray(scopes)) {
    for (const scope of scopes) {
      if (typeof scope === "string" && scope) walkScope(scope, homeReal, brainRootKey, repos);
    }
  }

  const repoLevels = [...repos.values()].sort(byDepthThenPath);
  const ordered = [brain, ...repoLevels];
  // Depth reflects TRUE nesting, NOT scan order: the brain is 0; each repo mount's
  // depth is 1 + the number of OTHER in-scope repo mounts that are strict
  // path-ancestors of it. SIBLINGS (no repo mount between them) therefore share a
  // depth and are ranked by relevance (cosine) rather than by alphabetical scan
  // order; a nested chain (parent -> child) still increments, so the more-specific
  // child keeps its locality boost in fan-out.
  brain.depth = 0;
  for (const level of repoLevels) {
    let ancestors = 0;
    for (const other of repoLevels) {
      if (isStrictAncestorDir(other.mountDir, level.mountDir)) ancestors += 1;
    }
    level.depth = 1 + ancestors;
  }
  return ordered;
}

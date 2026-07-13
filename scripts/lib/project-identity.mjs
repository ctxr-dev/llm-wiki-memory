import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Is `descendantDir` the same directory as, or nested under, `ancestorDir`?
 * Both are canonical absolute paths (the scanner realpaths every mountDir), so a
 * plain `path.relative` containment test is exact — `/h/a` contains `/h/a/b` but
 * NOT the sibling `/h/ab`. This is what distinguishes a true ANCESTOR mount from
 * an equal-depth SIBLING that merely sorts earlier in the resolved chain.
 * @param {string} ancestorDir
 * @param {string} descendantDir
 * @returns {boolean}
 */
function isAncestorOrSelf(ancestorDir, descendantDir) {
  const rel = path.relative(ancestorDir, descendantDir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * @param {unknown} originUrl
 * @returns {string | null}
 */
export function canonicalRepoId(originUrl) {
  if (typeof originUrl !== "string") return null;
  let s = originUrl.trim().toLowerCase();
  if (s === "") return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^[^@/]+@/, "");
  const slash = s.indexOf("/");
  const colon = s.indexOf(":");
  if (slash === -1 && colon === -1) return null;
  let path;
  if (colon !== -1 && (slash === -1 || colon < slash)) {
    const afterColon = s.slice(colon + 1);
    const port = afterColon.match(/^\d+\//);
    path = port ? afterColon.slice(port[0].length) : afterColon;
  } else {
    path = s.slice(slash + 1);
  }
  // Trim surrounding slashes BEFORE stripping `.git`, so `…repo.git/` (a trailing
  // slash git stores verbatim) folds to the same id as `…repo.git`, not `repo.git`.
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!path.includes("/")) return null;
  return path;
}

/**
 * @param {string} dir
 * @returns {string | null}
 */
export function gitOriginUrl(dir) {
  try {
    const r = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const out = (r.stdout || "").trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/**
 * @typedef {{ mountDir: string, ownership?: string, projectId?: string, layout?: { project_id?: string } }} IdentityLevel
 */

/**
 * @param {IdentityLevel} level
 * @param {(dir: string) => (string | null)} [gitOrigin]
 * @returns {string}
 */
export function projectModuleSegment(level, gitOrigin = gitOriginUrl) {
  const declared = level.projectId ?? level.layout?.project_id;
  if (declared) return String(declared);
  const canon = canonicalRepoId(gitOrigin(level.mountDir));
  if (canon) return canon;
  return `file://${level.mountDir}`;
}

/**
 * @param {{ levels: IdentityLevel[] }} ctx
 * @param {IdentityLevel} targetLevel
 * @param {(dir: string) => (string | null)} [gitOrigin]
 * @returns {string}
 */
export function resolveProjectModuleIdentity(ctx, targetLevel, gitOrigin = gitOriginUrl) {
  // The chain is the repo-owned levels that are ANCESTORS of (or are) the target
  // — NOT every repo level that sorts before it. Two equal-depth SIBLINGS both
  // precede the alphabetically-later one in `levels`, but neither owns the other,
  // so an index-based slice would stamp a write to one sibling with the other's
  // identity (leaking an unrelated repo's origin / local path). Filter by real
  // path-ancestry instead. `levels` is already ordered outermost→deepest, and
  // genuine ancestors nest, so the filtered order stays outermost→owning.
  const chain = ctx.levels.filter(
    (l) => l.ownership === "repo" && isAncestorOrSelf(l.mountDir, targetLevel.mountDir),
  );
  if (chain.length === 0) return projectModuleSegment(targetLevel, gitOrigin);
  return chain.map((l) => projectModuleSegment(l, gitOrigin)).join("//");
}

/**
 * @param {{ levels: IdentityLevel[] }} ctx
 * @param {IdentityLevel} targetLevel
 * @param {(dir: string) => (string | null)} [gitOrigin]
 * @returns {{ ok: true } | { ok: false, conflicts: { mountDir: string, reason: string }[] }}
 */
export function validateProjectModuleIdentity(ctx, targetLevel, gitOrigin = gitOriginUrl) {
  const conflicts = [];
  for (const l of ctx.levels) {
    if (l.ownership !== "repo") continue;
    if (!isAncestorOrSelf(l.mountDir, targetLevel.mountDir)) continue;
    if (projectModuleSegment(l, gitOrigin).startsWith("file://")) {
      conflicts.push({
        mountDir: l.mountDir,
        reason: "repo-owned level has no portable identity (no project_id, no git origin)",
      });
    }
  }
  return conflicts.length ? { ok: false, conflicts } : { ok: true };
}

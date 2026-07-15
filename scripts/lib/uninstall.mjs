// Uninstall helper (the testable, pure-filesystem half of `bootstrap.sh
// --uninstall`). It reverses ONLY the machine-managed surfaces that can be
// safely edited: the MCP server registration in the JSON client configs, and
// the marker-fenced sync-embeddings block chained into a repo's git hooks. It
// NEVER touches memory data (the wiki, indexes, settings), NEVER git-commits,
// and NEVER edits a user hook outside our fence. Anything that would destroy
// data or needs a human decision is returned as a printed manual step, not
// done. The cron/launchd teardown lives in the shell (bootstrap.sh), which owns
// the OS scheduler glue.

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.mjs";
import { MARKER_START, MARKER_END, HOOK_EVENTS, hooksDirFor } from "./mount-git.mjs";
import { withFsRetry } from "./fs-retry.mjs";
import {
  POINTER_PREFIX,
  DOC_MARKER_START,
  DOC_MARKER_END,
  HASH_MARKER_START,
  HASH_MARKER_END,
  MEMORY_DOCS,
  RULE_SURFACES,
} from "./memory-surface-constants.mjs";
import { readManifest, writeManifest, manifestPath, sha256 } from "./install-manifest.mjs";
import { stripManagedBlocks } from "./marker-block.mjs";
import { isOurPointer } from "./pointer-file.mjs";
import {
  removeMcpRegistration,
  removeAgentsSurface,
  removeClaudeHooks,
  pruneEmptyDir,
} from "./uninstall-configs.mjs";

export { removeMcpRegistration, removeAgentsSurface, removeClaudeHooks };

const MOUNT_DIRNAME = ".llm-wiki-memory";

// Only a shebang + blank lines left once our block is gone → the hook was ours; remove it.
/** @param {string} content @returns {boolean} */
function isInertHook(content) {
  return content.split("\n").every((l) => l.trim() === "" || l.trim().startsWith("#!"));
}

/**
 * Remove the chained sync-embeddings block from a repo's git hooks, preserving
 * any other hook content. A hook file left inert (only a shebang) is deleted,
 * since we created it. Idempotent.
 * @param {string} repoDir
 * @returns {{ ok: boolean, skipped?: string, results?: Record<string, string> }}
 */
export function removeSyncHookBlocks(repoDir) {
  const hooksDir = hooksDirFor(repoDir);
  if (!hooksDir) return { ok: false, skipped: "not-a-repo" };
  /** @type {Record<string, string>} */
  const results = {};
  for (const event of HOOK_EVENTS) {
    const target = path.join(hooksDir, event);
    if (!fs.existsSync(target)) {
      results[event] = "absent";
      continue;
    }
    const original = fs.readFileSync(target, "utf8");
    const stripped = stripManagedBlocks(original, MARKER_START, MARKER_END);
    if (stripped === original) {
      results[event] = "no-marker";
    } else if (isInertHook(stripped)) {
      withFsRetry(() => fs.rmSync(target));
      results[event] = "removed";
    } else {
      // Normalize trailing blanks (chainHookFile prepends a separator on each install;
      // without this the hook would gain a blank line per install/uninstall cycle).
      const normalized = stripped.replace(/\n{3,}/g, "\n\n").replace(/[ \t\n]+$/, "");
      writeFileAtomic(target, `${normalized}\n`, { mode: 0o755 });
      results[event] = "stripped";
    }
  }
  return { ok: true, results };
}

/**
 * Strip our marker-fenced block(s) from a file: rewrite it without them, or DELETE
 * the file when nothing but our block was there (we created it). Returns true when
 * it acted, false when the file is absent or carries no block. Never removes
 * non-marker content (see marker-block.mjs).
 * @param {string} file @param {string} startMarker @param {string} endMarker
 * @returns {boolean}
 */
function stripBlockFromFile(file, startMarker, endMarker) {
  if (!fs.existsSync(file)) return false;
  const content = fs.readFileSync(file, "utf8");
  const stripped = stripManagedBlocks(content, startMarker, endMarker);
  if (stripped === content) return false;
  const normalized = stripped
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/[ \t\n]+$/, "");
  if (normalized === "") withFsRetry(() => fs.rmSync(file, { force: true }));
  else writeFileAtomic(file, `${normalized}\n`);
  return true;
}

/** @param {string} file @returns {boolean} */
function stripBlockFromDoc(file) {
  return stripBlockFromFile(file, DOC_MARKER_START, DOC_MARKER_END);
}

/**
 * Remove our fenced block from the workspace `.gitignore` (E2). Reversible + exact
 * (marker-scoped); other lines survive; a file that was only our block is removed.
 * @param {string} workspaceDir @returns {boolean}
 */
export function removeGitignoreBlock(workspaceDir) {
  return stripBlockFromFile(
    path.join(workspaceDir, ".gitignore"),
    HASH_MARKER_START,
    HASH_MARKER_END,
  );
}

/**
 * Reverse the reference-only wiring (D). With an install MANIFEST present, remove
 * EXACTLY the recorded artifacts: a file is deleted only if its content still hashes
 * to what we wrote (a drifted / user-owned file is KEPT and surfaced, never
 * blind-deleted); a doc block is stripped by marker. Kept files stay recorded so a
 * re-run stays hash-aware; a clean removal drops the manifest. Without a manifest
 * (legacy install) fall back to `llm-wiki-memory-` prefix + marker discovery.
 * Idempotent.
 * @param {string} workspaceDir
 * @returns {{ pointers: string[], docs: string[], kept: string[] }}
 */
export function removeMemorySurfaces(workspaceDir) {
  const ws = path.resolve(workspaceDir);
  const manifest = readManifest(ws);
  const result = manifest ? removeFromManifest(ws, manifest) : removeByDiscovery(ws);
  sweepOrphanPointers(ws, result);
  for (const surface of RULE_SURFACES) pruneEmptyDir(path.join(ws, surface));
  return result;
}

/** A manifest `path` must stay inside the workspace (never `../…` / absolute escape). */
/** @param {string} ws @param {string} rel @returns {boolean} */
function withinWs(ws, rel) {
  const abs = path.resolve(ws, rel);
  return abs === ws || abs.startsWith(ws + path.sep);
}

/**
 * Remove any prefixed pointer the manifest never accounted for — e.g. one left by
 * a renamed/removed shipped rule (the manifest records only the CURRENT set). Only
 * files that pass `isOurPointer` are swept. Files the manifest tracked (removed OR
 * kept-drifted) are excluded.
 * @param {string} ws @param {{ pointers: string[], kept: string[] }} result
 */
function sweepOrphanPointers(ws, result) {
  const tracked = new Set([...result.pointers, ...result.kept]);
  for (const surface of RULE_SURFACES) {
    const dir = path.join(ws, surface);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const rel = `${surface}/${entry}`;
      const abs = path.join(dir, entry);
      if (
        entry.startsWith(POINTER_PREFIX) &&
        entry.endsWith(".md") &&
        !tracked.has(rel) &&
        isOurPointer(abs)
      ) {
        withFsRetry(() => fs.rmSync(abs, { force: true }));
        result.pointers.push(rel);
      }
    }
  }
}

/**
 * @param {string} ws @param {import("./install-manifest.mjs").InstallManifest} manifest
 * @returns {{ pointers: string[], docs: string[], kept: string[] }}
 */
function removeFromManifest(ws, manifest) {
  /** @type {string[]} */ const pointers = [];
  /** @type {string[]} */ const docs = [];
  /** @type {string[]} */ const kept = [];
  /** @type {import("./install-manifest.mjs").InstallArtifact[]} */ const keptArtifacts = [];
  for (const a of manifest.artifacts) {
    if (!a || typeof a !== "object" || typeof a.path !== "string" || !withinWs(ws, a.path)) {
      continue; // malformed or path-escaping → never act on it (dropped from the rewrite)
    }
    if (a.kind === "file") {
      if (typeof a.sha256 !== "string") {
        kept.push(a.path); // unverifiable → keep + track (so the sweep won't delete it)
        keptArtifacts.push(a);
        continue;
      }
      const abs = path.join(ws, a.path);
      let content = null;
      try {
        content = fs.readFileSync(abs, "utf8");
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== "ENOENT") {
          kept.push(a.path); // perm blip → keep tracked + surfaced (ENOENT → already gone, drop)
          keptArtifacts.push(a);
        }
        continue;
      }
      if (sha256(content) === a.sha256) {
        withFsRetry(() => fs.rmSync(abs, { force: true }));
        pointers.push(a.path);
      } else {
        kept.push(a.path);
        keptArtifacts.push(a);
      }
    } else if (a.kind === "block") {
      // stripManagedBlocks handles every marker arrangement (well-formed pair OR a
      // stray orphan marker line); a false result means the doc has no marker left,
      // i.e. the block is already gone — either way we stop tracking it.
      if (stripBlockFromDoc(path.join(ws, a.path))) docs.push(a.path);
    } else {
      keptArtifacts.push(a); // unknown/config kind → preserve, never silently drop
    }
  }
  if (keptArtifacts.length) writeManifest(ws, keptArtifacts);
  else withFsRetry(() => fs.rmSync(manifestPath(ws), { force: true }));
  return { pointers, docs, kept };
}

/**
 * @param {string} ws
 * @returns {{ pointers: string[], docs: string[], kept: string[] }}
 */
function removeByDiscovery(ws) {
  /** @type {string[]} */ const pointers = [];
  for (const surface of RULE_SURFACES) {
    const dir = path.join(ws, surface);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (entry.startsWith(POINTER_PREFIX) && entry.endsWith(".md") && isOurPointer(abs)) {
        withFsRetry(() => fs.rmSync(abs, { force: true }));
        pointers.push(`${surface}/${entry}`);
      }
    }
  }
  /** @type {string[]} */ const docs = [];
  for (const doc of MEMORY_DOCS) {
    if (stripBlockFromDoc(path.join(ws, doc))) docs.push(doc);
  }
  withFsRetry(() => fs.rmSync(manifestPath(ws), { force: true })); // converge with the manifest path's end state
  return { pointers, docs, kept: [] };
}

/**
 * The reversals that are NOT automated because they either destroy data or need
 * a human decision. Returned as printable lines.
 * @param {string} workspaceDir
 * @returns {string[]}
 */
export function manualUninstallSteps(workspaceDir) {
  const dataDir = path.join(workspaceDir, MOUNT_DIRNAME);
  return [
    `For a federated repo mount, remove the per-mount personal git repo: rm -rf ${path.join(dataDir, "personal", ".git")}`,
    `Delete the mount / memory data ONLY if you want to discard it (NOT done automatically): rm -rf ${dataDir}`,
  ];
}

/**
 * Reverse the machine-managed install surfaces under a workspace. `repoDirs`
 * defaults to the workspace itself (the repo whose hooks a mount install
 * chained into). Idempotent; never touches memory data.
 * @param {{ workspaceDir: string, repoDirs?: string[] }} opts
 * @returns {{ workspaceDir: string, mcp: { removed: string[] }, surfaces: { pointers: string[], docs: string[], kept: string[] }, gitignore: boolean, agents: { removed: string[] }, claudeHooks: { removed: number }, hooks: Record<string, unknown>, manual: string[] }}
 */
export function uninstall({ workspaceDir, repoDirs }) {
  const ws = path.resolve(workspaceDir);
  const mcp = removeMcpRegistration(ws);
  const surfaces = removeMemorySurfaces(ws);
  const gitignore = removeGitignoreBlock(ws);
  const agents = removeAgentsSurface(ws);
  const claudeHooks = removeClaudeHooks(ws);
  /** @type {Record<string, unknown>} */
  const hooks = {};
  for (const repo of repoDirs && repoDirs.length ? repoDirs : [ws]) {
    hooks[repo] = removeSyncHookBlocks(repo);
  }
  // Prune emptied surface PARENTS (.agents/.claude/.cursor) at the tail — removeClaudeHooks
  // can empty .claude only after removeMemorySurfaces; pruneEmptyDir skips a non-empty dir.
  for (const parent of new Set(RULE_SURFACES.map((s) => path.dirname(s)))) {
    pruneEmptyDir(path.join(ws, parent));
  }
  const manual = manualUninstallSteps(ws);
  if (surfaces.kept.length) {
    manual.push(
      `Kept ${surfaces.kept.length} pointer file(s) whose content no longer matches what was installed (edited or not ours): ${surfaces.kept.join(", ")}. Review and remove by hand if intended.`,
    );
  }
  return { workspaceDir: ws, mcp, surfaces, gitignore, agents, claudeHooks, hooks, manual };
}

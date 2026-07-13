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

const SERVER_KEY = "llm-wiki-memory";
const MOUNT_DIRNAME = ".llm-wiki-memory";

// Reference-only install surfaces (bootstrap wires these as @-pointer files, D):
// every rule/skill pointer is prefixed, and AGENTS.md/CLAUDE.md carry a marker-
// fenced @-include. All are unambiguously ours, so uninstall reverses them.
const POINTER_PREFIX = "llm-wiki-memory-";
const SURFACE_DIRS = [".agents/rules", ".claude/rules", ".claude/skills", ".cursor/rules"];
const DOC_MARKER_START = "<!-- BEGIN llm-wiki-memory -->";
const DOC_MARKER_END = "<!-- END llm-wiki-memory -->";
const MEMORY_DOCS = ["AGENTS.md", "CLAUDE.md"];

// The JSON client configs bootstrap writes a `mcpServers.llm-wiki-memory` entry
// into. Each is workspace-relative and may or may not exist.
const MCP_JSON_RELPATHS = [
  ".mcp.json",
  ".agents/mcp.json",
  ".agents/clients/cursor.json",
  ".agents/clients/claude-desktop.json",
  ".agents/clients/generic-mcp.json",
];

/**
 * Remove the `mcpServers.llm-wiki-memory` entry from one JSON config, preserving
 * every other server and top-level key. Returns true when the file changed.
 * @param {string} file
 * @returns {boolean}
 */
function removeServerFromJson(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Absent or unparseable: leave a user's hand-broken JSON alone.
    return false;
  }
  const servers =
    parsed && typeof parsed === "object"
      ? /** @type {Record<string, unknown>} */ (parsed.mcpServers)
      : undefined;
  if (!servers || typeof servers !== "object" || !(SERVER_KEY in servers)) return false;
  delete servers[SERVER_KEY];
  writeFileAtomic(file, `${JSON.stringify(parsed, null, 2)}\n`);
  return true;
}

/**
 * Remove our MCP server registration from every JSON client config under the
 * workspace. Idempotent. The codex TOML config is left for the manual steps
 * (TOML table edits are surfaced, not automated).
 * @param {string} workspaceDir
 * @returns {{ removed: string[] }}
 */
export function removeMcpRegistration(workspaceDir) {
  /** @type {string[]} */
  const removed = [];
  for (const rel of MCP_JSON_RELPATHS) {
    if (removeServerFromJson(path.join(workspaceDir, rel))) removed.push(rel);
  }
  return { removed };
}

// Content that "does nothing" once our block is gone: a bare shebang and blank
// lines only. Such a hook file was created solely by us, so it is removed.
/**
 * @param {string} content
 * @returns {boolean}
 */
function isInertHook(content) {
  return content.split("\n").every((l) => l.trim() === "" || l.trim().startsWith("#!"));
}

/**
 * Strip our marker-fenced block (plus one preceding blank separator) from a
 * hook file's content. Returns the new content, or null when no marker present.
 * @param {string} content
 * @returns {string | null}
 */
function stripMarkerBlock(content) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === MARKER_START);
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i >= start && l.trim() === MARKER_END);
  if (end === -1) end = lines.length - 1;
  let head = start;
  if (head > 0 && lines[head - 1].trim() === "") head -= 1;
  return [...lines.slice(0, head), ...lines.slice(end + 1)].join("\n");
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
    const stripped = stripMarkerBlock(fs.readFileSync(target, "utf8"));
    if (stripped === null) {
      results[event] = "no-marker";
    } else if (isInertHook(stripped)) {
      fs.rmSync(target);
      results[event] = "removed";
    } else {
      writeFileAtomic(target, stripped.endsWith("\n") ? stripped : `${stripped}\n`, {
        mode: 0o755,
      });
      results[event] = "stripped";
    }
  }
  return { ok: true, results };
}

/**
 * Strip our marker-fenced doc block (plus one preceding blank separator) from an
 * AGENTS.md/CLAUDE.md body. Returns the new content, or null when no marker.
 * @param {string} content
 * @returns {string | null}
 */
function stripDocBlock(content) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === DOC_MARKER_START);
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i >= start && l.trim() === DOC_MARKER_END);
  if (end === -1) end = lines.length - 1;
  let head = start;
  if (head > 0 && lines[head - 1].trim() === "") head -= 1;
  return [...lines.slice(0, head), ...lines.slice(end + 1)].join("\n");
}

/**
 * Reverse the reference-only wiring (D): delete every prefixed `@`-pointer file
 * from the four rule/skill surfaces, and strip the marker-fenced `@`-include from
 * AGENTS.md/CLAUDE.md (deleting a doc that our block was the ENTIRE content of).
 * The consuming project's own rules/docs are untouched. Idempotent.
 * @param {string} workspaceDir
 * @returns {{ pointers: string[], docs: string[] }}
 */
export function removeMemorySurfaces(workspaceDir) {
  const ws = path.resolve(workspaceDir);
  /** @type {string[]} */
  const pointers = [];
  for (const surface of SURFACE_DIRS) {
    const dir = path.join(ws, surface);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(POINTER_PREFIX) && entry.endsWith(".md")) {
        fs.rmSync(path.join(dir, entry), { force: true });
        pointers.push(`${surface}/${entry}`);
      }
    }
  }
  /** @type {string[]} */
  const docs = [];
  for (const doc of MEMORY_DOCS) {
    const file = path.join(ws, doc);
    if (!fs.existsSync(file)) continue;
    const stripped = stripDocBlock(fs.readFileSync(file, "utf8"));
    if (stripped === null) continue;
    if (stripped.trim() === "") fs.rmSync(file, { force: true });
    else writeFileAtomic(file, stripped.endsWith("\n") ? stripped : `${stripped}\n`);
    docs.push(doc);
  }
  return { pointers, docs };
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
    `Revert the .gitignore edit: remove the '/.llm-wiki-memory' line (or the --commit-memory block) from ${path.join(workspaceDir, ".gitignore")}.`,
    `For a federated repo mount, remove the per-mount personal git repo: rm -rf ${path.join(dataDir, "personal", ".git")}`,
    `Delete the mount / memory data ONLY if you want to discard it (NOT done automatically): rm -rf ${dataDir}`,
    `Claude Code capture hooks in ${path.join(workspaceDir, ".claude", "settings.json")} and the codex MCP entry in ${path.join(workspaceDir, ".agents", "clients", "openai-codex.toml")} are left in place — remove them by hand if desired.`,
  ];
}

/**
 * Reverse the machine-managed install surfaces under a workspace. `repoDirs`
 * defaults to the workspace itself (the repo whose hooks a mount install
 * chained into). Idempotent; never touches memory data.
 * @param {{ workspaceDir: string, repoDirs?: string[] }} opts
 * @returns {{ workspaceDir: string, mcp: { removed: string[] }, surfaces: { pointers: string[], docs: string[] }, hooks: Record<string, unknown>, manual: string[] }}
 */
export function uninstall({ workspaceDir, repoDirs }) {
  const ws = path.resolve(workspaceDir);
  const mcp = removeMcpRegistration(ws);
  const surfaces = removeMemorySurfaces(ws);
  /** @type {Record<string, unknown>} */
  const hooks = {};
  for (const repo of repoDirs && repoDirs.length ? repoDirs : [ws]) {
    hooks[repo] = removeSyncHookBlocks(repo);
  }
  return { workspaceDir: ws, mcp, surfaces, hooks, manual: manualUninstallSteps(ws) };
}

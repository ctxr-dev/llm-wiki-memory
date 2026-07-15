// The config-reversal half of uninstall: the JSON/TOML client configs and the
// Claude Code hook entries. Each reversal is key/entry-scoped (never a blind file
// delete of a user-owned config) and idempotent. `.mcp.json` is treated as
// user-owned (key removed, file kept); the `.agents/*` configs we author outright
// (D6) are deleted once our entry leaves them empty.

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.mjs";

const SERVER_KEY = "llm-wiki-memory";
const AGENTS_README = ".agents/README.md";
const CODEX_TOML = ".agents/clients/openai-codex.toml";
const HOOK_CMD_MARKER = ".llm-wiki-memory/src/scripts/hooks/";

const MCP_JSON_RELPATHS = [
  ".mcp.json",
  ".agents/mcp.json",
  ".agents/clients/cursor.json",
  ".agents/clients/claude-desktop.json",
  ".agents/clients/generic-mcp.json",
];

/**
 * Remove the `mcpServers.llm-wiki-memory` entry from one JSON config, preserving
 * every other server and top-level key. A user's hand-broken JSON is left alone.
 * @param {string} file
 * @returns {boolean}
 */
export function removeServerFromJson(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
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
 * workspace. Idempotent.
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

/** @param {string} file @returns {boolean} the file is exactly `{"mcpServers":{}}` */
function isEmptyMcpJson(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return (
      j &&
      typeof j === "object" &&
      Object.keys(j).length === 1 &&
      j.mcpServers &&
      typeof j.mcpServers === "object" &&
      Object.keys(j.mcpServers).length === 0
    );
  } catch {
    return false;
  }
}

/** @param {string} dir remove it only when it exists and is empty (rmSync EISDIRs on a dir) */
export function pruneEmptyDir(dir) {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    return;
  }
}

/**
 * Strip our `[mcp_servers.llm-wiki-memory]` table (header + its keys, INCLUDING any
 * dotted-child sub-tables like `[mcp_servers.llm-wiki-memory.env]`, up to the next
 * unrelated table or EOF) from a codex TOML config; delete the file if that was its
 * only table.
 * @param {string} file @returns {boolean}
 */
export function stripCodexServer(file) {
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === "[mcp_servers.llm-wiki-memory]");
  if (start === -1) return false;
  let end = start + 1;
  while (end < lines.length) {
    const t = lines[end].trim();
    if (/^\[/.test(t) && !t.startsWith("[mcp_servers.llm-wiki-memory.")) break;
    end += 1;
  }
  let head = start;
  if (head > 0 && lines[head - 1].trim() === "") head -= 1;
  const rest = [...lines.slice(0, head), ...lines.slice(end)].join("\n");
  if (rest.trim() === "") fs.rmSync(file, { force: true });
  else writeFileAtomic(file, rest.endsWith("\n") ? rest : `${rest}\n`);
  return true;
}

/**
 * Reverse the `.agents/` surface we author outright (D6): remove README.md, delete
 * any of OUR MCP JSON configs the key-removal left empty, strip our codex TOML table,
 * and prune the emptied `.agents/clients` + `.agents` dirs. `.mcp.json` (user-owned)
 * is deliberately left key-only. Idempotent.
 * @param {string} workspaceDir @returns {{ removed: string[] }}
 */
export function removeAgentsSurface(workspaceDir) {
  const ws = path.resolve(workspaceDir);
  /** @type {string[]} */ const removed = [];
  const readme = path.join(ws, AGENTS_README);
  if (fs.existsSync(readme)) {
    fs.rmSync(readme, { force: true });
    removed.push(AGENTS_README);
  }
  for (const rel of MCP_JSON_RELPATHS) {
    if (rel === ".mcp.json") continue;
    if (isEmptyMcpJson(path.join(ws, rel))) {
      fs.rmSync(path.join(ws, rel), { force: true });
      removed.push(rel);
    }
  }
  if (stripCodexServer(path.join(ws, CODEX_TOML))) removed.push(CODEX_TOML);
  pruneEmptyDir(path.join(ws, ".agents/clients"));
  pruneEmptyDir(path.join(ws, ".agents"));
  return { removed };
}

/**
 * Remove our capture-hook entries from `.claude/settings.json` (each command invokes
 * `$HOME/.llm-wiki-memory/src/scripts/hooks/…`), preserving the user's own hooks and
 * top-level keys; delete the file if it becomes an empty `{"hooks":{}}` we created.
 * Idempotent.
 * @param {string} workspaceDir @returns {{ removed: number }}
 */
export function removeClaudeHooks(workspaceDir) {
  const file = path.join(path.resolve(workspaceDir), ".claude", "settings.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { removed: 0 };
  }
  const hooks = parsed && typeof parsed === "object" ? parsed.hooks : undefined;
  if (!hooks || typeof hooks !== "object") return { removed: 0 };
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue; // a non-array event value is not ours → leave verbatim
    /** @type {unknown[]} */ const kept = [];
    for (const group of hooks[event]) {
      const inner = group && typeof group === "object" ? group.hooks : undefined;
      if (!Array.isArray(inner)) {
        kept.push(group); // a group we don't recognize → preserve verbatim
        continue;
      }
      const kInner = inner.filter(
        (/** @type {{ command?: unknown }} */ h) =>
          !(h && typeof h.command === "string" && h.command.includes(HOOK_CMD_MARKER)),
      );
      removed += inner.length - kInner.length;
      // Drop the group ONLY when it HAD hooks and every one was ours. A group that
      // was already empty (a user's `hooks: []`) is preserved, not silently dropped.
      if (kInner.length || inner.length === 0) kept.push({ ...group, hooks: kInner });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event]; // the event array was entirely our hooks → drop the empty event
  }
  if (removed === 0) return { removed: 0 };
  if (Object.keys(hooks).length === 0 && Object.keys(parsed).length === 1) {
    fs.rmSync(file, { force: true });
  } else {
    writeFileAtomic(file, `${JSON.stringify(parsed, null, 2)}\n`);
  }
  return { removed };
}

#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  removeServerFromJson,
  stripCodexServer,
  removeClaudeHooks,
  removeMcpRegistration,
  removeAgentsSurface,
  pruneEmptyDir,
} from "../lib/uninstall-configs.mjs";
import { mcpClients } from "./mcp-clients.mjs";

// Global-only teardown + migration, the inverse of register-global. Every step
// is entry/key-scoped (never a blind delete of a user config) and idempotent.

/**
 * Strip our server entry from every present client's USER-HOME global config +
 * our hook groups from ~/.claude/settings.json. Preserves the user's other
 * servers, hooks, and top-level keys.
 * @param {{ home: string, platform?: NodeJS.Platform }} opts
 * @returns {{ removed: Record<string, boolean>, hooks: number }}
 */
export function unregisterGlobalMcp({ home, platform = process.platform }) {
  const clients = mcpClients(home, platform);
  /** @type {Record<string, boolean>} */
  const removed = {};
  for (const [name, c] of Object.entries(clients)) {
    removed[name] = c.format === "toml" ? stripCodexServer(c.file) : removeServerFromJson(c.file);
  }
  // ~/.claude/settings.json === removeClaudeHooks(home)'s <home>/.claude/settings.json.
  const hooks = removeClaudeHooks(home).removed;
  return { removed, hooks };
}

/**
 * Remove STALE per-repo client config a pre-global install left in the workspace
 * (server no longer writes these). HOME-AWARE: for a brain (workspace === home)
 * the per-repo `.claude/settings.json` IS the global hooks file, so its hooks are
 * NOT stripped here (they're the ones we just registered); only the per-repo
 * `.mcp.json` + `.agents/*` are stale. For a mount (workspace !== home) the
 * per-repo hooks are stale too.
 * @param {{ workspace: string, home: string }} opts
 * @returns {{ mcp: string[], agents: string[], hooks: number }}
 */
export function removeStalePerRepo({ workspace, home }) {
  const ws = path.resolve(workspace);
  const mcp = removeMcpRegistration(ws).removed;
  const agents = removeAgentsSurface(ws).removed;
  let hooks = 0;
  if (ws !== path.resolve(home)) hooks = removeClaudeHooks(ws).removed;
  pruneEmptyDir(path.join(ws, ".claude"));
  return { mcp, agents, hooks };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = process.argv.slice(2);
  if (args[0] === "--migrate") {
    const [, workspace, home] = args;
    if (!workspace || !home) {
      console.error("usage: unregister-global.mjs --migrate <workspace> <home>");
      process.exit(1);
    }
    console.error(
      `per-repo migration cleanup: ${JSON.stringify(removeStalePerRepo({ workspace, home }))}`,
    );
  } else {
    const home = args[0] || process.env.HOME || "";
    if (!home) {
      console.error("usage: unregister-global.mjs <home>");
      process.exit(1);
    }
    console.error(`global mcp teardown: ${JSON.stringify(unregisterGlobalMcp({ home }))}`);
  }
}

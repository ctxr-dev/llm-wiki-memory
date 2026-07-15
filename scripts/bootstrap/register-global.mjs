#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mergeIntoJsonFile, readJsonOrThrow, CorruptConfigRefused } from "../lib/config-merge.mjs";
import { mergeCodexToml } from "./merge-codex-toml.mjs";
import {
  mcpClients,
  serverEntry,
  claudeUserSettings,
  SERVER_NAME,
  SERVER_INDEX_REL,
} from "./mcp-clients.mjs";

// Register the MCP server + Claude Code hooks into the user's HOME (global),
// never per repo. A client whose config dir doesn't exist is skipped (it isn't
// installed) — except claude-code, whose config lives directly in $HOME. A
// customized/wrapped `command` (mandated security shim) is preserved by the
// underlying mergers.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOOKS_TEMPLATE = path.join(HERE, "..", "..", "templates", "claude", "settings.json");

// Claude Code + Cursor interpolate ${HOME} in args; Claude Desktop + Codex take
// an absolute index path (matches scripts/mcp-config.sh). On Windows, ${HOME} is
// NOT reliably set in the client's spawn env (it uses USERPROFILE), so `node`
// would receive a literal "${HOME}" and never start the server — use the
// absolute path there for every client (a global install is per-machine, so the
// absolute path is portable enough by construction).
const HOME_INTERP_CLIENTS = new Set(["claude-code", "cursor"]);

/**
 * @param {string} home
 * @param {string} name
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
function indexArgFor(home, name, platform) {
  return platform !== "win32" && HOME_INTERP_CLIENTS.has(name)
    ? SERVER_INDEX_REL
    : path.join(home, ".llm-wiki-memory", "src", "mcp-server", "index.mjs");
}

/**
 * @param {{ home: string, platform?: NodeJS.Platform, hooksTemplate?: string }} opts
 * @returns {Record<string, string>}
 */
export function registerGlobalMcp({ home, platform = process.platform, hooksTemplate }) {
  const clients = mcpClients(home, platform);
  /** @type {Record<string, string>} */
  const results = {};
  for (const [name, c] of Object.entries(clients)) {
    const present =
      name === "claude-code" || fs.existsSync(path.dirname(c.file)) || fs.existsSync(c.file);
    if (!present) {
      results[name] = "absent";
      continue;
    }
    const idx = indexArgFor(home, name, platform);
    if (c.format === "toml") {
      results[name] = mergeCodexToml(c.file, idx).action;
      continue;
    }
    results[name] = mergeGlobalJson(c.file, { [SERVER_NAME]: serverEntry(idx) }, c.mcpKey);
  }
  const tmpl = hooksTemplate || DEFAULT_HOOKS_TEMPLATE;
  const read = readJsonOrThrow(tmpl);
  const hooks = /** @type {Record<string, unknown>} */ (
    (read && /** @type {{ hooks?: unknown }} */ (read.value).hooks) || {}
  );
  results.hooks = mergeGlobalJson(claudeUserSettings(home), hooks, "hooks");
  return results;
}

/**
 * Merge into a user's CRITICAL global config, refusing (never clobbering) a
 * non-empty unparseable target — it may have been read mid-write. On refusal we
 * skip that one client with a loud warning rather than abort the whole install.
 * @param {string} file @param {Record<string, unknown>} incoming @param {string | undefined} topKey
 * @returns {"registered" | "corrupt-skipped"}
 */
function mergeGlobalJson(file, incoming, topKey) {
  try {
    mergeIntoJsonFile(file, incoming, /** @type {string} */ (topKey), { refuseOnCorrupt: true });
    return "registered";
  } catch (err) {
    if (err instanceof CorruptConfigRefused) {
      console.error(`register-global: skipped ${file} — ${err.message}`);
      return "corrupt-skipped";
    }
    throw err;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const home = process.argv[2] || process.env.HOME || "";
  if (!home) {
    console.error("usage: register-global.mjs <home>");
    process.exit(1);
  }
  const r = registerGlobalMcp({ home });
  console.error(`global mcp: ${JSON.stringify(r)}`);
}

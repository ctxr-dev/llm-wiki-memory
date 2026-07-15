import path from "node:path";

// Single source of truth for WHERE each client's USER-HOME global MCP config
// lives and WHAT entry we register. Global-only: the server is registered once
// per user, never per repo, so a shared repo carries no client config.

export const SERVER_NAME = "llm-wiki-memory";
// ${HOME} (not ~) — MCP clients interpolate ${VAR} in args; ~ is not expanded.
export const SERVER_INDEX_REL = "${HOME}/.llm-wiki-memory/src/mcp-server/index.mjs";

/**
 * @param {string} [indexArg]
 * @returns {{ command: string, args: string[] }}
 */
export function serverEntry(indexArg = SERVER_INDEX_REL) {
  return { command: "node", args: [indexArg] };
}

/**
 * @param {string} [indexArg]
 * @returns {string}
 */
export function codexTomlBlock(indexArg = SERVER_INDEX_REL) {
  // Single-quoted TOML LITERAL string: a Windows absolute index path contains
  // backslashes, and a double-quoted BASIC string would read `\U`/`\.` as
  // invalid escapes and reject the whole config.toml. Paths never contain `'`.
  return `[mcp_servers.${SERVER_NAME}]\ncommand = "node"\nargs = ['${indexArg}']\n`;
}

/**
 * @param {string} home
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
function claudeDesktopConfig(home, platform = process.platform) {
  if (platform === "darwin")
    return path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

/**
 * @typedef {Object} McpClient
 * @property {"json" | "toml"} format
 * @property {string} file - the user-home global config path
 * @property {string} [mcpKey] - top-level object the server nests under (json)
 * @property {string} [tomlTable] - the table header (toml)
 */

/**
 * The per-client user-home global MCP config targets. All confirmed to apply to
 * every project/workspace (see the plan's Workstream N table).
 * @param {string} home
 * @param {NodeJS.Platform} [platform]
 * @returns {Record<string, McpClient>}
 */
export function mcpClients(home, platform = process.platform) {
  return {
    "claude-code": { format: "json", file: path.join(home, ".claude.json"), mcpKey: "mcpServers" },
    cursor: {
      format: "json",
      file: path.join(home, ".cursor", "mcp.json"),
      mcpKey: "mcpServers",
    },
    "claude-desktop": {
      format: "json",
      file: claudeDesktopConfig(home, platform),
      mcpKey: "mcpServers",
    },
    codex: {
      format: "toml",
      file: path.join(home, ".codex", "config.toml"),
      tomlTable: `mcp_servers.${SERVER_NAME}`,
    },
  };
}

// The Claude Code hooks live in the user settings file (not .claude.json), and
// apply to every project when placed there.
/**
 * @param {string} home
 * @returns {string}
 */
export function claudeUserSettings(home) {
  return path.join(home, ".claude", "settings.json");
}

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  SERVER_NAME,
  SERVER_INDEX_REL,
  serverEntry,
  codexTomlBlock,
  mcpClients,
  claudeUserSettings,
} from "../scripts/bootstrap/mcp-clients.mjs";

test("serverEntry is the shared node stdio launcher with the ${HOME}-based index", () => {
  assert.deepEqual(serverEntry(), {
    command: "node",
    args: ["${HOME}/.llm-wiki-memory/src/mcp-server/index.mjs"],
  });
  assert.equal(SERVER_INDEX_REL, "${HOME}/.llm-wiki-memory/src/mcp-server/index.mjs");
  assert.equal(serverEntry("/x/y.mjs").args[0], "/x/y.mjs");
});

test("codexTomlBlock renders the [mcp_servers.<name>] table", () => {
  const block = codexTomlBlock();
  assert.match(block, /^\[mcp_servers\.llm-wiki-memory\]\n/);
  assert.match(block, /command = "node"\n/);
  assert.match(block, /args = \["\$\{HOME\}\/\.llm-wiki-memory\/src\/mcp-server\/index\.mjs"\]\n/);
});

test("mcpClients maps each client to its user-home global config path", () => {
  const c = mcpClients("/home/u", "linux");
  assert.equal(c["claude-code"].file, path.join("/home/u", ".claude.json"));
  assert.equal(c["claude-code"].mcpKey, "mcpServers");
  assert.equal(c.cursor.file, path.join("/home/u", ".cursor", "mcp.json"));
  assert.equal(c.codex.file, path.join("/home/u", ".codex", "config.toml"));
  assert.equal(c.codex.format, "toml");
  assert.equal(c.codex.tomlTable, `mcp_servers.${SERVER_NAME}`);
});

test("claude-desktop config path is platform-specific", () => {
  assert.equal(
    mcpClients("/home/u", "darwin")["claude-desktop"].file,
    path.join("/home/u", "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  );
  assert.equal(
    mcpClients("/home/u", "linux")["claude-desktop"].file,
    path.join("/home/u", ".config", "Claude", "claude_desktop_config.json"),
  );
});

test("every client target is under the given home (no absolute machine leak)", () => {
  for (const c of Object.values(mcpClients("/home/u", "linux"))) {
    assert.ok(c.file.startsWith(path.join("/home/u")), `${c.file} must be under home`);
  }
});

test("claudeUserSettings is the user-scope hooks file", () => {
  assert.equal(claudeUserSettings("/home/u"), path.join("/home/u", ".claude", "settings.json"));
});

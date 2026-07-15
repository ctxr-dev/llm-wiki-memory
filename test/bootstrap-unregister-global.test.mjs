import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerGlobalMcp } from "../scripts/bootstrap/register-global.mjs";
import {
  unregisterGlobalMcp,
  removeStalePerRepo,
} from "../scripts/bootstrap/unregister-global.mjs";

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "unreg-global-"));
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const exists = (f) => fs.existsSync(f);

test("register then unregister removes our global server + hooks (round-trip)", () => {
  const home = tmpHome();
  registerGlobalMcp({ home, platform: "linux" });
  const r = unregisterGlobalMcp({ home, platform: "linux" });
  assert.equal(r.removed["claude-code"], true);
  assert.ok(r.hooks > 0, "hook entries removed");
  const cfg = readJson(path.join(home, ".claude.json"));
  assert.ok(!("llm-wiki-memory" in (cfg.mcpServers || {})), "our server entry gone");
  fs.rmSync(home, { recursive: true, force: true });
});

test("unregister preserves the user's other servers + top-level keys", () => {
  const home = tmpHome();
  fs.writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { other: { command: "foo" } }, userKey: 7 }),
  );
  registerGlobalMcp({ home, platform: "linux" });
  unregisterGlobalMcp({ home, platform: "linux" });
  const cfg = readJson(path.join(home, ".claude.json"));
  assert.equal(cfg.mcpServers.other.command, "foo", "sibling server preserved");
  assert.equal(cfg.userKey, 7, "unrelated top-level key preserved");
  assert.ok(!("llm-wiki-memory" in cfg.mcpServers));
  fs.rmSync(home, { recursive: true, force: true });
});

test("unregister is idempotent (a second run removes nothing)", () => {
  const home = tmpHome();
  registerGlobalMcp({ home, platform: "linux" });
  unregisterGlobalMcp({ home, platform: "linux" });
  const r2 = unregisterGlobalMcp({ home, platform: "linux" });
  assert.equal(r2.removed["claude-code"], false);
  assert.equal(r2.hooks, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test("unregister strips a present codex block", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  registerGlobalMcp({ home, platform: "linux" });
  assert.ok(exists(path.join(home, ".codex", "config.toml")));
  const r = unregisterGlobalMcp({ home, platform: "linux" });
  assert.equal(r.removed.codex, true);
  // only our table → file removed
  assert.ok(
    !exists(path.join(home, ".codex", "config.toml")),
    "codex config removed (only our table)",
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test("removeStalePerRepo on a MOUNT (workspace !== home): strips per-repo mcp + agents + hooks", () => {
  const home = tmpHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mount-"));
  // Simulate a pre-global install's per-repo copies.
  fs.writeFileSync(
    path.join(repo, ".mcp.json"),
    JSON.stringify({ mcpServers: { "llm-wiki-memory": { command: "node" } } }),
  );
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "$HOME/.llm-wiki-memory/src/scripts/hooks/x.sh" }],
          },
        ],
      },
    }),
  );
  const r = removeStalePerRepo({ workspace: repo, home });
  assert.deepEqual(r.mcp, [".mcp.json"]);
  assert.ok(r.hooks > 0, "per-repo hooks stripped on a mount");
  const mcp = readJson(path.join(repo, ".mcp.json"));
  assert.ok(!("llm-wiki-memory" in mcp.mcpServers), "per-repo server entry removed");
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("removeStalePerRepo on a BRAIN (workspace === home): strips per-repo .mcp.json but NEVER the global hooks", () => {
  const home = tmpHome();
  registerGlobalMcp({ home, platform: "linux" }); // writes the GLOBAL ~/.claude/settings.json hooks
  // A stale pre-global per-repo .mcp.json at the brain workspace (== home).
  fs.writeFileSync(
    path.join(home, ".mcp.json"),
    JSON.stringify({ mcpServers: { "llm-wiki-memory": { command: "node" } } }),
  );
  const before = fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8");
  const r = removeStalePerRepo({ workspace: home, home });
  assert.deepEqual(r.mcp, [".mcp.json"], "stale per-repo .mcp.json removed");
  assert.equal(r.hooks, 0, "brain: global hooks NOT stripped as if per-repo");
  assert.equal(
    fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"),
    before,
    "global hooks file untouched for a brain",
  );
  fs.rmSync(home, { recursive: true, force: true });
});

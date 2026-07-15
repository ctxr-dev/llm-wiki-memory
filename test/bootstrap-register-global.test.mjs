import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerGlobalMcp } from "../scripts/bootstrap/register-global.mjs";

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "reg-global-"));
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

test("claude-code is always registered (config lives in $HOME) with the ${HOME} index", () => {
  const home = tmpHome();
  const r = registerGlobalMcp({ home, platform: "linux" });
  assert.equal(r["claude-code"], "registered");
  const cfg = readJson(path.join(home, ".claude.json"));
  assert.deepEqual(cfg.mcpServers["llm-wiki-memory"], {
    command: "node",
    args: ["${HOME}/.llm-wiki-memory/src/mcp-server/index.mjs"],
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test("hooks are merged into the user-scope ~/.claude/settings.json", () => {
  const home = tmpHome();
  registerGlobalMcp({ home, platform: "linux" });
  const s = readJson(path.join(home, ".claude", "settings.json"));
  assert.ok(s.hooks.SessionStart, "SessionStart hook present");
  assert.ok(s.hooks.PreToolUse, "PreToolUse gate present");
  fs.rmSync(home, { recursive: true, force: true });
});

test("a client whose config dir is absent is SKIPPED (not created)", () => {
  const home = tmpHome();
  const r = registerGlobalMcp({ home, platform: "linux" });
  assert.equal(r.cursor, "absent");
  assert.equal(r.codex, "absent");
  assert.ok(!fs.existsSync(path.join(home, ".cursor")), "~/.cursor not created");
  assert.ok(!fs.existsSync(path.join(home, ".codex")), "~/.codex not created");
  fs.rmSync(home, { recursive: true, force: true });
});

test("a present client dir IS registered; codex uses an ABSOLUTE index, cursor ${HOME}", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const r = registerGlobalMcp({ home, platform: "linux" });
  assert.equal(r.cursor, "registered");
  assert.match(r.codex, /created|appended|replaced/);
  assert.equal(
    readJson(path.join(home, ".cursor", "mcp.json")).mcpServers["llm-wiki-memory"].args[0],
    "${HOME}/.llm-wiki-memory/src/mcp-server/index.mjs",
  );
  const codex = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.match(
    codex,
    new RegExp(`args = \\["${home}/\\.llm-wiki-memory/src/mcp-server/index\\.mjs"\\]`),
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test("idempotent: a second run is byte-stable for claude.json + settings.json", () => {
  const home = tmpHome();
  registerGlobalMcp({ home, platform: "linux" });
  const a = fs.readFileSync(path.join(home, ".claude.json"), "utf8");
  const b = fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8");
  registerGlobalMcp({ home, platform: "linux" });
  assert.equal(fs.readFileSync(path.join(home, ".claude.json"), "utf8"), a);
  assert.equal(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"), b);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a customized (wrapped) claude-code entry is PRESERVED, siblings kept", () => {
  const home = tmpHome();
  fs.writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        "llm-wiki-memory": { command: "/usr/local/bin/prompt_security_mcp", args: ["node", "x"] },
        other: { command: "foo" },
      },
      unrelatedTopKey: 42,
    }),
  );
  registerGlobalMcp({ home, platform: "linux" });
  const cfg = readJson(path.join(home, ".claude.json"));
  assert.equal(cfg.mcpServers["llm-wiki-memory"].command, "/usr/local/bin/prompt_security_mcp");
  assert.equal(cfg.mcpServers.other.command, "foo");
  assert.equal(cfg.unrelatedTopKey, 42, "unrelated user config preserved");
  fs.rmSync(home, { recursive: true, force: true });
});

test("a CORRUPT ~/.claude.json is backed up + SKIPPED, NEVER clobbered; other clients still register", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  const claudeJson = path.join(home, ".claude.json");
  const corrupt = '{"mcpServers": {"other": {"command": "x"}}, TRUNCATED';
  fs.writeFileSync(claudeJson, corrupt);
  const r = registerGlobalMcp({ home, platform: "linux" });
  assert.equal(r["claude-code"], "corrupt-skipped", "corrupt global config skipped, not rewritten");
  assert.equal(
    fs.readFileSync(claudeJson, "utf8"),
    corrupt,
    "live ~/.claude.json UNTOUCHED (not clobbered)",
  );
  assert.equal(fs.readFileSync(`${claudeJson}.bak`, "utf8"), corrupt, "backed up to .bak");
  assert.equal(r.cursor, "registered", "other clients still register despite the corrupt one");
  fs.rmSync(home, { recursive: true, force: true });
});

test("a no-op re-register does NOT rewrite the file (O1: no churn / mtime stable)", () => {
  const home = tmpHome();
  registerGlobalMcp({ home, platform: "linux" });
  const f = path.join(home, ".claude.json");
  const mtime1 = fs.statSync(f).mtimeMs;
  registerGlobalMcp({ home, platform: "linux" });
  assert.equal(fs.statSync(f).mtimeMs, mtime1, "unchanged merge left the file's mtime untouched");
  fs.rmSync(home, { recursive: true, force: true });
});

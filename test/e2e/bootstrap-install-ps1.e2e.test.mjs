import { after } from "node:test";
import { test } from "../windows-only.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rmAll } from "./federation-helpers.mjs";
import { buildBootstrapHome, runBootstrapPs } from "./bootstrap-drive.mjs";

// Windows-only: drives the REAL bootstrap.ps1 via pwsh (C14-safe: junctioned
// node_modules, no npm install, scheduler OS calls skipped).
/** @type {string[]} */
const tmps = [];
after(() => rmAll(tmps));

const read = (/** @type {string} */ f) => fs.readFileSync(f, "utf8");
const exists = (/** @type {string} */ f) => fs.existsSync(f);

test("fresh default install: drives the REAL bootstrap.ps1 and writes only under %USERPROFILE%", () => {
  const h = buildBootstrapHome("bootstrap-ps-fresh", tmps);
  const r = runBootstrapPs(h, ["-Provider", "mock"]);
  assert.equal(r.status, 0, `bootstrap.ps1 failed:\n${r.stdout}\n${r.stderr}`);
  const { dataDir } = h;

  assert.ok(exists(path.join(dataDir, "wiki", ".layout", "layout.yaml")), "layout.yaml");
  assert.ok(exists(path.join(dataDir, "wiki", "index.md")), "wiki index.md");
  assert.ok(exists(path.join(dataDir, "wiki", ".git")), "private brain wiki/.git present");

  const env = read(path.join(dataDir, "settings", ".env"));
  assert.match(env, /^MEMORY_LLM_PROVIDER=mock$/m, ".env provider = mock");
  assert.match(read(path.join(dataDir, "settings", "settings.yaml")), /backend:\s*lexical/);

  const gi = read(path.join(h.home, ".gitignore"));
  assert.match(gi, /# >>> llm-wiki-memory >>>/);
  assert.match(gi, /^\/\.llm-wiki-memory$/m, "whole-tree ignore for a private brain");

  // GLOBAL-ONLY: server + hooks in the user-home config; nothing per-repo.
  assert.ok(!exists(path.join(h.home, ".mcp.json")), "no per-repo .mcp.json");
  const globalMcp = JSON.parse(read(path.join(h.home, ".claude.json")));
  // On Windows the index arg is ABSOLUTE: Claude Code's spawn env may not set
  // ${HOME} (it uses USERPROFILE), so a literal "${HOME}" would never resolve
  // and the server would fail to launch.
  assert.deepEqual(globalMcp.mcpServers["llm-wiki-memory"], {
    command: "node",
    args: [path.join(h.home, ".llm-wiki-memory", "src", "mcp-server", "index.mjs")],
  });
  const globalHooks = JSON.parse(read(path.join(h.home, ".claude", "settings.json")));
  assert.ok(globalHooks.hooks.SessionStart, "global hooks registered");
});

test("migration: a stale pre-global per-repo .mcp.json is stripped; our entry moves to the global config", () => {
  const h = buildBootstrapHome("bootstrap-ps-migrate", tmps);
  fs.writeFileSync(
    path.join(h.home, ".mcp.json"),
    JSON.stringify({ mcpServers: { "llm-wiki-memory": { command: "node", args: ["OLD.mjs"] } } }),
  );
  assert.equal(runBootstrapPs(h, ["-Provider", "mock"]).status, 0);
  const stale = JSON.parse(read(path.join(h.home, ".mcp.json")));
  assert.ok(!("llm-wiki-memory" in (stale.mcpServers || {})), "stale per-repo entry removed");
  const global = JSON.parse(read(path.join(h.home, ".claude.json")));
  assert.ok(global.mcpServers["llm-wiki-memory"], "server registered globally");
});

test("shared mount (-Template repo -CommitMemory): zero ~/ leakage, remote-read block, no wiki/.git", () => {
  const h = buildBootstrapHome("bootstrap-ps-shared", tmps);
  const r = runBootstrapPs(h, ["-Provider", "mock", "-Template", "repo", "-CommitMemory"]);
  assert.equal(r.status, 0, `bootstrap.ps1 failed:\n${r.stdout}\n${r.stderr}`);
  assert.ok(!exists(path.join(h.dataDir, "wiki", ".git")), "shared wiki has no standalone .git");
  for (const s of [".agents/rules", ".claude/skills", ".claude/rules", ".cursor/rules"]) {
    const dir = path.join(h.home, s);
    const ptrs = exists(dir)
      ? fs.readdirSync(dir).filter((e) => e.startsWith("llm-wiki-memory-"))
      : [];
    assert.deepEqual(ptrs, [], `${s}: no ~/ pointer files in a shared repo`);
  }
  const agents = read(path.join(h.home, "AGENTS.md"));
  assert.match(agents, /raw\.githubusercontent\.com\/ctxr-dev\/llm-wiki-memory\/main\//);
  assert.ok(!agents.includes("~/"), "no ~/ machine path leaked into the shared repo");
});

test("-Schedule hourly: renders the Task Scheduler .cmd wrapper under state/ (OS call skipped)", () => {
  const h = buildBootstrapHome("bootstrap-ps-sched", tmps);
  const r = runBootstrapPs(h, ["-Provider", "mock", "-Schedule", "hourly"]);
  assert.equal(r.status, 0, `bootstrap.ps1 failed:\n${r.stdout}\n${r.stderr}`);
  const wrapper = path.join(h.dataDir, "state", "cron-hourly.cmd");
  assert.ok(exists(wrapper), "the hourly .cmd wrapper is written");
  const body = read(wrapper);
  // The lines must survive as SEPARATE lines — a naive `& node | Set-Content
  // -NoNewline` concatenates the PowerShell output array into one unrunnable
  // command, yet still contains these substrings, so anchor on line starts.
  assert.ok(body.split(/\r?\n/).length >= 4, "wrapper is multi-line, not concatenated");
  assert.match(body, /^@echo off\s*$/m, "@echo off on its own first line");
  assert.match(body, /^set "MEMORY_DATA_DIR=/m, "wrapper pins MEMORY_DATA_DIR on its own line");
  assert.match(body, /"\s+".*cli\.mjs" cron-job\s*$/m, "cron-job invocation on its own line");
});

test("uninstall: strips the global server + hooks, leaves the wiki DATA intact", () => {
  const h = buildBootstrapHome("bootstrap-ps-uninstall", tmps);
  assert.equal(runBootstrapPs(h, ["-Provider", "mock"]).status, 0);
  assert.ok(exists(path.join(h.home, ".claude.json")), "installed");
  const u = runBootstrapPs(h, ["-Uninstall"]);
  assert.equal(u.status, 0, `uninstall failed:\n${u.stdout}\n${u.stderr}`);
  const global = JSON.parse(read(path.join(h.home, ".claude.json")));
  assert.ok(!("llm-wiki-memory" in (global.mcpServers || {})), "global server entry removed");
  assert.ok(
    exists(path.join(h.dataDir, "wiki", ".layout", "layout.yaml")),
    "wiki data intact after uninstall",
  );
});

test("install into a path with SPACES wires everything (Join-Path / arg quoting / schtasks /tr)", () => {
  const h = buildBootstrapHome("has spaces here", tmps);
  assert.ok(h.home.includes(" "), "precondition: the home path contains a space");
  const r = runBootstrapPs(h, ["-Provider", "mock", "-Schedule", "hourly"]);
  assert.equal(r.status, 0, `bootstrap.ps1 failed:\n${r.stdout}\n${r.stderr}`);
  assert.ok(exists(path.join(h.dataDir, "wiki", ".layout", "layout.yaml")), "wiki materialised");
  assert.ok(
    JSON.parse(read(path.join(h.home, ".claude.json"))).mcpServers["llm-wiki-memory"],
    "server registered despite the space",
  );
  const wrapper = path.join(h.dataDir, "state", "cron-hourly.cmd");
  assert.ok(exists(wrapper), "schedule wrapper written");
  assert.ok(read(wrapper).includes(h.dataDir), "wrapper pins the spaced data-dir path verbatim");
});

test("install into a NON-ASCII path succeeds; the schedule wrapper is not mangled to '?' (H2)", () => {
  const h = buildBootstrapHome("café-münchen", tmps);
  const r = runBootstrapPs(h, ["-Provider", "mock", "-Schedule", "hourly"]);
  assert.equal(r.status, 0, `bootstrap.ps1 failed:\n${r.stdout}\n${r.stderr}`);
  const wrapper = path.join(h.dataDir, "state", "cron-hourly.cmd");
  assert.ok(exists(wrapper), "wrapper written");
  if ([...h.home].some((ch) => ch.charCodeAt(0) > 127)) {
    // Read as latin1 so OEM bytes map to chars (not U+FFFD). The old `-Encoding
    // ascii` replaced the non-ASCII path char with '?' (0x3F); a path never
    // contains '?', so its presence in the data-dir line would prove H2.
    const raw = fs.readFileSync(wrapper, "latin1");
    const line = raw.split(/\r?\n/).find((l) => l.startsWith('set "MEMORY_DATA_DIR='));
    assert.ok(line && !line.includes("?"), "non-ASCII data-dir preserved (oem, not ascii)");
  }
});

test("re-running bootstrap.ps1 is idempotent (one gitignore block, one server entry, one @-include)", () => {
  const h = buildBootstrapHome("ps-idempotent", tmps);
  assert.equal(runBootstrapPs(h, ["-Provider", "mock"]).status, 0);
  assert.equal(runBootstrapPs(h, ["-Provider", "mock"]).status, 0);
  const gi = read(path.join(h.home, ".gitignore"));
  assert.equal(
    (gi.match(/# >>> llm-wiki-memory >>>/g) || []).length,
    1,
    "exactly one gitignore block",
  );
  const mcp = JSON.parse(read(path.join(h.home, ".claude.json")));
  assert.equal(
    Object.keys(mcp.mcpServers).filter((k) => k === "llm-wiki-memory").length,
    1,
    "server entry not duplicated",
  );
  const agents = read(path.join(h.home, "AGENTS.md"));
  assert.equal(
    (agents.match(/BEGIN llm-wiki-memory/g) || []).length,
    1,
    "exactly one AGENTS.md @-include block",
  );
});

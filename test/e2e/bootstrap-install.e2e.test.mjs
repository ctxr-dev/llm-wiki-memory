import { after } from "node:test";
import { test } from "../skip-windows.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { rmAll } from "./federation-helpers.mjs";
import { buildBootstrapHome, runBootstrap } from "./bootstrap-drive.mjs";

/** @type {string[]} */
const tmps = [];
after(() => rmAll(tmps));

const read = (f) => fs.readFileSync(f, "utf8");
const exists = (f) => fs.existsSync(f);

test("fresh default install: drives the REAL bootstrap.sh in /tmp (C14-safe) and writes only under $HOME", () => {
  const h = buildBootstrapHome("bootstrap-fresh", tmps);
  const r = runBootstrap(h, ["--provider", "mock"]);
  assert.equal(r.status, 0, `bootstrap failed:\n${r.stderr}`);

  // The copy-not-symlink invariant: bootstrap resolved SRC_DIR under /tmp, so
  // everything landed under the throwaway home — nothing on the real machine.
  const { home, dataDir } = h;
  assert.ok(home.startsWith("/private/") || home.startsWith("/tmp/"), "home is a /tmp realpath");

  // Wiki materialised (default template) + private-brain git.
  assert.ok(exists(path.join(dataDir, "wiki", ".layout", "layout.yaml")), "layout.yaml");
  assert.ok(exists(path.join(dataDir, "wiki", "index.md")), "wiki index.md");
  assert.ok(exists(path.join(dataDir, "wiki", ".git")), "private brain wiki/.git present");

  // Provider .env written deterministically (mock), settings.yaml kept (lexical).
  const env = read(path.join(dataDir, "settings", ".env"));
  assert.match(env, /^MEMORY_LLM_PROVIDER=mock$/m, ".env provider = mock");
  assert.match(
    read(path.join(dataDir, "settings", "settings.yaml")),
    /backend:\s*lexical/,
    "lexical settings kept (no model download)",
  );

  // whole-tree gitignore block.
  const gi = read(path.join(home, ".gitignore"));
  assert.match(gi, /# >>> llm-wiki-memory >>>/);
  assert.match(gi, /^\/\.llm-wiki-memory$/m, "whole-tree ignore for a private brain");

  // GLOBAL-ONLY (N2b/N3): the server + hooks live in the user-home config; NO
  // per-repo client config is written into the workspace.
  assert.ok(!exists(path.join(home, ".mcp.json")), "no per-repo .mcp.json");
  assert.ok(!exists(path.join(home, ".agents", "mcp.json")), "no per-repo .agents client bundle");
  assert.ok(!exists(path.join(home, ".agents", "clients")), "no .agents/clients bundle");
  const globalMcp = JSON.parse(read(path.join(home, ".claude.json")));
  assert.deepEqual(globalMcp.mcpServers["llm-wiki-memory"], {
    command: "node",
    args: ["${HOME}/.llm-wiki-memory/src/mcp-server/index.mjs"],
  });
  const globalHooks = JSON.parse(read(path.join(home, ".claude", "settings.json")));
  assert.ok(globalHooks.hooks.SessionStart, "global hooks registered");
});

test("migration: a stale pre-global per-repo .mcp.json is stripped, our entry moves to the global config", () => {
  const h = buildBootstrapHome("bootstrap-migrate", tmps);
  // Simulate a pre-global install's per-repo .mcp.json at the brain workspace.
  fs.writeFileSync(
    path.join(h.home, ".mcp.json"),
    JSON.stringify({ mcpServers: { "llm-wiki-memory": { command: "node", args: ["OLD.mjs"] } } }),
  );
  const r = runBootstrap(h, ["--provider", "mock"]);
  assert.equal(r.status, 0, `bootstrap failed:\n${r.stderr}`);
  const stale = JSON.parse(read(path.join(h.home, ".mcp.json")));
  assert.ok(
    !("llm-wiki-memory" in (stale.mcpServers || {})),
    "stale per-repo entry removed by migration",
  );
  const global = JSON.parse(read(path.join(h.home, ".claude.json")));
  assert.ok(global.mcpServers["llm-wiki-memory"], "server now registered globally");
});

test("shared mount (--template repo): writes NOTHING outside the mount; no wiki/.git", () => {
  const h = buildBootstrapHome("bootstrap-shared", tmps);
  const r = runBootstrap(h, ["--provider", "mock", "--template", "repo", "--commit-memory"]);
  assert.equal(r.status, 0, `bootstrap failed:\n${r.stderr}`);
  const { home, dataDir } = h;
  // The shared wiki is never given its own git (Workstream L git-safety).
  assert.ok(!exists(path.join(dataDir, "wiki", ".git")), "shared wiki has no standalone .git");
  // No per-surface pointer artifacts — neither the flat rule-surface files nor a
  // .claude/skills directory.
  for (const s of [".agents/rules", ".claude/skills", ".claude/rules", ".cursor/rules"]) {
    const dir = path.join(home, s);
    const ptrs = exists(dir)
      ? fs.readdirSync(dir).filter((e) => e.startsWith("llm-wiki-memory-"))
      : [];
    assert.deepEqual(ptrs, [], `${s}: no pointer artifacts in a shared repo`);
  }
  // And no AGENTS.md / CLAUDE.md at all. A shared mount is somebody else's
  // repository; the one per-machine engine install already supplies the rules,
  // skills and discipline to every directory on the box, so injecting a per-repo
  // copy would only duplicate them into a teammate's tree.
  for (const doc of ["AGENTS.md", "CLAUDE.md"]) {
    assert.ok(!exists(path.join(home, doc)), `${doc}: never written into a shared repo`);
  }
});

test("REFUSES a fresh private brain outside $HOME, leaving the workspace untouched", () => {
  // Drive the REAL bootstrap.sh from a repo-shaped workspace while $HOME points
  // somewhere else with no brain. This is the exact footgun the guard closes: it
  // used to succeed and wire the whole discipline into somebody's project tree.
  const h = buildBootstrapHome("bootstrap-refuse", tmps);
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-nohome-")));
  tmps.push(elsewhere);

  const r = spawnSync("bash", [path.join(h.srcCopy, "bootstrap.sh"), "--provider", "mock"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: elsewhere, // a home with NO brain
      LWM_BOOTSTRAP_SKIP_NPM: "1",
      LWM_BOOTSTRAP_SKIP_SCHED_OS: "1",
      MEMORY_EMBED_BACKEND: "lexical",
    },
  });

  assert.notEqual(r.status, 0, `bootstrap must refuse:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /no llm-wiki-memory brain yet/, "explains WHY it stopped");
  assert.match(r.stderr, /bootstrap\.sh --schedule hourly/, "offers the home install");

  // The refusal must be inert: nothing written into the workspace, and no wiki.
  assert.ok(!exists(path.join(h.dataDir, "wiki")), "no wiki materialised");
  // settings/settings.yaml is pre-seeded by the test harness, so assert on the
  // file BOOTSTRAP itself would have written (setup-env.mjs runs after the guard).
  assert.ok(!exists(path.join(h.dataDir, "settings", ".env")), "no .env written");
  for (const doc of ["AGENTS.md", "CLAUDE.md"]) {
    assert.ok(!exists(path.join(h.home, doc)), `${doc}: not written by a refused install`);
  }
  for (const d of [".agents/rules", ".claude/rules", ".claude/skills", ".cursor/rules"]) {
    assert.ok(!exists(path.join(h.home, d)), `${d}: not created by a refused install`);
  }
});

test(
  "--schedule hourly: writes the launchd plist (via render-schedule) under $HOME, no host mutation",
  { skip: process.platform !== "darwin" },
  () => {
    const h = buildBootstrapHome("bootstrap-sched", tmps);
    const r = runBootstrap(h, ["--provider", "mock", "--schedule", "hourly"]);
    assert.equal(r.status, 0, `bootstrap failed:\n${r.stderr}`);
    const agents = path.join(h.home, "Library", "LaunchAgents");
    const plists = exists(agents) ? fs.readdirSync(agents).filter((f) => f.endsWith(".plist")) : [];
    assert.equal(plists.length, 1, "exactly one plist under the fake $HOME");
    const plist = read(path.join(agents, plists[0]));
    assert.match(plist, /<string>com\.llm-wiki-memory\.\d+<\/string>/, "Label present");
    assert.match(plist, /<string>cron-job<\/string>/, "ProgramArguments invokes cron-job");
    assert.match(plist, /<key>PATH<\/key>/, "hybrid PATH baked in");
    assert.doesNotMatch(plist, /<string>\/bin\/sh<\/string>/, "no /bin/sh indirection");
  },
);

test("uninstall: strips the global server + hooks, leaves the wiki DATA intact", () => {
  const h = buildBootstrapHome("bootstrap-uninstall", tmps);
  assert.equal(runBootstrap(h, ["--provider", "mock"]).status, 0);
  assert.ok(exists(path.join(h.home, ".claude.json")), "installed");
  const u = runBootstrap(h, ["--uninstall"]);
  assert.equal(u.status, 0, `uninstall failed:\n${u.stderr}`);
  const global = JSON.parse(read(path.join(h.home, ".claude.json")));
  assert.ok(!("llm-wiki-memory" in (global.mcpServers || {})), "global server entry removed");
  const settings = path.join(h.home, ".claude", "settings.json");
  if (exists(settings)) {
    const s = JSON.parse(read(settings));
    const events = Object.values(s.hooks || {}).flat();
    const ours = events.some((g) =>
      (g?.hooks || []).some((x) =>
        String(x.command || "").includes(".llm-wiki-memory/src/scripts/hooks/"),
      ),
    );
    assert.ok(!ours, "our hook entries removed");
  }
  // Memory DATA is never deleted by uninstall.
  assert.ok(exists(path.join(h.dataDir, "wiki", ".layout", "layout.yaml")), "wiki data intact");
});

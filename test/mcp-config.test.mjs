// mcp-config.sh + committed client templates (D-f home-install model): project-
// scoped clients (Claude Code, Cursor) use the home-based ${HOME}/... path;
// genuinely global paste-snippets (Claude Desktop, Codex, generic) use a
// print-time absolute path (never committed). No config ships a MEMORY_DATA_DIR
// override (the server self-discovers its data dir — see scripts/lib/env.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_SH = path.join(SRC, "scripts", "mcp-config.sh");
const HOME_INDEX = "${HOME}/.llm-wiki-memory/src/mcp-server/index.mjs";

function emit(client) {
  const r = spawnSync("bash", [CONFIG_SH, client], { encoding: "utf8" });
  assert.equal(r.status, 0, `mcp-config.sh ${client} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

function assertFullyRendered(out, client) {
  assert.ok(!out.includes("__SERVER_INDEX__"), `${client}: __SERVER_INDEX__ left unrendered`);
  assert.ok(!out.includes("__DATA_DIR__"), `${client}: __DATA_DIR__ left unrendered`);
  assert.ok(
    !/\$\{(?!HOME[}:])/.test(out),
    `${client}: contains an unexpanded \${...} token other than the intended \${HOME}`,
  );
  assert.ok(!/MEMORY_DATA_DIR/.test(out), `${client}: must not set MEMORY_DATA_DIR`);
}

for (const client of ["claude-code", "cursor"]) {
  test(`mcp-config.sh ${client}: home-based \${HOME} server path, no env override`, () => {
    const out = emit(client);
    assertFullyRendered(out, client);
    assert.ok(out.includes(HOME_INDEX), `${client}: expected home-based path ${HOME_INDEX}`);
    // No hardcoded absolute server path leaked into a project-scoped config.
    assert.ok(
      !/"\/.*mcp-server\/index\.mjs"/.test(out) && !/'\/.*mcp-server\/index\.mjs'/.test(out),
      `${client}: must not contain a hardcoded absolute server path`,
    );
  });
}

// Global / unknown-cwd clients get a print-time absolute path (never committed):
// a paste-anywhere snippet cannot assume a cwd or that the client expands ${HOME}.
for (const client of ["claude-desktop", "codex", "generic"]) {
  test(`mcp-config.sh ${client}: absolute server path (global, no project cwd), no env override`, () => {
    const out = emit(client);
    assertFullyRendered(out, client);
    assert.match(out, /\/.*mcp-server\/index\.mjs/, `${client}: expected an absolute server path`);
    assert.ok(
      !out.includes(HOME_INDEX),
      `${client}: should not use the ${"${HOME}"} form globally`,
    );
  });
}

test("committed project-scoped templates carry no MEMORY_DATA_DIR and no absolute path", () => {
  // The claude-code template is fully relative (no placeholder). The .agents
  // templates carry the __SERVER_INDEX__ placeholder (rendered at install), so
  // we only assert the env block is gone and no literal absolute path is baked.
  const files = [
    "templates/mcp.json",
    "templates/agents/mcp.json",
    "templates/agents/clients/cursor.json",
    "templates/agents/clients/generic-mcp.json",
    "templates/agents/clients/claude-desktop.json",
    "templates/agents/clients/openai-codex.toml",
  ];
  for (const rel of files) {
    const raw = fs.readFileSync(path.join(SRC, rel), "utf8");
    assert.ok(!/MEMORY_DATA_DIR/.test(raw), `${rel}: must not declare MEMORY_DATA_DIR`);
    assert.ok(
      !/\/Users\/|\/home\/|\/opt\//.test(raw),
      `${rel}: must not hardcode an absolute path`,
    );
  }
  // The Claude Code template (literal, no placeholder) is home-based via ${HOME} (D-f).
  const claudeMcp = fs.readFileSync(path.join(SRC, "templates/mcp.json"), "utf8");
  assert.match(claudeMcp, /\$\{HOME\}\/\.llm-wiki-memory\/src\/mcp-server\/index\.mjs/);
});

test("global MCP registration uses the ${HOME}-based path (no absolute leak); bootstrap registers globally (N)", () => {
  // Global-only (Workstream N): the ${HOME}-based index lives in the client
  // registry, not an inlined bootstrap render; ${HOME} is interpolated by the
  // MCP client (a literal ~ would NOT expand in JSON args).
  const registry = fs.readFileSync(path.join(SRC, "scripts/bootstrap/mcp-clients.mjs"), "utf8");
  assert.match(
    registry,
    /SERVER_INDEX_REL\s*=\s*"\$\{HOME\}\/\.llm-wiki-memory\/src\/mcp-server\/index\.mjs"/,
  );
  assert.ok(
    !/["'][^"']*\/(Users|home|opt)\/[^"']*mcp-server\/index\.mjs/.test(registry),
    "no hardcoded absolute server path in the client registry",
  );
  // bootstrap registers into the user's HOME (no per-repo render survives).
  const raw = fs.readFileSync(path.join(SRC, "bootstrap.sh"), "utf8");
  assert.match(raw, /register-global\.mjs/, "bootstrap calls the global registrar");
  assert.ok(!/render_agent\b/.test(raw), "the per-repo .agents render is removed (global-only)");
  assert.ok(!/__DATA_DIR__/.test(raw), "bootstrap should no longer substitute __DATA_DIR__");
  // .claude/settings.json hooks are home-based ($HOME), not $CLAUDE_PROJECT_DIR.
  const settings = fs.readFileSync(path.join(SRC, "templates/claude/settings.json"), "utf8");
  assert.ok(!/CLAUDE_PROJECT_DIR/.test(settings), "hooks no longer use $CLAUDE_PROJECT_DIR");
  assert.ok(
    settings.includes("$HOME") && settings.includes("/.llm-wiki-memory/src/scripts/hooks/"),
    "hooks invoke $HOME-based paths",
  );
});

test("the ${HOME}-based server path points at the real mcp-server entry", () => {
  const tail = HOME_INDEX.replace("${HOME}/.llm-wiki-memory/src/", "");
  assert.ok(fs.existsSync(path.join(SRC, tail)), `server entry must exist on disk: ${tail}`);
});

test("shipped layout templates declare the subject axis", () => {
  for (const rel of [
    "examples/layouts/default/layout.yaml",
    "examples/layouts/tracker-issues/layout.yaml",
    "examples/layouts/repo/layout.yaml",
  ]) {
    const raw = fs.readFileSync(path.join(SRC, rel), "utf8");
    assert.match(raw, /vocabularies:/, `${rel}: must declare vocabularies`);
    assert.match(raw, /subject_domains:/, `${rel}: must declare subject_domains`);
    assert.match(
      raw,
      /subject:\s*\{\s*kind:\s*path/,
      `${rel}: knowledge must use a kind:path subject facet`,
    );
  }
});

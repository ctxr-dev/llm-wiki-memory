// mcp-config.sh + committed client templates: paths must be relative for
// project-scoped clients and absolute only for genuinely global ones, and no
// config should ship a MEMORY_DATA_DIR override (the server self-discovers its
// data dir from its own file location — see scripts/lib/env.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_SH = path.join(SRC, "scripts", "mcp-config.sh");
const REL_PATH = "./.llm-wiki-memory/src/mcp-server/index.mjs";

function emit(client) {
  const r = spawnSync("bash", [CONFIG_SH, client], { encoding: "utf8" });
  assert.equal(r.status, 0, `mcp-config.sh ${client} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

function assertFullyRendered(out, client) {
  assert.ok(!out.includes("__SERVER_INDEX__"), `${client}: __SERVER_INDEX__ left unrendered`);
  assert.ok(!out.includes("__DATA_DIR__"), `${client}: __DATA_DIR__ left unrendered`);
  assert.ok(!/\$\{/.test(out), `${client}: contains an unexpanded \${...} token`);
  assert.ok(!/MEMORY_DATA_DIR/.test(out), `${client}: must not set MEMORY_DATA_DIR`);
}

for (const client of ["claude-code", "cursor"]) {
  test(`mcp-config.sh ${client}: relative server path, no env override`, () => {
    const out = emit(client);
    assertFullyRendered(out, client);
    assert.ok(out.includes(REL_PATH), `${client}: expected relative path ${REL_PATH}`);
    // No absolute server path leaked into a project-scoped config.
    assert.ok(
      !/"\/.*mcp-server\/index\.mjs"/.test(out) && !/'\/.*mcp-server\/index\.mjs'/.test(out),
      `${client}: must not contain an absolute server path`,
    );
  });
}

// Global / unknown-cwd clients get an absolute path (resolved at print time,
// never committed). generic joins these: a generic client has no guaranteed cwd.
for (const client of ["claude-desktop", "codex", "generic"]) {
  test(`mcp-config.sh ${client}: absolute server path (global, no project cwd), no env override`, () => {
    const out = emit(client);
    assertFullyRendered(out, client);
    assert.match(out, /\/.*mcp-server\/index\.mjs/, `${client}: expected an absolute server path`);
    assert.ok(!out.includes(REL_PATH), `${client}: should not use the relative path globally`);
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
});

test("bootstrap renders .agents/ with the relative path (no absolute INDEX)", () => {
  const raw = fs.readFileSync(path.join(SRC, "bootstrap.sh"), "utf8");
  assert.match(raw, /INDEX_REL="\.\/\.llm-wiki-memory\/src\/mcp-server\/index\.mjs"/);
  // The old absolute-substituting render must be gone.
  assert.ok(!/INDEX_ABS=.*mcp-server\/index\.mjs/.test(raw), "stale INDEX_ABS render present");
  assert.ok(!/__DATA_DIR__/.test(raw), "bootstrap should no longer substitute __DATA_DIR__");
});

test("the relative server path actually resolves to the real mcp-server entry", () => {
  // REL_PATH is workspace-root-relative (./.llm-wiki-memory/src/...); SRC is
  // <workspace>/.llm-wiki-memory/src, so strip that prefix to map onto disk.
  const tail = REL_PATH.replace("./.llm-wiki-memory/src/", "");
  assert.ok(fs.existsSync(path.join(SRC, tail)), `relative path must point at a real file: ${tail}`);
});

test("shipped default + install template declare the subject axis", () => {
  for (const rel of ["examples/layouts/default/layout.yaml", "templates/llmwiki.layout.yaml"]) {
    const raw = fs.readFileSync(path.join(SRC, rel), "utf8");
    assert.match(raw, /vocabularies:/, `${rel}: must declare vocabularies`);
    assert.match(raw, /subject_domains:/, `${rel}: must declare subject_domains`);
    assert.match(raw, /subject:\s*\{\s*kind:\s*path/, `${rel}: knowledge must use a kind:path subject facet`);
  }
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setupWorkspace, cleanup, SRC, runScript } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const { INSTRUCTIONS, buildSessionStartContext } = await import("../scripts/lib/discipline.mjs");

test("INSTRUCTIONS names the core discipline tools", () => {
  for (const needle of [
    "recall_lessons",
    "save_lesson",
    "save_to_dataset",
    "search_memory",
    "UNTRUSTED",
  ]) {
    assert.ok(INSTRUCTIONS.includes(needle), `instructions mention ${needle}`);
  }
});

test("INSTRUCTIONS is single-sourced from templates/agents-memory-instructions.md (not hardcoded in discipline.mjs)", () => {
  const md = fs.readFileSync(path.join(SRC, "templates/agents-memory-instructions.md"), "utf8");
  const disc = fs.readFileSync(path.join(SRC, "scripts/lib/discipline.mjs"), "utf8");
  // The numbered rules live in the .md, NOT restated in the .mjs.
  assert.ok(md.includes("1. Before any non-trivial task"), "the .md carries rule 1");
  assert.ok(md.includes("15. DELEGATE THE CONTEXT-HEAVY READS"), "the .md carries rule 15");
  assert.ok(
    !disc.includes("1. Before any non-trivial task"),
    "discipline.mjs no longer hardcodes the numbered rules",
  );
  assert.ok(disc.includes("readFileSync"), "discipline.mjs reads the canonical .md");
  // INSTRUCTIONS is exactly the .md body with the maintainer HTML comment stripped.
  const expected = md.replace(/<!--[\s\S]*?-->\s*/g, "").trim();
  assert.equal(INSTRUCTIONS, expected, "INSTRUCTIONS === the comment-stripped .md body");
});

test("INSTRUCTIONS encodes the topology-path discipline (rule 10)", () => {
  assert.match(INSTRUCTIONS, /topology:` block/i);
  assert.match(INSTRUCTIONS, /MUST pass `path=`/);
  assert.match(INSTRUCTIONS, /REFUSED by the server/i);
});

test("INSTRUCTIONS encodes the attempt-first routing rule", () => {
  assert.match(INSTRUCTIONS, /health check IS the attempt/);
  assert.match(INSTRUCTIONS, /ALWAYS try the save FIRST/);
  assert.match(INSTRUCTIONS, /ONLY after an actual tool-call error/);
  assert.match(INSTRUCTIONS, /the local wiki is the DEFAULT, NOT your client's local file memory/);
});

test("buildSessionStartContext embeds INSTRUCTIONS and the server name + compile note", () => {
  const ctx = buildSessionStartContext({ serverName: "my-mem", compileTriggered: true });
  assert.ok(ctx.includes("my-mem"), "names the server");
  assert.ok(ctx.includes(INSTRUCTIONS), "reuses the shared INSTRUCTIONS (single source)");
  assert.ok(ctx.includes("Compile was triggered"), "compile note present");
});

test("SessionStart hook output carries the shared discipline", () => {
  const r = runScript("scripts/hooks/session-start.mjs", [], {
    stdin: "{}",
    env: { CLAUDE_INVOKED_BY: "memory_compile" }, // suppress real compile spawn
  });
  assert.equal(r.status, 0, `hook exit 0: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(
    ctx.includes("recall_lessons") && ctx.includes("save_lesson"),
    "discipline present in SessionStart context",
  );
});

test("SessionStart hook seeds the required `scopes` value within budget", () => {
  const r = runScript("scripts/hooks/session-start.mjs", [], {
    stdin: "{}",
    env: { CLAUDE_INVOKED_BY: "memory_compile" }, // suppress real compile spawn
  });
  assert.equal(r.status, 0, `hook exit 0: ${r.stderr}`);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  const idx = ctx.indexOf("Memory scopes for this session");
  assert.notEqual(idx, -1, "scopes-seed line present in SessionStart context");
  // The seed is ONE line; the next injected section (if any) begins after a
  // blank line, so the first paragraph after idx is the seed itself. Reuse the
  // per-section budget guard the other injected sections use.
  const seedLine = ctx.slice(idx).split("\n\n")[0];
  assert.match(seedLine, /REQUIRED/, "states the arg is required");
  assert.match(seedLine, /scopes/, "names the scopes argument");
  assert.ok(seedLine.length < 1024, `scopes-seed line under 1KB (got ${seedLine.length})`);
});

test("INSTRUCTIONS encodes the required-scopes discipline (rule 12)", () => {
  assert.match(INSTRUCTIONS, /SCOPES ARE REQUIRED ON EVERY TOOL/);
  assert.match(INSTRUCTIONS, /required `scopes: string\[\]`/);
  assert.match(INSTRUCTIONS, /NEVER optional/);
});

test("INSTRUCTIONS encodes the search-before-save dedup discipline (rule 16)", () => {
  assert.match(INSTRUCTIONS, /SEARCH BEFORE YOU SAVE/);
  assert.match(INSTRUCTIONS, /across EVERY dataset and every topology path/);
  assert.match(INSTRUCTIONS, /DELEGATE this to a SUBAGENT/);
  assert.match(INSTRUCTIONS, /CREATE-NEW vs UPDATE/);
  assert.match(INSTRUCTIONS, /PREFER UPDATING an existing leaf/);
  // The gated proposal must disclose new-vs-update (rule 2 cross-ref).
  assert.match(INSTRUCTIONS, /FIRST run the rule-16 dedup search/);
});

test("scopes discipline is mirrored on the template rule + skill surfaces", () => {
  const rule = fs.readFileSync(path.join(SRC, "templates/rules/tool-scopes.md"), "utf8");
  assert.match(rule, /scopes/, "tool-scopes rule names the argument");
  assert.match(rule, /never optional/i, "rule states scopes is never optional");
  const skill = fs.readFileSync(path.join(SRC, "templates/skills/scope-seeding.md"), "utf8");
  assert.match(skill, /name: scope-seeding/, "scope-seeding skill has its frontmatter name");
  assert.match(skill, /rev-parse --show-toplevel/, "skill computes scopes from cwd + git");
  assert.match(skill, /provider-agnostic/i, "skill documents the provider-agnostic constraint");
});

test("INSTRUCTIONS encodes the recall-delegation discipline (rule 15)", () => {
  assert.match(INSTRUCTIONS, /DELEGATE THE CONTEXT-HEAVY READS TO A SUBAGENT/);
  assert.match(INSTRUCTIONS, /`recall_lessons` or `search_memory`/);
  assert.match(INSTRUCTIONS, /DISTILLED digest/);
  assert.match(INSTRUCTIONS, /NEVER delegate a gated SAVE/);
  assert.match(INSTRUCTIONS, /WITHOUT subagents/);
});

test("recall-delegation discipline is mirrored on the template rule surface", () => {
  const rule = fs.readFileSync(path.join(SRC, "templates/rules/recall-delegation.md"), "utf8");
  assert.match(rule, /name: recall-delegation/, "rule has its frontmatter name");
  assert.match(rule, /recall_lessons/, "rule names the delegated reads");
  assert.match(rule, /distilled digest/i, "rule states the digest contract");
  assert.match(rule, /never a subagent/i, "rule keeps gated saves in the main chat");
  assert.match(rule, /without subagents/i, "rule gives the provider-agnostic fallback");
});

test("every MCP tool description carries the required-scopes clause (all three surfaces move together)", () => {
  const files = [
    "tools-config",
    "tools-search",
    "tools-write",
    "tools-documents",
    "tools-maintenance",
  ];
  let total = 0;
  for (const f of files) {
    const raw = fs.readFileSync(path.join(SRC, `mcp-server/${f}.mjs`), "utf8");
    total += (raw.match(/REQUIRES `scopes`/g) || []).length;
  }
  assert.equal(total, 18, `all 18 tool descriptions carry the scopes clause (got ${total})`);
  const readme = fs.readFileSync(path.join(SRC, "README.md"), "utf8");
  assert.match(
    readme,
    /Every tool takes a required `scopes`/,
    "README documents the scopes requirement",
  );
});

test("merge-marker.mjs is idempotent (one block after two runs)", () => {
  const f = path.join(dataDir, "AGENTS_test.md");
  fs.writeFileSync(f, "# Existing\n\nsome content\n");
  const run = () =>
    spawnSync(
      process.execPath,
      [path.join(SRC, "scripts/merge-marker.mjs"), f, "<!-- B -->", "<!-- E -->", "-"],
      {
        input: "pointer body v__N__",
        encoding: "utf8",
      },
    );
  run();
  const second = spawnSync(
    process.execPath,
    [path.join(SRC, "scripts/merge-marker.mjs"), f, "<!-- B -->", "<!-- E -->", "-"],
    { input: "pointer body v2", encoding: "utf8" },
  );
  assert.equal(second.status, 0);
  const text = fs.readFileSync(f, "utf8");
  assert.equal(text.match(/<!-- B -->/g).length, 1, "exactly one begin marker");
  assert.equal(text.match(/<!-- E -->/g).length, 1, "exactly one end marker");
  assert.ok(text.includes("pointer body v2"), "content replaced on re-run");
  assert.ok(text.startsWith("# Existing"), "pre-existing content preserved");
});

test("MCP server surfaces INSTRUCTIONS to the client on initialize", async () => {
  const client = new Client({ name: "disc-test", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    env: { ...process.env },
    cwd: SRC,
  });
  await client.connect(transport);
  try {
    const instr = client.getInstructions();
    assert.ok(
      instr && instr.includes("recall_lessons") && instr.includes("save_lesson"),
      "server instructions delivered on connect",
    );
  } finally {
    await client.close();
  }
});

// ─── cron PATH wiring guards (2026-06-04 provider-unavailable incident) ────

test("bootstrap passes the hybrid PATH into BOTH schedulers (plist + wrapper via render-schedule)", () => {
  // render-schedule.mjs bakes the PATH into the plist EnvironmentVariables + the
  // wrapper `export PATH` (golden-tested in bootstrap-render-schedule.test.mjs);
  // here we guard that bootstrap PASSES cron_path to both renderers.
  const bootstrap = fs.readFileSync(path.join(SRC, "bootstrap.sh"), "utf8");
  assert.match(
    bootstrap,
    /cron-path\.mjs/,
    "PATH comes from the shared node helper (single source of truth)",
  );
  assert.match(
    bootstrap,
    /RENDER_SCHED" plist "\$label" "\$DATA_DIR" "\$node_bin" "\$cli_path" "\$cron_path"/,
    "plist renderer receives the hybrid PATH",
  );
  assert.match(
    bootstrap,
    /RENDER_SCHED" wrapper "\$DATA_DIR" "\$cron_path"/,
    "wrapper renderer receives the hybrid PATH",
  );
});

test("no || true swallows the compile exit code on the cron path", () => {
  const cronJob = fs.readFileSync(path.join(SRC, "scripts", "cron-job.mjs"), "utf8");
  assert.ok(!/compile.*\|\|\s*true/.test(cronJob), "cron-job must observe compile's exit code");
  const bootstrap = fs.readFileSync(path.join(SRC, "bootstrap.sh"), "utf8");
  assert.ok(
    !/cli\.mjs["']?\s+compile.*\|\|\s*true/.test(bootstrap),
    "bootstrap must not swallow a compile exit",
  );
});

test("curated cron-path dirs are filesystem paths only (no provider/model name literals)", async () => {
  const { CURATED_CLI_DIRS } = await import("../scripts/lib/cron-path.mjs");
  for (const dir of CURATED_CLI_DIRS) {
    assert.ok(/^(~\/|\/)/.test(dir), `${dir} is a path`);
    assert.ok(
      !/claude|codex|cursor|gpt|anthropic|openai/i.test(dir),
      `${dir} carries no provider name`,
    );
  }
});

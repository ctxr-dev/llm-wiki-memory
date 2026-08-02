import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import matter from "gray-matter";
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

test("INSTRUCTIONS encodes the absorb discipline (rule 17)", () => {
  assert.match(INSTRUCTIONS, /ABSORB WHOLE DOCUMENTS via the `absorb` skill/);
  assert.match(INSTRUCTIONS, /FULL leaves/);
  assert.match(INSTRUCTIONS, /absorb_document/);
  assert.match(INSTRUCTIONS, /cli\.mjs absorb/);
  assert.match(INSTRUCTIONS, /REFUSE the gated `self_improvement` and topology `issues`/);
});

test("the absorb skill ships and @-pointer-wires to the surfaces", () => {
  const skill = fs.readFileSync(path.join(SRC, "templates/skills/absorb.md"), "utf8");
  assert.match(skill, /name: absorb/, "skill declares its name");
  assert.match(skill, /absorb_document/, "skill documents the MCP tool");
  assert.match(skill, /cli\.mjs absorb/, "skill documents the CLI");
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

test("INSTRUCTIONS encodes the content-quality discipline (rule 18)", () => {
  assert.match(INSTRUCTIONS, /POLISHED, DE-PERSONALIZED DOCUMENTATION/);
  assert.match(INSTRUCTIONS, /never quote or attribute the user/i);
  assert.match(INSTRUCTIONS, /EXEMPT: `daily`/);
});

test("content-quality discipline is mirrored on the template rule surface", () => {
  const rule = fs.readFileSync(path.join(SRC, "templates/rules/content-quality.md"), "utf8");
  assert.match(rule, /name: content-quality/, "rule has its frontmatter name");
  assert.match(rule, /never quotes the user/i, "rule forbids quoting the user");
  assert.match(rule, /de-personaliz/i, "rule mandates de-personalization");
  assert.match(rule, /`daily`.*EXEMPT|EXEMPT[\s\S]*`daily`/i, "rule exempts daily");
  assert.match(rule, /`absorb`.*EXEMPT|EXEMPT[\s\S]*`absorb`/i, "rule exempts absorb");
});

test("INSTRUCTIONS encodes the durability discipline (rule 19)", () => {
  assert.match(INSTRUCTIONS, /DURABILITY — NEVER PIN MEMORY TO VOLATILE CODE POSITIONS/);
  assert.match(INSTRUCTIONS, /NEVER record a line number/);
  assert.match(INSTRUCTIONS, /AVOID depending on file paths or internal symbol names/);
  assert.match(INSTRUCTIONS, /behaviour-preserving refactor/);
});

test("content-quality rule carries the durability section (no volatile locators)", () => {
  const rule = fs.readFileSync(path.join(SRC, "templates/rules/content-quality.md"), "utf8");
  assert.match(rule, /Durability — write knowledge that survives refactors/);
  assert.match(rule, /record a line number/);
  assert.match(rule, /KEEP the truly immutable anchors/);
});

test("INSTRUCTIONS encodes the recall-validation discipline (rule 20)", () => {
  assert.match(INSTRUCTIONS, /VALIDATE RECALLED MEMORY AGAINST REALITY BEFORE RELYING ON IT/);
  assert.match(INSTRUCTIONS, /a PRIOR, not ground truth/);
  assert.match(INSTRUCTIONS, /reconcile the memory BY CATEGORY/);
  assert.match(INSTRUCTIONS, /never a licence to bypass the self_improvement write-gate/);
});

test("recall-validation discipline is mirrored on the template rule surface", () => {
  const rule = fs.readFileSync(path.join(SRC, "templates/rules/recall-validation.md"), "utf8");
  assert.match(rule, /name: recall-validation/, "rule has its frontmatter name");
  assert.match(rule, /prior to verify/i, "rule frames recall as a prior");
  assert.match(rule, /UPDATE the leaf in place/, "non-gated: update in place");
  assert.match(rule, /PROPOSE the correction/, "gated: propose via the write-gate");
  assert.match(rule, /never fix or flag silently/i, "always surface");
});

test("every shipped SKILL template has PARSEABLE frontmatter with a name + description", () => {
  // The generated Claude Code SKILL.md copies these two fields, and Claude Code
  // lists a skill by them — so a template whose YAML does not parse (the classic
  // cause: an unquoted `: ` inside a plain scalar) ships a nameless, effectively
  // undiscoverable skill. Caught here rather than at install time.
  const dir = path.join(SRC, "templates/skills");
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
  assert.ok(files.length > 0, "skills are shipped");
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    let parsed;
    assert.doesNotThrow(() => {
      parsed = matter(raw);
    }, `${f}: frontmatter must parse (quote the description if it contains ": ")`);
    const data = /** @type {{ name?: unknown, description?: unknown }} */ (parsed?.data || {});
    assert.equal(typeof data.name, "string", `${f}: has a name`);
    assert.ok(
      typeof data.description === "string" && data.description.trim().length > 0,
      `${f}: has a non-empty description`,
    );
  }
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
  assert.equal(total, 19, `all 19 tool descriptions carry the scopes clause (got ${total})`);
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

test("INSTRUCTIONS encodes the large-body / edit-the-file discipline (rule 21)", () => {
  assert.match(INSTRUCTIONS, /NEVER INLINE A LARGE DOCUMENT/);
  // The failure is client-side, so the symptom an agent will actually see is named.
  assert.match(INSTRUCTIONS, /input JSON failed to parse/);
  assert.match(INSTRUCTIONS, /save-leaf --file/, "names the file-based route");
  assert.match(INSTRUCTIONS, /inline-body-too-large/, "names the server-side refusal too");
  assert.match(
    INSTRUCTIONS,
    /save-leaf` refuses `self_improvement`/,
    "the file route must not read as a way around the consent gate",
  );
  // The three-way decision: which door for WHICH kind of change.
  assert.match(INSTRUCTIONS, /PICK THE DOOR BY WHAT YOU ARE ACTUALLY CHANGING/);
  assert.match(
    INSTRUCTIONS,
    /FRONTMATTER ONLY[\s\S]{0,200}update_document_metadata/,
    "a facet-only change is routed to the no-body door",
  );
  assert.match(
    INSTRUCTIONS,
    /NEVER edit a `self_improvement`[\s\S]{0,200}gated/,
    "the Edit route is explicitly closed for gated categories",
  );
  assert.match(
    INSTRUCTIONS,
    /never tick the last checkbox/i,
    "a derived plan status means the confirmation gate is the LAST CHECKBOX, not a status write",
  );
});

test("the large-body warning reaches agents on the write tools themselves", () => {
  const src = fs.readFileSync(path.join(SRC, "mcp-server/tools-write.mjs"), "utf8");
  assert.match(src, /LARGE_BODY_NOTE/, "a shared note exists");
  const uses = src.match(/^\s*LARGE_BODY_NOTE \+$/gm) || [];
  assert.equal(uses.length, 2, "attached to the two body-carrying writers");
  // save_lesson bodies are short and consent-gated; the note would be noise there.
  const lessonBlock = src.slice(src.indexOf('"save_lesson"'), src.indexOf('"save_to_dataset"'));
  assert.ok(!lessonBlock.includes("LARGE_BODY_NOTE"), "not on save_lesson");
});

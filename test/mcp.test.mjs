import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setupWorkspace, cleanup, SRC, scopeClient } from "./harness.mjs";

const { dataDir } = setupWorkspace();

let client;
let transport;
// The pre-scopes callTool handle, captured before scopeClient injects `scopes`,
// so the hard-fail test can send a call with NO `scopes` at all.
let callToolRaw;

before(async () => {
  client = new Client({ name: "lwm-test", version: "0.0.0" }, { capabilities: {} });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    env: { ...process.env },
    cwd: SRC,
  });
  await client.connect(transport);
  callToolRaw = client.callTool.bind(client);
  scopeClient(client, [dataDir]);
});

after(async () => {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  cleanup(dataDir);
});

function parse(res) {
  return JSON.parse(res.content[0].text);
}

test("claude-code mcp template has no unexpanded ${...} tokens", () => {
  const raw = fs.readFileSync(path.join(SRC, "templates/mcp.json"), "utf8");
  assert.ok(!/\$\{/.test(raw), "template must not contain ${...} (not expanded in MCP env)");
  const cfg = JSON.parse(raw);
  const server = cfg.mcpServers["llm-wiki-memory"];
  assert.ok(server, "llm-wiki-memory server present");
  // No MEMORY_DATA_DIR override: the server self-locates via env.mjs WORKSPACE_DIR.
  assert.ok(!(server.env && "MEMORY_DATA_DIR" in server.env), "no MEMORY_DATA_DIR override");
});

test("server boots and registers the expected tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of [
    "get_memory_config",
    "list_datasets",
    "search_memory",
    "recall_lessons",
    "save_lesson",
    "save_to_dataset",
    "write_memory",
    "disable_document",
    "enable_document",
    "delete_document",
    "audit_memory",
    "validate_layout",
    "validate_topology",
    "reload_layout",
  ]) {
    assert.ok(names.includes(expected), `tool ${expected} registered`);
  }
});

test("reload_layout clears the caches and reports what it reloaded", async () => {
  const r = parse(await client.callTool({ name: "reload_layout", arguments: {} }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.reloaded, ["layout", "topology"]);
});

test("validate_layout validates the wiki's contract and never crashes the server", async () => {
  // Default (env-resolved wiki): the test wiki has a valid .layout/layout.yaml.
  const ok = parse(await client.callTool({ name: "validate_layout", arguments: {} }));
  assert.equal(ok.ok, true, `default wiki layout valid: ${JSON.stringify(ok)}`);

  // A missing layout path returns a structured failure, not a thrown crash.
  const missing = parse(
    await client.callTool({
      name: "validate_layout",
      arguments: { path: "/nonexistent/does-not-exist.yaml" },
    }),
  );
  assert.equal(missing.ok, false, "missing layout reports ok:false");
});

test("get_memory_config reports the wiki + categories", async () => {
  const cfg = parse(await client.callTool({ name: "get_memory_config", arguments: {} }));
  assert.ok(cfg.wikiRoot.includes(".llm-wiki-memory") || cfg.wikiRoot.includes("wiki"));
  assert.deepEqual(cfg.categories, [
    "knowledge",
    "self_improvement",
    "plans",
    "investigations",
    "daily",
  ]);
});

test("save_lesson then recall_lessons round-trips through the server", async () => {
  const saved = parse(
    await client.callTool({
      name: "save_lesson",
      arguments: {
        title: "Prefer index-rebuild-one over full rebuild on hot paths",
        body: "On hot paths, call index-rebuild-one per touched dir rather than a full rebuild.",
        // Required by the L3 write-gate (memory-write hardening): caller
        // must attest the user explicitly asked. In the round-trip test we
        // simulate that explicit ask.
        userRequested: true,
        metadata: {
          project_module: "testproj",
          task_type: "implementation",
          error_pattern: "full-rebuild-hot-path",
        },
        tags: ["performance"],
      },
    }),
  );
  assert.equal(saved.ok, true, "save_lesson ok");

  const recalled = parse(
    await client.callTool({
      name: "recall_lessons",
      arguments: { query: "rebuild hot path index", project_module: "testproj" },
    }),
  );
  assert.ok(recalled.lessonHits >= 1, "recall finds the lesson");
});

test("save_to_dataset upserts and search_memory finds it", async () => {
  const saved = parse(
    await client.callTool({
      name: "save_to_dataset",
      arguments: {
        dataset: "knowledge",
        name: "knowledge-mcp-note.md",
        text: "# MCP note\n\nThe stdio server is registered in .mcp.json.",
        metadata: { atom_type: "reference", project_module: "testproj" },
      },
    }),
  );
  assert.equal(saved.ok, true);

  const found = parse(
    await client.callTool({
      name: "search_memory",
      arguments: {
        query: "stdio server registered mcp.json",
        filters: { project_module: "testproj" },
      },
    }),
  );
  assert.ok(
    found.records.some((r) => r.documentName === "knowledge-mcp-note.md"),
    "search finds the note",
  );
});

test("move_document is registered", async () => {
  const { tools } = await client.listTools();
  assert.ok(tools.map((t) => t.name).includes("move_document"), "move_document registered");
});

test("move_document refuses a facet-category free-path move (structured, no crash)", async () => {
  // The default test layout has only facet/daily categories — none curated. A
  // facet leaf relocates by metadata, so a raw-path move must be refused with a
  // structured reason, not throw and kill the server.
  const saved = parse(
    await client.callTool({
      name: "save_to_dataset",
      arguments: {
        dataset: "knowledge",
        name: "knowledge-move-victim.md",
        text: "# Move victim\n\nA facet leaf relocates by metadata, never a raw path.",
        metadata: { atom_type: "reference", project_module: "testproj" },
      },
    }),
  );
  assert.equal(saved.ok, true);
  const id = saved.created.document.id;
  const res = parse(
    await client.callTool({
      name: "move_document",
      arguments: { documentId: id, toPath: "knowledge/elsewhere/knowledge-move-victim.md" },
    }),
  );
  assert.equal(res.ok, false, "facet move refused, not thrown");
  assert.match(res.reason, /facet/, `structured refusal reason: ${JSON.stringify(res)}`);
});

test("search_memory excerpts oversized hit bodies at the MCP boundary; fullContent opts out", async () => {
  const marker = "zqxoverflowmarker";
  const huge = `# Huge note\n\n${`${marker} padding sentence number. `.repeat(400)}`;
  assert.ok(huge.length > 5000, "body is genuinely large");
  const saved = parse(
    await client.callTool({
      name: "save_to_dataset",
      arguments: {
        dataset: "knowledge",
        name: "knowledge-huge-body.md",
        text: huge,
        metadata: { atom_type: "reference", project_module: "testproj" },
      },
    }),
  );
  assert.equal(saved.ok, true);

  const clipped = parse(
    await client.callTool({
      name: "search_memory",
      arguments: { query: `${marker} padding sentence`, filters: { project_module: "testproj" } },
    }),
  );
  const hit = clipped.records.find((r) => r.documentName === "knowledge-huge-body.md");
  assert.ok(hit, "huge note found");
  assert.ok(hit.content.length < 1000, `body excerpted, got ${hit.content.length}`);
  assert.equal(hit.truncated, true);
  assert.ok(hit.fullChars > hit.content.length, "fullChars records the original length");

  const full = parse(
    await client.callTool({
      name: "search_memory",
      arguments: {
        query: `${marker} padding sentence`,
        filters: { project_module: "testproj" },
        fullContent: true,
      },
    }),
  );
  const fullHit = full.records.find((r) => r.documentName === "knowledge-huge-body.md");
  assert.ok(fullHit.content.length > 1000, "fullContent returns the whole body");
  assert.equal(fullHit.truncated, undefined, "no truncation flag when full");
});

test("HARD FAIL: a tool call with missing or empty `scopes` is schema-rejected", async () => {
  // Phase C 5c contract: `scopes` is a REQUIRED, non-empty array on every tool.
  // The zod field shape (min(1) array, NOT .optional()) makes the SDK emit
  // required + minItems:1, so both a MISSING and an EMPTY `scopes` fail the
  // server-side input-schema validation before any handler runs. This SDK
  // surfaces that failure as a resolved `{ isError: true }` envelope (not a
  // thrown promise), same as the write-gate schema tests. We use the pre-scopes
  // raw handle so the harness's scopeClient does not backfill scopes.

  // (a) scopes entirely absent -> input-validation error.
  const missing = await callToolRaw({ name: "search_memory", arguments: { query: "anything" } });
  assert.equal(missing.isError, true, "missing scopes must be rejected");
  assert.match(missing.content[0].text, /scopes|Invalid arguments|Input validation/i);

  // (b) scopes present but empty -> input-validation error (min(1) on the array).
  const empty = await callToolRaw({
    name: "search_memory",
    arguments: { query: "anything", scopes: [] },
  });
  assert.equal(empty.isError, true, "empty scopes must be rejected");
  assert.match(empty.content[0].text, /scopes|Invalid arguments|Input validation/i);

  // Control: the SAME query with a valid scope is accepted (proves the failure
  // above is the scopes contract, not an unrelated error).
  const ok = await client.callTool({ name: "search_memory", arguments: { query: "anything" } });
  assert.notEqual(ok.isError, true, "a scoped search_memory call succeeds");
});

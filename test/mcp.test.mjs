import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setupWorkspace, cleanup, SRC } from "./harness.mjs";

const { dataDir } = setupWorkspace();

let client;
let transport;

before(async () => {
  client = new Client({ name: "lwm-test", version: "0.0.0" }, { capabilities: {} });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    env: { ...process.env },
    cwd: SRC,
  });
  await client.connect(transport);
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
  ]) {
    assert.ok(names.includes(expected), `tool ${expected} registered`);
  }
});

test("get_memory_config reports the wiki + categories", async () => {
  const cfg = parse(await client.callTool({ name: "get_memory_config", arguments: {} }));
  assert.ok(cfg.wikiRoot.includes(".llm-wiki-memory") || cfg.wikiRoot.includes("wiki"));
  assert.deepEqual(cfg.categories, ["knowledge", "self_improvement", "plans", "investigations", "daily"]);
});

test("save_lesson then recall_lessons round-trips through the server", async () => {
  const saved = parse(
    await client.callTool({
      name: "save_lesson",
      arguments: {
        title: "Prefer index-rebuild-one over full rebuild on hot paths",
        body: "On hot paths, call index-rebuild-one per touched dir rather than a full rebuild.",
        metadata: { project_module: "testproj", task_type: "implementation", error_pattern: "full-rebuild-hot-path" },
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
      arguments: { query: "stdio server registered mcp.json", filters: { project_module: "testproj" } },
    }),
  );
  assert.ok(found.records.some((r) => r.documentName === "knowledge-mcp-note.md"), "search finds the note");
});

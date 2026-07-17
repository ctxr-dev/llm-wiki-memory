// MCP boundary for `absorb_document` (single inline doc, text-only per D2):
//   - a valid absorb writes a FULL leaf (verbatim body, memory.full:true) into
//     the resolved target;
//   - dryRun returns a proposal and writes nothing;
//   - gated (self_improvement) and topology (issues) categories are refused.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setupWorkspace, cleanup, SRC, scopeClient } from "./harness.mjs";

const ISSUES_TOPOLOGY = `
  - path: issues
    placement_facets: []
    consolidate: none
    topology:
      strategy: caller_path
      helper:
        module: ./issues-helper.mjs
      file_kinds:
        knowledge:
          required_facets: [tracker, prefix, number]
          to_path: |
            function to_path({ tracker, prefix, number }) {
              const n = Number(number);
              return \`issues/\${tracker}/\${prefix}/\${Math.floor(n/1000)}/\${Math.floor((n%1000)/10)}/\${n%10}/\${prefix}-\${n}.md\`;
            }
          from_path: |
            function from_path(rel) {
              const m = /^issues\\/([^/]+)\\/([^/]+)\\/(\\d+)\\/(\\d+)\\/(\\d+)\\/[^/]+-(\\d+)\\.md$/.exec(rel);
              return m ? { tracker: m[1], prefix: m[2], number: parseInt(m[6], 10) } : null;
            }
      facet_inputs:
        tracker: { type: string }
        prefix: { type: string }
        number: { type: integer, minimum: 1 }
`;

const ws = setupWorkspace();
const lp = path.join(ws.wiki, ".layout", "layout.yaml");
fs.writeFileSync(lp, fs.readFileSync(lp, "utf8") + ISSUES_TOPOLOGY);

const env = {
  ...process.env,
  MEMORY_DATA_DIR: ws.dataDir,
  MEMORY_EMBED_BACKEND: "lexical",
  MEMORY_LLM_PROVIDER: "mock",
  MEMORY_LLM_MOCK_RESPONSE: JSON.stringify({ area: "billing", atom_type: "reference" }),
};

let client;
let transport;
before(async () => {
  client = new Client({ name: "absorb-mcp-test", version: "0.0.0" }, { capabilities: {} });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    env,
    cwd: SRC,
  });
  await client.connect(transport);
  scopeClient(client, [ws.dataDir]);
});
after(async () => {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  cleanup(ws.dataDir);
});

function absorb(write) {
  return client.callTool({ name: "absorb_document", arguments: { target: "brain", write } });
}
const BODY = "# Billing design\n\nHow billing works end to end.\n\n" + "x ".repeat(200);

test("absorb_document: writes a full leaf (verbatim body, memory.full:true) into the target", async () => {
  const res = await absorb({ text: BODY, name: "billing-design.md", category: "knowledge" });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.ok, true);
  const id = out.created.document.id;
  assert.ok(id.endsWith("billing-design.md"), id);
  const leaf = matter(fs.readFileSync(path.join(ws.wiki, id.split("/").join(path.sep)), "utf8"));
  assert.equal(leaf.content.trim(), BODY.trim(), "body verbatim");
  assert.equal(leaf.data.memory.full, true, "memory.full persisted");
});

test("absorb_document: dryRun returns a proposal and writes nothing", async () => {
  const res = await absorb({
    text: BODY,
    name: "billing-dry.md",
    category: "knowledge",
    dryRun: true,
  });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.dryRun, true);
  assert.ok(out.proposal.dir, "a proposed dir is returned");
  assert.ok(
    !fs.existsSync(path.join(ws.wiki, out.proposal.dir, "billing-dry.md")),
    "no leaf written",
  );
});

test("absorb_document: refuses the gated self_improvement category", async () => {
  const res = await absorb({ text: BODY, name: "l.md", category: "self_improvement" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /self_improvement/);
});

test("absorb_document: refuses a topology category (issues)", async () => {
  const res = await absorb({ text: BODY, name: "i.md", category: "issues" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /topology/);
});

// Force + validate `path` for topology categories (tracker `issues`):
//   - sync guard: a no-path save/update into a topology category THROWS
//     (never silently lands flat at the category root);
//   - MCP boundary: a SUPPLIED path must round-trip through the topology for
//     the leaf's file_kind, else the call is rejected;
//   - facet categories and topology-LESS categories are unaffected.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setupWorkspace, cleanup, SRC, scopeClient, brainTargetClient } from "./harness.mjs";

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
        plan:
          required_facets: [tracker, prefix, number, lifecycle, slug]
          enums:
            lifecycle: [pending, in-progress, done, archived]
          to_path: |
            function to_path({ tracker, prefix, number, lifecycle, slug }) {
              const n = Number(number);
              return \`issues/\${tracker}/\${prefix}/\${Math.floor(n/1000)}/\${Math.floor((n%1000)/10)}/\${n%10}/\${lifecycle}/\${prefix}-\${n}-\${slug}.plan.md\`;
            }
          from_path: |
            function from_path(rel) {
              const m = /^issues\\/([^/]+)\\/([^/]+)\\/(\\d+)\\/(\\d+)\\/(\\d+)\\/([^/]+)\\/(.+)\\.plan\\.md$/.exec(rel);
              if (!m) return null;
              const n = parseInt(m[3],10)*1000 + parseInt(m[4],10)*10 + parseInt(m[5],10);
              const stem = m[7];
              if (!stem.startsWith(\`\${m[2]}-\${n}-\`)) return null;
              return { tracker: m[1], prefix: m[2], number: n, lifecycle: m[6], slug: stem.slice(\`\${m[2]}-\${n}-\`.length) };
            }
      facet_inputs:
        tracker: { type: string }
        prefix: { type: string }
        number: { type: integer, minimum: 1 }
        lifecycle: { type: string }
        slug: { type: string, pattern: "^[A-Za-z0-9-]+$" }
`;

function installIssues(wiki, store) {
  const lp = path.join(wiki, ".layout", "layout.yaml");
  const cur = fs.readFileSync(lp, "utf8");
  if (!cur.includes("path: issues")) fs.writeFileSync(lp, cur + ISSUES_TOPOLOGY);
  store.resetLayoutCache();
}

// ─── Part A: sync guards (direct wiki-store) ───────────────────────────────

const wsA = setupWorkspace();
const store = await import("../scripts/lib/wiki-store.mjs");
installIssues(wsA.wiki, store);
after(() => cleanup(wsA.dataDir));

test("saveDocument: no-path write to a topology category throws (never flat-root)", () => {
  assert.throws(
    () =>
      store.saveDocument({
        name: "DEV-1-x.plan.md",
        text: "# x\n\nbody",
        datasetId: "issues",
      }),
    /topology block .* requires an explicit path/i,
  );
});

test("writeMemory: no-path write to a topology category throws (third door closed)", () => {
  assert.throws(
    () => store.writeMemory({ name: "DEV-9-z.plan.md", text: "# z\n\nb", datasetId: "issues" }),
    /topology block .* requires an explicit path/i,
  );
});

test("saveDocument: valid topology path succeeds and nests", () => {
  const r = store.saveDocument({
    name: "DEV-1-x.plan.md",
    text: "# x\n\nbody",
    datasetId: "issues",
    placementOverride: "issues/JIRA/DEV/0/0/1/pending",
  });
  assert.ok(r.created, "written");
  assert.ok(fs.existsSync(path.join(wsA.wiki, "issues/JIRA/DEV/0/0/1/pending/DEV-1-x.plan.md")));
});

test("updateDocMetadata: UNPINNED in-place stamp on a topology leaf pins to curDir (no throw, no flatten)", () => {
  // An unpinned in-place metadata stamp (e.g. a consolidate `stale` flag) on a
  // NESTED issues leaf must stay put — NOT throw, and NOT relocate to the
  // category root. Pre-fix this threw (non-fatal log, no stamp); the old
  // stale-instance code flattened it.
  const id = "issues/JIRA/DEV/0/0/1/pending/DEV-1-x.plan.md";
  const res = store.updateDocMetadata({
    datasetId: "issues",
    documentId: id,
    metadata: { stale: true },
  });
  assert.equal(res.ok, true, "in-place stamp succeeds without a path");
  assert.ok(!res.relocated, "leaf was NOT relocated");
  assert.ok(
    fs.existsSync(path.join(wsA.wiki, "issues/JIRA/DEV/0/0/1/pending/DEV-1-x.plan.md")),
    "leaf stayed at its nested topology path",
  );
  assert.ok(
    !fs.existsSync(path.join(wsA.wiki, "issues/DEV-1-x.plan.md")),
    "leaf did NOT land flat at the category root",
  );
  const leaf = store.readLeafForConsolidate({ documentId: id });
  assert.equal(leaf.memory.stale, true, "the stamp was applied in place");
});

test("updateDocMetadata: an explicit pin to the leaf's dir still works", () => {
  const id = "issues/JIRA/DEV/0/0/1/pending/DEV-1-x.plan.md";
  const ok = store.updateDocMetadata({
    datasetId: "issues",
    documentId: id,
    metadata: { tags: "a" },
    placementOverride: "issues/JIRA/DEV/0/0/1/pending",
  });
  assert.equal(ok.ok, true, "pinned update succeeds");
});

test("facet category is unaffected: no-path knowledge save still nests by facet", () => {
  const r = store.writeMemory({
    name: "knowledge-ok-2026-06-08-000000000.md",
    text: "# ok\n\nfact.\nWhy: y.",
    datasetId: "knowledge",
    metadata: { atom_type: "decision", project_module: "billing" },
  });
  assert.ok(r.created.document.id.startsWith("knowledge/billing/decision/"), r.created.document.id);
});

// ─── Part B: MCP boundary round-trip validation ────────────────────────────

const wsB = setupWorkspace();
const store2 = await import("../scripts/lib/wiki-store.mjs");
installIssues(wsB.wiki, store2);
const envB = { ...process.env, MEMORY_DATA_DIR: wsB.dataDir };

let client;
let transport;
before(async () => {
  client = new Client({ name: "topo-save-test", version: "0.0.0" }, { capabilities: {} });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    env: envB,
    cwd: SRC,
  });
  await client.connect(transport);
  scopeClient(client, [wsB.dataDir]);
  brainTargetClient(client);
});
after(async () => {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  cleanup(wsB.dataDir);
});

async function save(args) {
  return client.callTool({ name: "save_to_dataset", arguments: { write: args } });
}

test("MCP save_to_dataset(issues) with NO path is rejected with an actionable message", async () => {
  const res = await save({ dataset: "issues", name: "DEV-2-y.plan.md", text: "# y\n\nb" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /requires an explicit path/i);
  assert.match(res.content[0].text, /layout\.yaml/);
});

test("MCP save_to_dataset(issues) with a WRONG-shape path is rejected", async () => {
  const res = await save({
    dataset: "issues",
    name: "DEV-2-y.plan.md",
    text: "# y\n\nb",
    path: "issues/JIRA/DEV/0/0/2", // plan path missing the <lifecycle> segment
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /does not match|topology kind/i);
});

test("MCP save_to_dataset(issues): a plan path for a non-.plan name is rejected (kind mismatch)", async () => {
  const res = await save({
    dataset: "issues",
    name: "DEV-2.md", // knowledge name
    text: "# y\n\nb",
    path: "issues/JIRA/DEV/0/0/2/pending", // plan-shaped dir
  });
  assert.equal(res.isError, true);
});

test("MCP save_to_dataset(issues): valid plan path accepted + nested", async () => {
  const res = await save({
    dataset: "issues",
    name: "DEV-2-y.plan.md",
    text: "# y\n\nb",
    path: "issues/JIRA/DEV/0/0/2/pending",
  });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.ok(fs.existsSync(path.join(wsB.wiki, "issues/JIRA/DEV/0/0/2/pending/DEV-2-y.plan.md")));
});

test("MCP save_to_dataset(issues): valid knowledge no-lifecycle path accepted", async () => {
  const res = await save({
    dataset: "issues",
    name: "DEV-2.md",
    text: "# k\n\nlink",
    path: "issues/JIRA/DEV/0/0/2",
  });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  assert.ok(fs.existsSync(path.join(wsB.wiki, "issues/JIRA/DEV/0/0/2/DEV-2.md")));
});

test("MCP save_to_dataset(knowledge): no-path facet save still works (topology gate not applied)", async () => {
  const res = await save({
    dataset: "knowledge",
    name: "knowledge-mcp-ok-2026-06-08-000000000.md",
    text: "# ok\n\nfact.\nWhy: y.",
    metadata: { atom_type: "decision", project_module: "billing" },
  });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
});

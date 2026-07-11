// Coverage for the round-2 review fixes (R2-1, R2-2, O-1).
//   - R2-1: empty allow-list short-circuits runConsolidate (workingSetSize===0).
//   - R2-2: every skip path includes llmRequested in the return shape.
//   - O-1:  L3 gate also fires when `path` lands the write in self_improvement
//           even if `dataset` claims a non-gated category.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setupWorkspace, cleanup, SRC, runScript } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const { consolidateMemory } = await import("../scripts/consolidate.mjs");

test("R2-1: passes:[] short-circuits with workingSetSize===0", async () => {
  // Seed a leaf in self_improvement so the working set would have something
  // to walk if the short-circuit weren't there. The post-fix orchestrator
  // must NOT touch it (workingSetSize===0 + all totals zero).
  const store = await import("../scripts/lib/wiki-store.mjs?v=R2-1");
  runScript("scripts/cli.mjs", ["init"]);
  store.saveDocument({
    name: "lesson-r2-1-seed.md",
    text: "# Seed\n\nBody.",
    datasetId: "self_improvement",
    metadata: {
      project_module: "testproj",
      area: "frontend",
      task_type: "debugging",
      error_pattern: "r2-1-seed",
      atom_type: "self-improvement-lesson",
    },
  });

  const r = await consolidateMemory({
    passes: [],
    llm: false,
    dryRun: false,
    now: new Date("2026-06-02T18:00:00Z"),
  });
  assert.equal(r.ok, true, "ok");
  assert.equal(r.workingSetSize, 0, "short-circuited: no working-set walk");
  assert.equal(r.totals.archived, 0);
  assert.equal(r.totals.touched, 0);
  assert.equal(r.totals.flagged, 0);
});

test("R2-1: passes:'' (empty string) is treated the same as empty array", async () => {
  const r = await consolidateMemory({
    passes: "",
    llm: false,
    dryRun: true,
    now: new Date("2026-06-02T18:05:00Z"),
  });
  assert.equal(r.ok, true);
  assert.equal(r.workingSetSize, 0);
});

test("R2-2: 'not-due' skip return includes llmRequested + llm:false", async () => {
  // First run materialises state so the second can hit the throttle.
  await consolidateMemory({
    passes: ["dedupe-by-sha256"],
    llm: false,
    dryRun: false,
    now: new Date("2026-06-02T19:00:00Z"),
  });
  const skip = await consolidateMemory({
    passes: ["dedupe-by-sha256"],
    ifDue: true,
    llm: false,
    now: new Date("2026-06-02T19:30:00Z"), // 30min later, well inside default cadence
  });
  assert.equal(skip.ok, true);
  assert.equal(skip.skipped, "not-due");
  // llmRequested should be present on the skip path so consumers don't see
  // undefined when destructuring.
  assert.equal(typeof skip.llmRequested, "boolean", "llmRequested present on skip");
  assert.equal(skip.llm, false, "llm: false on skip");
});

test("R2-2: 'locked-by' skip return also includes llmRequested + llm:false", async () => {
  // Hard to provoke a real lock contention in a single test process without
  // forking. Instead: write a fresh lock file pointing at THIS process so
  // acquireLock's "alive + fresh" gate keeps it occupied, then call
  // consolidate — it must return `{skipped:"locked-by"}` with the same
  // post-fix llmRequested + llm shape.
  const fs = await import("node:fs");
  const lockPath = path.join(dataDir, "state", ".compile.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 9999999, startedAt: new Date().toISOString(), label: "test-fixture" }) +
      "\n",
  );
  // pid 9999999 is unlikely to exist; the lock module may treat it as dead.
  // To force a fresh-lock branch deterministically, point the lock at OUR pid.
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      label: "test-fixture",
    }) + "\n",
  );

  const r = await consolidateMemory({
    passes: ["dedupe-by-sha256"],
    llm: false,
    force: true, // bypass not-due so we land on the lock branch
    now: new Date("2026-06-02T20:00:00Z"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, "locked-by");
  assert.equal(typeof r.llmRequested, "boolean", "llmRequested present on lock skip");
  assert.equal(r.llm, false, "llm: false on lock skip");

  // Clean up the fake lock so subsequent tests don't pile contention.
  try {
    fs.rmSync(lockPath);
  } catch {
    /* ignore */
  }
});

// O-1: path-bypass of the L3 gate. We use the MCP stdio wire because the
// gate lives in the server handler, not impl.saveDocument.
test("O-1: save_to_dataset(dataset='knowledge', path='self_improvement/...') is REFUSED without userRequested", async () => {
  const tmp = setupWorkspace();
  const client = new Client({ name: "r2-o1", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    env: { ...process.env, MEMORY_DATA_DIR: tmp.dataDir },
    cwd: SRC,
  });
  try {
    await client.connect(transport);
    runScript("scripts/cli.mjs", ["init"], { env: { MEMORY_DATA_DIR: tmp.dataDir } });
    const res = await client.callTool({
      name: "save_to_dataset",
      arguments: {
        dataset: "knowledge",
        name: "smuggled.md",
        text: "# Smuggled\n\nThis would have landed in self_improvement.",
        path: "self_improvement/sneaky",
        // No userRequested -> must be refused now that the gate also checks
        // the path-resolved category.
      },
    });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.ok, false, "gate refused the path-bypass write");
    assert.equal(payload.error, "write-gate-refused");
    assert.match(payload.message, /self_improvement/i);
  } finally {
    await client.close().catch(() => {});
    cleanup(tmp.dataDir);
  }
});

test("O-1: same call with userRequested:true succeeds (and lands under self_improvement)", async () => {
  const tmp = setupWorkspace();
  const client = new Client({ name: "r2-o1b", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    env: { ...process.env, MEMORY_DATA_DIR: tmp.dataDir },
    cwd: SRC,
  });
  try {
    await client.connect(transport);
    runScript("scripts/cli.mjs", ["init"], { env: { MEMORY_DATA_DIR: tmp.dataDir } });
    const res = await client.callTool({
      name: "save_to_dataset",
      arguments: {
        dataset: "knowledge",
        name: "smuggled-ok.md",
        text: "# Smuggled-OK\n\nUser explicitly asked.",
        path: "self_improvement/auditable",
        userRequested: true,
      },
    });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.ok, true, "userRequested:true allows the path-routed write");
  } finally {
    await client.close().catch(() => {});
    cleanup(tmp.dataDir);
  }
});

test("O-1: save_to_dataset(dataset='knowledge', path='knowledge/...') is NOT gated", async () => {
  const tmp = setupWorkspace();
  const client = new Client({ name: "r2-o1c", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    env: { ...process.env, MEMORY_DATA_DIR: tmp.dataDir },
    cwd: SRC,
  });
  try {
    await client.connect(transport);
    runScript("scripts/cli.mjs", ["init"], { env: { MEMORY_DATA_DIR: tmp.dataDir } });
    const res = await client.callTool({
      name: "save_to_dataset",
      arguments: {
        dataset: "knowledge",
        name: "knowledge-note.md",
        text: "# Knowledge note\n\nA plain knowledge artefact.",
        path: "knowledge/general",
        // No userRequested - not gated for knowledge.
      },
    });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.ok, true, "knowledge writes still ungated");
  } finally {
    await client.close().catch(() => {});
    cleanup(tmp.dataDir);
  }
});

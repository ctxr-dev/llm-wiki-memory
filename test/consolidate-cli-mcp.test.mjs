import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setupWorkspace, cleanup, SRC } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(SRC, "scripts", "cli.mjs");
const BOOTSTRAP = path.join(SRC, "bootstrap.sh");

function freshDataDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

function runConsolidateCli(args, dataDir) {
  return spawnSync(process.execPath, [CLI, "consolidate", ...args], {
    cwd: SRC,
    encoding: "utf8",
    env: {
      ...process.env,
      MEMORY_DATA_DIR: dataDir,
      MEMORY_EMBED_BACKEND: "lexical",
      MEMORY_LLM_PROVIDER: "mock",
      MEMORY_LLM_MOCK_RESPONSE: '{"ok":true}',
      LLM_WIKI_NO_PROMPT: "1",
    },
  });
}

function ensureWikiInit(dataDir) {
  const r = spawnSync(process.execPath, [CLI, "init"], {
    cwd: SRC,
    encoding: "utf8",
    env: {
      ...process.env,
      MEMORY_DATA_DIR: dataDir,
      MEMORY_EMBED_BACKEND: "lexical",
      LLM_WIKI_NO_PROMPT: "1",
    },
  });
  if (r.status !== 0) {
    throw new Error(`wiki init failed: ${r.stderr || r.stdout}`);
  }
}

// -------- CLI surface --------

test("CLI: consolidate --dry-run --json --no-llm exits 0 with ok+dryRun in JSON", () => {
  const dataDir = freshDataDir("consolidate-cli-dry");
  try {
    ensureWikiInit(dataDir);
    const r = runConsolidateCli(["--dry-run", "--json", "--no-llm"], dataDir);
    assert.equal(r.status, 0, `cli exited non-zero; stderr=${r.stderr}; stdout=${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true, "result.ok === true");
    assert.equal(parsed.dryRun, true, "result.dryRun === true");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("CLI: --passes=dedupe-by-sha256 succeeds (single known pass)", () => {
  const dataDir = freshDataDir("consolidate-cli-known");
  try {
    ensureWikiInit(dataDir);
    const r = runConsolidateCli(
      ["--dry-run", "--json", "--no-llm", "--passes=dedupe-by-sha256"],
      dataDir,
    );
    assert.equal(r.status, 0, `cli exited non-zero; stderr=${r.stderr}; stdout=${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.dryRun, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("CLI: --passes=unknown_pass still succeeds (unknown name → no passes run, but ok)", () => {
  const dataDir = freshDataDir("consolidate-cli-unknown");
  try {
    ensureWikiInit(dataDir);
    const r = runConsolidateCli(
      ["--dry-run", "--json", "--no-llm", "--passes=unknown_pass"],
      dataDir,
    );
    assert.equal(r.status, 0, `cli exited non-zero; stderr=${r.stderr}; stdout=${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true, "unknown pass name does not cause a failure");
    assert.equal(parsed.dryRun, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// -------- MCP surface --------

const { dataDir: mcpDataDir } = setupWorkspace();
let client;
let transport;

before(async () => {
  client = new Client({ name: "lwm-consolidate-test", version: "0.0.0" }, { capabilities: {} });
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
  cleanup(mcpDataDir);
});

function parse(res) {
  return JSON.parse(res.content[0].text);
}

test("MCP: consolidate_memory is registered as a tool", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("consolidate_memory"), "consolidate_memory tool registered");
});

test("MCP: consolidate_memory call succeeds WITHOUT userRequested (not write-gated)", async () => {
  const res = parse(
    await client.callTool({
      name: "consolidate_memory",
      arguments: { dryRun: true, llm: false },
    }),
  );
  assert.equal(res.ok, true, `consolidate_memory ok; raw=${JSON.stringify(res)}`);
  assert.equal(res.dryRun, true, "MCP dry-run flag honoured");
});

// -------- Bootstrap cron chain --------

test("bootstrap.sh schedule_job invokes the cron-job CLI subcommand", () => {
  const raw = fs.readFileSync(BOOTSTRAP, "utf8");
  const startIdx = raw.indexOf("schedule_job()");
  assert.ok(startIdx >= 0, "schedule_job function present in bootstrap.sh");
  const body = raw.slice(startIdx, startIdx + 4000);
  const lineMatch = body.match(/^\s*local\s+job_cmd=.*$/m);
  assert.ok(lineMatch, `schedule_job body must define a job_cmd assignment; body head=${body.slice(0, 400)}`);
  const jobCmdLine = lineMatch[0];
  // The cron-job subcommand chains compile + consolidate --if-due internally
  // (see scripts/cron-job.mjs) and writes the attempt log. The cron entry
  // therefore stays a single token: cron-job.
  assert.ok(jobCmdLine.includes("cron-job"), `job_cmd line invokes the cron-job subcommand; got ${jobCmdLine}`);
});

test("bootstrap.sh installs cron at hourly cadence (0 * * * *)", () => {
  const raw = fs.readFileSync(BOOTSTRAP, "utf8");
  // The Linux cron line is interpolated with $wrapper / $tag, so we match
  // the literal "0 * * * *" prefix.
  assert.match(raw, /local line="0 \* \* \* \*/, "cron entry uses hourly cadence (0 * * * *)");
});

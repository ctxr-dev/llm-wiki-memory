// The inline-body byte cap (gate.maxInlineBodyBytes) at the MCP write boundary.
//
// Three claims here are ORDERING claims, and each has a test that fails if the
// gates are reordered: consent refuses BEFORE size, size refuses BEFORE the
// quality judge (so no provider round-trip is burned), and the cap is
// independent of gate.enabled. The absorb_document acceptance test is the guard
// against a future author moving the cap down into saveDocument, where it would
// break verbatim whole-document imports.

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SRC, scopeClient, nestClient, brainTargetClient } from "./harness.mjs";

const DEFAULT_CAP = 32_768;

// `extraYaml` REPLACES the default quality block when it declares one — YAML
// rejects a duplicate top-level key, and a rejected file silently falls back to
// the shipped defaults, which would make a scenario pass for the wrong reason.
/** @param {string} extraYaml */
function makeWorkspace(extraYaml = "") {
  const quality = extraYaml.includes("quality:") ? "" : "quality:\n  judgeEnabled: false\n";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-size-"));
  const env = {
    ...process.env,
    MEMORY_DATA_DIR: dataDir,
    MEMORY_DEFAULT_PROJECT_MODULE: "testproj",
    LLM_WIKI_SKILL_CLI: path.join(SRC, "node_modules/@ctxr/skill-llm-wiki/scripts/cli.mjs"),
    LLM_WIKI_FIXED_TIMESTAMP: "1700000000",
    LLM_WIKI_NO_PROMPT: "1",
  };
  fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "settings", "settings.yaml"),
    `embed:\n  backend: lexical\n${quality}${extraYaml}`,
  );
  const init = spawnSync(process.execPath, [path.join(SRC, "scripts/cli.mjs"), "init"], {
    env,
    encoding: "utf8",
  });
  if (init.status !== 0) throw new Error(`wiki init failed: ${init.stderr || init.stdout}`);
  return { dataDir, env };
}

async function connect(env, dataDir) {
  const client = new Client({ name: "lwm-size-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(SRC, "mcp-server/index.mjs")],
      env,
      cwd: SRC,
    }),
  );
  return brainTargetClient(nestClient(scopeClient(client, [dataDir])));
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function parse(res) {
  return JSON.parse(res.content[0].text);
}

// A body of EXACTLY `bytes` UTF-8 bytes (ASCII only, so bytes === chars), with a
// searchable marker. Exact rather than "at least": the under-the-cap fixture has
// to land on the intended side of the bound, not merely near it.
function bodyOfBytes(bytes, marker) {
  const head = `# ${marker}\n\n`;
  const filler = `${marker} padding sentence. `;
  const text = (head + filler.repeat(Math.ceil(bytes / filler.length))).slice(0, bytes);
  assert.equal(Buffer.byteLength(text, "utf8"), bytes, "fixture is exactly the requested size");
  return text;
}

const OVERSIZE = bodyOfBytes(DEFAULT_CAP + 8_000, "sizeprobe");

const ws = makeWorkspace();
let client;

before(async () => {
  client = await connect(ws.env, ws.dataDir);
});

after(async () => {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  rmDir(ws.dataDir);
});

function leafExists(dataDir, name) {
  const wiki = path.join(dataDir, "wiki", "knowledge");
  const stack = [wiki];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
      else if (e.name === name) return true;
    }
  }
  return false;
}

test("save_to_dataset refuses an oversized inline body and does NOT write the leaf", async () => {
  const res = parse(
    await client.callTool({
      name: "save_to_dataset",
      arguments: {
        write: {
          dataset: "knowledge",
          name: "knowledge-oversize.md",
          text: OVERSIZE,
          metadata: { atom_type: "reference", area: "sizeprobe" },
        },
      },
    }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "inline-body-too-large");
  assert.equal(res.maxBytes, DEFAULT_CAP);
  assert.ok(res.bytes > DEFAULT_CAP, `reports the actual size, got ${res.bytes}`);
  assert.match(res.message, /save-leaf --file/, "the refusal names the file-based door");
  assert.match(res.message, /update_document_metadata/, "and the no-body frontmatter door");
  assert.equal(
    leafExists(ws.dataDir, "knowledge-oversize.md"),
    false,
    "the refusal happened BEFORE any write",
  );
});

test("write_memory is refused by the same cap", async () => {
  const res = parse(
    await client.callTool({
      name: "write_memory",
      arguments: {
        write: {
          datasetId: "knowledge",
          name: "knowledge-oversize-wm.md",
          text: OVERSIZE,
          metadata: { atom_type: "reference", area: "sizeprobe" },
        },
      },
    }),
  );
  assert.equal(res.error, "inline-body-too-large");
  assert.equal(leafExists(ws.dataDir, "knowledge-oversize-wm.md"), false);
});

test("a body just UNDER the cap is accepted (the bound is not off-by-orders)", async () => {
  const text = bodyOfBytes(DEFAULT_CAP - 4_000, "sizeprobeok");
  assert.ok(
    Buffer.byteLength(text, "utf8") < DEFAULT_CAP,
    "fixture stays under the cap after padding",
  );
  const res = parse(
    await client.callTool({
      name: "save_to_dataset",
      arguments: {
        write: {
          dataset: "knowledge",
          name: "knowledge-undersize.md",
          text,
          metadata: { atom_type: "reference", area: "sizeprobe" },
        },
      },
    }),
  );
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 300));
});

test("absorb_document is EXEMPT: the same oversized body is stored VERBATIM", async () => {
  const res = await client.callTool({
    name: "absorb_document",
    arguments: {
      target: "brain",
      write: { text: OVERSIZE, name: "absorbed-oversize.md", category: "knowledge" },
    },
  });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const out = parse(res);
  assert.equal(out.ok, true, "absorb bypasses runWriteGates by design");
  const stored = fs.readFileSync(
    path.join(ws.dataDir, "wiki", ...out.created.document.id.split("/")),
    "utf8",
  );
  assert.ok(
    stored.includes(OVERSIZE.trim()),
    "the whole document survived — the cap is at the write-gate, not in saveDocument",
  );
});

test("CONSENT refuses BEFORE size: an oversized GATED write with no consent is a gate refusal", async () => {
  const res = parse(
    await client.callTool({
      name: "save_to_dataset",
      arguments: {
        write: {
          dataset: "self_improvement",
          name: "si-oversize.md",
          text: OVERSIZE,
          metadata: { area: "sizeprobe", task_type: "implementation" },
        },
      },
    }),
  );
  assert.equal(
    res.error,
    "write-gate-refused",
    "consent stays first (C8) — reordering the gates fails this test",
  );
});

const capOff = makeWorkspace("gate:\n  maxInlineBodyBytes: 0\n");
let capOffClient;

before(async () => {
  capOffClient = await connect(capOff.env, capOff.dataDir);
});

after(async () => {
  try {
    await capOffClient?.close();
  } catch {
    /* ignore */
  }
  rmDir(capOff.dataDir);
});

test("maxInlineBodyBytes: 0 means unlimited", async () => {
  const res = parse(
    await capOffClient.callTool({
      name: "save_to_dataset",
      arguments: {
        write: {
          dataset: "knowledge",
          name: "knowledge-uncapped.md",
          text: OVERSIZE,
          metadata: { atom_type: "reference", area: "sizeprobe" },
        },
      },
    }),
  );
  assert.equal(res.ok, true, `0 disables the bound entirely: ${JSON.stringify(res).slice(0, 200)}`);
});

const consentOff = makeWorkspace("gate:\n  enabled: false\n");
let consentOffClient;

before(async () => {
  consentOffClient = await connect(consentOff.env, consentOff.dataDir);
});

after(async () => {
  try {
    await consentOffClient?.close();
  } catch {
    /* ignore */
  }
  rmDir(consentOff.dataDir);
});

test("the cap is INDEPENDENT of gate.enabled (consent off, size still enforced)", async () => {
  const res = parse(
    await consentOffClient.callTool({
      name: "save_to_dataset",
      arguments: {
        write: {
          dataset: "knowledge",
          name: "knowledge-oversize-gateoff.md",
          text: OVERSIZE,
          metadata: { atom_type: "reference", area: "sizeprobe" },
        },
      },
    }),
  );
  assert.equal(
    res.error,
    "inline-body-too-large",
    "gate.enabled governs CONSENT only; the size bound is a separate axis",
  );
});

const judgeOn = makeWorkspace("quality:\n  judgeEnabled: true\nproviders:\n  chain: []\n");
let judgeOnClient;

before(async () => {
  judgeOnClient = await connect(judgeOn.env, judgeOn.dataDir);
});

after(async () => {
  try {
    await judgeOnClient?.close();
  } catch {
    /* ignore */
  }
  rmDir(judgeOn.dataDir);
});

test("SIZE refuses BEFORE the judge: no provider round-trip is burned on a doomed body", async () => {
  // knowledge is judgeable and no provider is reachable, so the judge would
  // fail-closed with `quality-judge-unavailable`. Getting the size refusal
  // instead proves we never reached it. Reordering these two fails this test.
  const res = parse(
    await judgeOnClient.callTool({
      name: "save_to_dataset",
      arguments: {
        write: {
          dataset: "knowledge",
          name: "knowledge-oversize-judge.md",
          text: OVERSIZE,
          metadata: { atom_type: "reference", area: "sizeprobe" },
        },
      },
    }),
  );
  assert.equal(res.error, "inline-body-too-large", `judge was consulted first: ${res.error}`);
});
